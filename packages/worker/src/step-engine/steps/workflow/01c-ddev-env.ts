import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { schema, initializeTaskDatabaseState } from '@haive/database';
import type { FormSchema } from '@haive/shared';
import {
  applyTreeNoFollow,
  lstatNoFollow,
  readTextNoFollow,
  relUnder,
  writeFileNoFollow,
} from '@haive/shared/fs-safe';
import { SANDBOX_GID, SANDBOX_UID } from '../../../sandbox/sandbox-identity.js';
import { workspaceAnchor } from '../../../repo/worktree-paths.js';
import type { StepContext, StepDefinition } from '../../step-definition.js';
import { resolveDdevWorkspace } from './_task-meta.js';
import { parseDdevConfig, renderDdevConfig } from '../_ddev-config.js';
import { hashDdevInputs } from '../_ddev-inputs-hash.js';
import { getTaskEnvTemplate } from '../env-replicate/_shared.js';
import { ensureDdevWithProgress } from './_app-runtime.js';

// Boots the project's DDEV environment in a per-task nested-Docker runner.
// Projects declaring DDEV can review a generated config when none exists.
// Database restoration runs in the following step. See sandbox/ddev-runner.ts
// for why DDEV runs in nested Docker.

/** The repo volume is chowned to uid 1000 (the `node`/`ddev` sandbox user) so
 *  DDEV and sandboxed CLIs can write. See resolvers.ts chownRepoVolume. */

