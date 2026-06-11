import path from 'node:path';
import { readFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import type { StepContext, StepDefinition } from '../../step-definition.js';
import { pathExists } from '../onboarding/_helpers.js';
import { resolveDdevWorkspace } from './_task-meta.js';
import { parseDdevConfig } from '../_ddev-config.js';
import { ensureDdevStarted, ddevExec } from '../../../sandbox/ddev-runner.js';

// Boots the project's DDEV environment in a per-task nested-Docker runner and
// imports the uploaded DB dump (then deletes it). Gated on the repo actually
// having `.ddev/config.yaml` — a task that is ADDING ddev (no config yet) skips
// this and just writes the config; a later task lights the env up. See
// sandbox/ddev-runner.ts for why DDEV runs in nested Docker.

const REPO_STORAGE_ROOT = process.env.REPO_STORAGE_ROOT ?? '/var/lib/haive/repos';

interface DdevEnvDetect {
  ddevConfigured: boolean;
  repoSubpath: string | null;
  /** Absolute worker path to the active workspace (worktree), so apply can read
   *  the booted `.ddev/config.yaml` to record the baseline. */
  workspace: string | null;
  dbUploadId: string | null;
  dumpWorkerPath: string | null;
  dumpRunnerPath: string | null;
}

/** php/db snapshot of the `.ddev/config.yaml` that was actually booted, plus a
 *  content hash. 07c-ddev-reconcile diffs the post-implementation config against
 *  this to decide between a `ddev restart` (php change) and a DB migration. */
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
 *  workspace is unknown or the file is unreadable (caller stores null → 07c skips). */
async function readDdevBaseline(workspace: string | null): Promise<DdevBaseline | null> {
  if (!workspace) return null;
  const text = await readFile(ddevConfigPath(workspace), 'utf8').catch(() => null);
  if (text === null) return null;
  const parsed = parseDdevConfig(text);
  return {
    phpVersion: parsed.phpVersion,
    dbType: parsed.dbType,
    dbVersion: parsed.dbVersion,
    configHash: createHash('sha256').update(text).digest('hex'),
  };
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
    return ws ? pathExists(ddevConfigPath(ws.workspace)) : false;
  },

  async detect(ctx: StepContext): Promise<DdevEnvDetect> {
    // All work runs in the worktree, so the `.ddev` config + the runner project
    // dir must point there, not the repo root. See resolveDdevWorkspace.
    const ws = await resolveDdevWorkspace(ctx.db, ctx.taskId, ctx.repoPath);
    const ddevConfigured = ws ? await pathExists(ddevConfigPath(ws.workspace)) : false;
    const repoSubpath = ws?.repoSubpath ?? null;

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
    };
  },

  async apply(ctx, args): Promise<DdevEnvApply> {
    const d = args.detected;
    if (!d.ddevConfigured || !d.repoSubpath) {
      return {
        started: false,
        imported: false,
        skipped: true,
        output: 'no .ddev config or repo',
        baseline: null,
      };
    }

    await ctx.emitProgress('Starting DDEV environment (nested Docker)…');
    const handle = await ensureDdevStarted(ctx.taskId, d.repoSubpath);

    let imported = false;
    if (d.dumpRunnerPath && d.dbUploadId) {
      await ctx.emitProgress('Importing database dump…');
      const imp = await ddevExec(handle, `import-db --file=${d.dumpRunnerPath}`, {
        timeoutMs: 1_800_000,
      });
      if (imp.exitCode !== 0) {
        throw new Error(`ddev import-db failed: ${imp.output.slice(-1500)}`);
      }
      imported = true;
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
