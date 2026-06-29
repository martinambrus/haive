import path from 'node:path';
import { execFile } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import type { FormSchema } from '@haive/shared';
import type { StepContext, StepDefinition } from '../../step-definition.js';
import { pathExists } from '../onboarding/_helpers.js';
import { resolveDdevWorkspace } from './_task-meta.js';
import { parseDdevConfig, renderDdevConfig } from '../_ddev-config.js';
import { hashDdevInputs } from '../_ddev-inputs-hash.js';
import { getTaskEnvTemplate } from '../env-replicate/_shared.js';
import { ddevExec, ddevSnapshot, ddevImportSnapshotName } from '../../../sandbox/ddev-runner.js';
import { ensureDdevWithProgress, withDdevProgress } from './_app-runtime.js';

// Boots the project's DDEV environment in a per-task nested-Docker runner and
// imports the uploaded DB dump (then deletes it). Gated on the repo actually
// having `.ddev/config.yaml` — a task that is ADDING ddev (no config yet) skips
// this and just writes the config; a later task lights the env up. See
// sandbox/ddev-runner.ts for why DDEV runs in nested Docker.

const REPO_STORAGE_ROOT = process.env.REPO_STORAGE_ROOT ?? '/var/lib/haive/repos';

const execFileAsync = promisify(execFile);

/** The repo volume is chowned to uid 1000 (the `node`/`ddev` sandbox user) so
 *  DDEV and sandboxed CLIs can write. See resolvers.ts chownRepoVolume. */
const SANDBOX_OWNER = '1000:1000';

interface DdevEnvDetect {
  ddevConfigured: boolean;
  repoSubpath: string | null;
  /** Absolute worker path to the active workspace (worktree), so apply can read
   *  the booted `.ddev/config.yaml` to record the baseline. */
  workspace: string | null;
  dbUploadId: string | null;
  dumpWorkerPath: string | null;
  dumpRunnerPath: string | null;
  /** True when the project declares DDEV (containerTool=ddev) but has no
   *  .ddev/config.yaml yet — 01c generates one from the declared deps, writes it
   *  into the worktree (the commit gate persists it), then boots. */
  needsConfig: boolean;
  /** The proposed .ddev/config.yaml shown for review; written on apply. */
  proposedConfig: string | null;
}

/** php/db snapshot of the `.ddev/config.yaml` that was actually booted, plus a
 *  content hash over the booted authored `.ddev/` input tree (not just config.yaml).
 *  07c-ddev-reconcile diffs the post-implementation inputs against this to decide
 *  between a `ddev restart` (any authored `.ddev/` input edit) and a DB migration. */
export interface DdevBaseline {
  phpVersion: string | null;
  dbType: string | null;
  dbVersion: string | null;
  configHash: string;
}

export interface DdevEnvApply {
  started: boolean;
  imported: boolean;
  skipped: boolean;
  output: string;
  /** null on the skip path AND on legacy rows written before this field — 07c
   *  treats a missing baseline as "cannot diff → skip reconcile" (safe). */
  baseline: DdevBaseline | null;
}

function ddevConfigPath(workspace: string): string {
  return path.join(workspace, '.ddev', 'config.yaml');
}

/** Read + parse the booted `.ddev/config.yaml` into a baseline. null when the
 *  workspace is unknown or the file is unreadable (caller stores null → 07c skips).
 *  `configHash` covers the whole authored `.ddev/` input tree (php ini, web-build
 *  Dockerfile, extra compose/config, …), falling back to a config.yaml-only hash on
 *  a non-git workspace — 07c recomputes the same way so both sides stay comparable. */
async function readDdevBaseline(workspace: string | null): Promise<DdevBaseline | null> {
  if (!workspace) return null;
  const text = await readFile(ddevConfigPath(workspace), 'utf8').catch(() => null);
  if (text === null) return null;
  const parsed = parseDdevConfig(text);
  return {
    phpVersion: parsed.phpVersion,
    dbType: parsed.dbType,
    dbVersion: parsed.dbVersion,
    configHash:
      (await hashDdevInputs(workspace)) ?? createHash('sha256').update(text).digest('hex'),
  };
}

/** The env-template's declared deps for this task (php/db/containerTool), or null. */
async function loadDeclaredDeps(ctx: StepContext): Promise<Record<string, unknown> | null> {
  const tpl = await getTaskEnvTemplate(ctx.db, ctx.taskId);
  return (tpl?.declaredDeps as Record<string, unknown> | null) ?? null;
}

/** The repository name (used as the DDEV project name), or null. */
async function loadRepoName(ctx: StepContext): Promise<string | null> {
  const task = await ctx.db.query.tasks.findFirst({
    where: eq(schema.tasks.id, ctx.taskId),
    columns: { repositoryId: true },
  });
  if (!task?.repositoryId) return null;
  const repo = await ctx.db.query.repositories.findFirst({
    where: eq(schema.repositories.id, task.repositoryId),
    columns: { name: true },
  });
  return repo?.name ?? null;
}

