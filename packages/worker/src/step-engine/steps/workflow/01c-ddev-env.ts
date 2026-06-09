import path from 'node:path';
import { rm } from 'node:fs/promises';
import { eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import type { StepContext, StepDefinition } from '../../step-definition.js';
import { pathExists } from '../onboarding/_helpers.js';
import { startDdevRunner, ddevExec } from '../../../sandbox/ddev-runner.js';

// Boots the project's DDEV environment in a per-task nested-Docker runner and
// imports the uploaded DB dump (then deletes it). Gated on the repo actually
// having `.ddev/config.yaml` — a task that is ADDING ddev (no config yet) skips
// this and just writes the config; a later task lights the env up. See
// sandbox/ddev-runner.ts for why DDEV runs in nested Docker.

const REPO_STORAGE_ROOT = process.env.REPO_STORAGE_ROOT ?? '/var/lib/haive/repos';

interface DdevEnvDetect {
  ddevConfigured: boolean;
  repoSubpath: string | null;
  dbUploadId: string | null;
  dumpWorkerPath: string | null;
  dumpRunnerPath: string | null;
}

interface DdevEnvApply {
  started: boolean;
  imported: boolean;
  skipped: boolean;
  output: string;
}

function ddevConfigPath(workspace: string): string {
  return path.join(workspace, '.ddev', 'config.yaml');
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
    return pathExists(ddevConfigPath(ctx.workspacePath));
  },

  async detect(ctx: StepContext): Promise<DdevEnvDetect> {
    const ddevConfigured = await pathExists(ddevConfigPath(ctx.workspacePath));

    const task = await ctx.db.query.tasks.findFirst({
      where: eq(schema.tasks.id, ctx.taskId),
      columns: { userId: true, repositoryId: true, dbUploadId: true },
    });

    const repoSubpath = task?.repositoryId ? `${task.userId}/${task.repositoryId}` : null;

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

    return { ddevConfigured, repoSubpath, dbUploadId, dumpWorkerPath, dumpRunnerPath };
  },

  async apply(ctx, args): Promise<DdevEnvApply> {
    const d = args.detected;
    if (!d.ddevConfigured || !d.repoSubpath) {
      return { started: false, imported: false, skipped: true, output: 'no .ddev config or repo' };
    }

    await ctx.emitProgress('Starting DDEV environment (nested Docker)…');
    const handle = await startDdevRunner({ taskId: ctx.taskId, repoSubpath: d.repoSubpath });

    const start = await ddevExec(handle, 'start', { timeoutMs: 900_000 });
    if (start.exitCode !== 0) {
      throw new Error(`ddev start failed: ${start.output.slice(-1500)}`);
    }

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

    ctx.logger.info({ taskId: ctx.taskId, imported }, 'ddev env ready');
    return { started: true, imported, skipped: false, output: start.output.slice(-1000) };
  },
};