interface DdevEnvDetect {
  ddevConfigured: boolean;
  repoSubpath: string | null;
  /** Absolute worker path to the active workspace (worktree), so apply can read
   *  the booted `.ddev/config.yaml` to record the baseline. */
  workspace: string | null;
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

/** The project's `.ddev/config.yaml`, split for the anchored walk.
 *
 *  The workspace is a WORKTREE (see resolveDdevWorkspace), which sits under `.haive/` — the tree
 *  the sandbox mounts read-write — so it can never be the anchor itself. `workspaceAnchor` returns
 *  the repository root plus the worktree prefix, and falls back to the path itself in root mode. */
function ddevConfigRef(workspace: string): { anchor: string; rel: string } {
  const { anchor, prefix } = workspaceAnchor(workspace);
  return { anchor, rel: `${prefix}.ddev/config.yaml` };
}

/** Whether the project has a real `.ddev/config.yaml`.
 *
 *  `pathExists` was `stat`-based, so it followed a link and read a dangling one as absent. A linked
 *  config now reads as ABSENT, which routes the step to "no config yet" rather than booting DDEV
 *  against a file outside the tree — and 01c never rewrites an existing config, so the honest
 *  answer is the safe one. */
async function ddevConfigExists(workspace: string): Promise<boolean> {
  const { anchor, rel } = ddevConfigRef(workspace);
  return (await lstatNoFollow(anchor, rel))?.kind === 'file';
}

/** Read + parse the booted `.ddev/config.yaml` into a baseline. null when the
 *  workspace is unknown or the file is unreadable (caller stores null → 07c skips).
 *  `configHash` covers the whole authored `.ddev/` input tree (php ini, web-build
 *  Dockerfile, extra compose/config, …), falling back to a config.yaml-only hash on
 *  a non-git workspace — 07c recomputes the same way so both sides stay comparable. */
async function readDdevBaseline(workspace: string | null): Promise<DdevBaseline | null> {
  if (!workspace) return null;
  const { anchor, rel } = ddevConfigRef(workspace);
  // Lenient: `null` covers absent, unreadable and refused alike, and the documented contract for
  // all three is the same — the caller stores null and 07c skips the reconcile.
  const text = await readTextNoFollow(anchor, rel);
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
  const { anchor, prefix } = workspaceAnchor(workspace);
  for (const sub of APACHE_DOCROOT_CANDIDATES) {
    const rel = sub === '' ? `${prefix}.htaccess` : `${prefix}${sub}/.htaccess`;
    if ((await lstatNoFollow(anchor, rel))?.kind === 'file') return 'apache-fpm';
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
  const nodeDeclared =
    Array.isArray(deps.runtimes) && (deps.runtimes as unknown[]).includes('node');
  const repoName = await loadRepoName(ctx);
  return renderDdevConfig({
    name: repoName ?? 'app',
    phpVersion: versions.php ?? null,
    // 01-env-detect has always READ nodejs_version out of an existing config; nothing wrote
    // it, so a generated config left DDEV on its own default and the declared Node version
    // reached the CLI sandbox image but not the app runtime. Only a config Haive GENERATES
    // is affected — an existing .ddev/config.yaml is never rewritten by this step.
    //
    // Gated on node being a DECLARED runtime, the same test nodeInspect uses: the version
    // field keeps its detected value even after the user unticks Node, and asking DDEV to
    // install a Node the project did not declare would rebuild its web image for nothing.
    nodejsVersion: nodeDeclared ? (versions.node ?? null) : null,
    dbType: database.kind ?? null,
    dbVersion: database.version ?? null,
    webserverType,
    nodeInspect,
  });
}

export const ddevEnvStep: StepDefinition<DdevEnvDetect, DdevEnvApply> = {
  needsRuntime: 'ddev',
  metadata: {
    id: '01c-ddev-env',
    workflowType: 'workflow',
    index: 1.6,
    title: 'DDEV environment',
    description:
      "Boots the project's DDEV environment in an isolated nested-Docker runner before the separate database restore step.",
    requiresCli: false,
  },

  async shouldRun(ctx: StepContext): Promise<boolean> {
    const ws = await resolveDdevWorkspace(ctx.db, ctx.taskId, ctx.repoPath);
    if (!ws) return false;
    if (await ddevConfigExists(ws.workspace)) return true;
    // No config yet — run only when the project declares DDEV, so we generate one.
    const deps = await loadDeclaredDeps(ctx);
    return deps?.containerTool === 'ddev';
  },

  async detect(ctx: StepContext): Promise<DdevEnvDetect> {
    // All work runs in the worktree, so the `.ddev` config + the runner project
    // dir must point there, not the repo root. See resolveDdevWorkspace.
    const ws = await resolveDdevWorkspace(ctx.db, ctx.taskId, ctx.repoPath);
    const ddevConfigured = ws ? await ddevConfigExists(ws.workspace) : false;
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

    // Older/internal tasks may not have creation-time snapshot state. Capture
    // their baseline at startup even when they have no database to restore.
    const task = await ctx.db.query.tasks.findFirst({
      where: eq(schema.tasks.id, ctx.taskId),
      columns: { id: true, repositoryId: true, userId: true },
    });
    if (task?.repositoryId) await initializeTaskDatabaseState(ctx.db, task);

    return {
      ddevConfigured,
      repoSubpath,
      workspace: ws?.workspace ?? null,
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
      const { anchor, rel } = ddevConfigRef(d.workspace);
      await writeFileNoFollow(anchor, rel, cfg.endsWith('\n') ? cfg : `${cfg}\n`, {
        createParents: true,
      });
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
      await applyTreeNoFollow(ctx.repoPath, relUnder(ctx.repoPath, d.workspace), {
        owner: { uid: SANDBOX_UID, gid: SANDBOX_GID },
      }).catch((err: unknown) => {
        ctx.logger.warn(
          { err: String(err), workspace: d.workspace },
          'ddev worktree chown to 1000:1000 failed — ddev start may hit permission denied',
        );
      });
    }

    await ctx.emitProgress('Starting DDEV environment (nested Docker)…');
    await ensureDdevWithProgress(ctx, d.repoSubpath);
    const imported = false;

    const baseline = await readDdevBaseline(d.workspace);
    ctx.logger.info({ taskId: ctx.taskId, imported, baseline }, 'ddev env ready');
    return {
      started: true,
      imported,
      skipped: false,
      output: 'DDEV started',
      baseline,
    };
  },
};