/** DDEV `webserver_type` for a project that has no config yet. A `.htaccess`
 *  (repo root or a common docroot) means the app relies on Apache rewrite
 *  handling — DDEV's apache-fpm honors .htaccess, nginx-fpm ignores it — so
 *  default the generated config to apache-fpm. null otherwise → renderDdevConfig
 *  keeps DDEV's nginx-fpm default. Always overridable in the config-review form. */
const APACHE_DOCROOT_CANDIDATES = ['', 'web', 'docroot', 'public', 'html'];
async function detectWebserverType(workspace: string): Promise<string | null> {
  for (const sub of APACHE_DOCROOT_CANDIDATES) {
    if (await pathExists(path.join(workspace, sub, '.htaccess'))) return 'apache-fpm';
  }
  return null;
}

/** Render a `.ddev/config.yaml` from the declared deps (php/db) + repo name.
 *  `nodeInspect` adds a web_environment NODE_OPTIONS so a Node process under DDEV is
 *  debuggable (Lane C1) — only set when the task opted into debug AND node is declared. */
async function buildProposedConfig(
  ctx: StepContext,
  deps: Record<string, unknown>,
  webserverType: string | null,
  nodeInspect: boolean,
): Promise<string> {
  const versions = (deps.versions as Record<string, string | null> | undefined) ?? {};
  const database = (deps.database as { kind?: string; version?: string | null } | undefined) ?? {};
  const repoName = await loadRepoName(ctx);
  return renderDdevConfig({
    name: repoName ?? 'app',
    phpVersion: versions.php ?? null,
    dbType: database.kind ?? null,
    dbVersion: database.version ?? null,
    webserverType,
    nodeInspect,
  });
}

export const ddevEnvStep: StepDefinition<DdevEnvDetect, DdevEnvApply> = {
  metadata: {
    id: '01c-ddev-env',
    workflowType: 'workflow',
    index: 1.6,
    title: 'DDEV environment',
    description:
      "Boots the project's DDEV environment in an isolated nested-Docker runner and imports the DB dump.",
    requiresCli: false,
  },

  async shouldRun(ctx: StepContext): Promise<boolean> {
    const ws = await resolveDdevWorkspace(ctx.db, ctx.taskId, ctx.repoPath);
    if (!ws) return false;
    if (await pathExists(ddevConfigPath(ws.workspace))) return true;
    // No config yet — run only when the project declares DDEV, so we generate one.
    const deps = await loadDeclaredDeps(ctx);
    return deps?.containerTool === 'ddev';
  },

  async detect(ctx: StepContext): Promise<DdevEnvDetect> {
    // All work runs in the worktree, so the `.ddev` config + the runner project
    // dir must point there, not the repo root. See resolveDdevWorkspace.
    const ws = await resolveDdevWorkspace(ctx.db, ctx.taskId, ctx.repoPath);
    const ddevConfigured = ws ? await pathExists(ddevConfigPath(ws.workspace)) : false;
    const repoSubpath = ws?.repoSubpath ?? null;

    let needsConfig = false;
    let proposedConfig: string | null = null;
    if (!ddevConfigured) {
      const deps = await loadDeclaredDeps(ctx);
      if (deps?.containerTool === 'ddev') {
        needsConfig = true;
        // The explicit webserver choice from declare-deps wins; fall back to an
        // in-worktree .htaccess scan only for templates declared before that
        // selector existed (no deps.webserver).
        const declaredWebserver =
          deps.webserver === 'apache-fpm' || deps.webserver === 'nginx-fpm' ? deps.webserver : null;
        const webserverType =
          declaredWebserver ?? (ws ? await detectWebserverType(ws.workspace) : null);
        // Lane C1: only when this task opted into debug AND the env declares Node, so
        // a Node process under DDEV opens an inspector. PHP-only projects get no
        // web_environment entry (the common case).
        const debugTask = await ctx.db.query.tasks.findFirst({
          where: eq(schema.tasks.id, ctx.taskId),
          columns: { debugMode: true },
        });
        const nodeDeclared =
          Array.isArray(deps.runtimes) && (deps.runtimes as unknown[]).includes('node');
        const nodeInspect = Boolean(debugTask?.debugMode) && nodeDeclared;
        proposedConfig = await buildProposedConfig(ctx, deps, webserverType, nodeInspect);
      }
    }

    const task = await ctx.db.query.tasks.findFirst({
      where: eq(schema.tasks.id, ctx.taskId),
      columns: { dbUploadId: true },
    });

    let dbUploadId: string | null = null;
    let dumpWorkerPath: string | null = null;
    let dumpRunnerPath: string | null = null;
    if (task?.dbUploadId) {
      const dump = await ctx.db.query.dbUploads.findFirst({
        where: eq(schema.dbUploads.id, task.dbUploadId),
        columns: { id: true, dumpPath: true, status: true },
      });
      if (dump?.dumpPath && dump.status === 'complete') {
        dbUploadId = dump.id;
        dumpWorkerPath = dump.dumpPath;
        // The dump lives in the haive_repos volume (_uploads/...); inside the
        // runner that volume is mounted at /repos, so translate the worker path.
        if (dump.dumpPath.startsWith(REPO_STORAGE_ROOT + '/')) {
          dumpRunnerPath = '/repos' + dump.dumpPath.slice(REPO_STORAGE_ROOT.length);
        }
      }
    }

    return {
      ddevConfigured,
      repoSubpath,
      workspace: ws?.workspace ?? null,
      dbUploadId,
      dumpWorkerPath,
      dumpRunnerPath,
      needsConfig,
      proposedConfig,
    };
  },

  form(_ctx, detected): FormSchema | null {
    // Only stop for review when we're CREATING a config. An existing .ddev project
    // (or a non-ddev task) returns no form and proceeds straight to boot/skip.
    if (!detected.needsConfig || !detected.proposedConfig) return null;
    return {
      title: 'DDEV configuration',
      description:
        'This project declares DDEV but has no .ddev/config.yaml yet. Review the generated config (php/database come from your declared dependencies) — it is written into the repo and booted.',
      fields: [
        {
          type: 'textarea',
          id: 'ddevConfig',
          label: '.ddev/config.yaml',
          rows: 16,
          default: detected.proposedConfig,
          required: true,
        },
      ],
      submitLabel: 'Create DDEV config',
    };
  },

  async apply(ctx, args): Promise<DdevEnvApply> {
    const d = args.detected;
    if (!d.repoSubpath) {
      return { started: false, imported: false, skipped: true, output: 'no repo', baseline: null };
    }

    // Create DDEV for a project that declares it but has none yet: write the
    // (reviewed) .ddev/config.yaml into the worktree. The commit/push gates
    // persist it so DDEV is usable after the task finishes.
    if (d.needsConfig && d.workspace) {
      const cfg = String(args.formValues.ddevConfig ?? d.proposedConfig ?? '').trim();
      if (!cfg) throw new Error('ddev config cannot be empty');
      const dir = path.join(d.workspace, '.ddev');
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, 'config.yaml'), cfg.endsWith('\n') ? cfg : `${cfg}\n`, 'utf8');
      await ctx.emitProgress('Generated .ddev/config.yaml from declared dependencies');
    } else if (!d.ddevConfigured) {
      return {
        started: false,
        imported: false,
        skipped: true,
        output: 'no .ddev config',
        baseline: null,
      };
    }

    // The worktree was created by the worker as root, but DDEV runs as the `ddev`
    // user (uid 1000, matching the repo volume's chowned ownership). Without this,
    // `ddev start` fails with "permission denied" creating .ddev/.webimageBuild in
    // the worktree. chown the worktree (incl. the .ddev we just wrote) so DDEV — and
    // its web/db containers — can write throughout the project.
    if (d.workspace) {
      await execFileAsync('chown', ['-R', SANDBOX_OWNER, d.workspace]).catch((err) => {
        ctx.logger.warn(
          { err: String(err), workspace: d.workspace },
          'ddev worktree chown to 1000:1000 failed — ddev start may hit permission denied',
        );
      });
    }

    await ctx.emitProgress('Starting DDEV environment (nested Docker)…');
    const handle = await ensureDdevWithProgress(ctx, d.repoSubpath);

    let imported = false;
    if (d.dumpRunnerPath && d.dbUploadId) {
      const imp = await withDdevProgress(ctx, 'Importing database dump…', (onLine) =>
        ddevExec(handle, `import-db --file=${d.dumpRunnerPath}`, {
          timeoutMs: 1_800_000,
          onLine,
        }),
      );
      if (imp.exitCode !== 0) {
        throw new Error(`ddev import-db failed: ${imp.output.slice(-1500)}`);
      }
      imported = true;
      // Durability snapshot of the freshly-imported DB. It lives on the repo
      // volume (.ddev/.snapshots), so it survives the worker-boot reaper /
      // daemon / host restart that destroys the runner's nested DB —
      // ensureDdevStarted restores it on a cold boot. Non-fatal: the import
      // already succeeded, and a prior attempt's snapshot may already exist.
      const snap = await withDdevProgress(ctx, 'Snapshotting the imported database…', (onLine) =>
        ddevSnapshot(handle, ddevImportSnapshotName(ctx.taskId), { onLine }),
      );
      if (snap.exitCode !== 0) {
        ctx.logger.warn(
          { taskId: ctx.taskId, output: snap.output.slice(-500) },
          'ddev import snapshot non-zero (continuing)',
        );
      }
      // Delete the dump immediately + mark the upload consumed (the env now holds it).
      if (d.dumpWorkerPath) await rm(d.dumpWorkerPath, { force: true }).catch(() => {});
      await ctx.db
        .update(schema.dbUploads)
        .set({ status: 'consumed', updatedAt: new Date() })
        .where(eq(schema.dbUploads.id, d.dbUploadId));
    }

    const baseline = await readDdevBaseline(d.workspace);
    ctx.logger.info({ taskId: ctx.taskId, imported, baseline }, 'ddev env ready');
    return {
      started: true,
      imported,
      skipped: false,
      output: imported ? 'DDEV started; database dump imported' : 'DDEV started',
      baseline,
    };
  },
};
