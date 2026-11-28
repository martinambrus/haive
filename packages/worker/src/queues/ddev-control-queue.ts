import { CheckoutUnavailableError } from '@haive/shared/checkout-access';
import { safeErrorMessage } from '@haive/shared/logger';
import { safeProcessor } from './safe-processor.js';
import { Worker, type Job } from 'bullmq';
import { eq } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import {
  QUEUE_NAMES,
  DDEV_CONTROL_JOB_NAMES,
  logger,
  type DdevControlPayload,
  type DdevControlResult,
} from '@haive/shared';
import { getDb } from '../db.js';
import { getBullRedis } from '../redis.js';
import { withInteractiveCheckout } from '../repo/interactive-checkout.js';
import { resolveDdevWorkspace } from '../step-engine/steps/workflow/_task-meta.js';
import { ddevExec, runnerHandleForTask, ensureDdevStarted } from '../sandbox/ddev-runner.js';

// Worker side of the ddev-control MCP. The api enqueues a job here when a task's AI
// CLI calls ddev_status / ddev_logs / ddev_restart; the worker resolves the per-task
// DDEV runner handle and runs the matching `ddev` command via ddevExec — the api can't
// (docker access is worker-only), mirroring the runtime-ensure handshake.

const log = logger.child({ module: 'ddev-control' });

/** Resolve the task's repository and its path the same way ensureRuntimeForTask does. */
async function resolveTaskRepo(
  db: Database,
  taskId: string,
): Promise<{ repositoryId: string; repoPath: string } | null> {
  const task = await db.query.tasks.findFirst({
    where: eq(schema.tasks.id, taskId),
    columns: { repositoryId: true },
  });
  if (!task?.repositoryId) return null;
  const repo = await db.query.repositories.findFirst({
    where: eq(schema.repositories.id, task.repositoryId),
    columns: { storagePath: true, localPath: true },
  });
  const repoPath = repo?.storagePath ?? repo?.localPath ?? null;
  return repoPath ? { repositoryId: task.repositoryId, repoPath } : null;
}

/** Run one ddev-control action against the task's runner. Read actions (status/logs)
 *  use a handle to the already-running runner (no boot); restart recovers a gone/down
 *  runner first (ensureDdevStarted) then forces `ddev restart`. Never throws — a
 *  failure is returned as { ok:false, error } so the api relays it to the agent. */
export async function runDdevControl(payload: DdevControlPayload): Promise<DdevControlResult> {
  const db = getDb();
  const repo = await resolveTaskRepo(db, payload.taskId);
  if (!repo) return { ok: false, output: '', error: 'no repo path for task' };
  const ws = await resolveDdevWorkspace(db, payload.taskId, repo.repoPath);
  if (!ws) return { ok: false, output: '', error: 'no DDEV workspace for task' };
  const handle = runnerHandleForTask(payload.taskId, ws.repoSubpath);

  try {
    if (payload.action === 'status') {
      const r = await ddevExec(handle, 'describe -j', { timeoutMs: 30_000 });
      return {
        ok: r.exitCode === 0,
        output: r.output,
        ...(r.exitCode === 0 ? {} : { error: 'ddev describe failed (is the runner up?)' }),
      };
    }
    if (payload.action === 'logs') {
      // Only allow a safe service token; default to the web service.
      const svc =
        typeof payload.service === 'string' && /^[a-z0-9_-]+$/i.test(payload.service)
          ? ` -s ${payload.service}`
          : '';
      const r = await ddevExec(handle, `logs${svc}`, { timeoutMs: 120_000 });
      const tail =
        typeof payload.tail === 'number' && payload.tail > 0 ? Math.min(payload.tail, 2000) : 200;
      const output = r.output.split('\n').slice(-tail).join('\n');
      return {
        ok: r.exitCode === 0,
        output,
        ...(r.exitCode === 0 ? {} : { error: 'ddev logs failed (is the runner up?)' }),
      };
    }
    if (payload.action === 'restart') {
      // The only action that opens the checkout (the exec, and the cold boot below), so it is
      // admitted like every other root-backed open. A rebuild commits `cloning` before it drains
      // and the process fence is lost with the worker, so the row is what has to be read.
      // status/logs only exec into a runner that already exists and stay ungated.
      return await withInteractiveCheckout(db, repo.repositoryId, async (check) => {
        // Fast path: restart in place (works whether the project is serving, wedged, or
        // stopped). If the runner CONTAINER is gone, `ddev restart` fails fast (docker exec
        // on a missing container errors immediately) — recover it with a full cold boot.
        // Avoids the redundant cold-boot-then-restart of doing ensureDdevStarted first.
        const r = await ddevExec(handle, 'restart', {
          timeoutMs: 900_000,
          onLine: (line) => log.debug({ taskId: payload.taskId }, line),
        });
        if (r.exitCode === 0) return { ok: true, output: r.output };
        log.info({ taskId: payload.taskId }, 'ddev restart failed; recovering via cold boot');
        // The failure may be the rebuild having removed the runner: do not boot a new one onto it.
        await check();
        await ensureDdevStarted(payload.taskId, ws.repoSubpath, {
          onProgress: (line) => log.debug({ taskId: payload.taskId }, line),
        });
        return {
          ok: true,
          output: `${r.output}\n[runner was down; recovered via cold boot]`.slice(-8000),
        };
      });
    }
    return { ok: false, output: '', error: `unknown action: ${String(payload.action)}` };
  } catch (err) {
    if (err instanceof CheckoutUnavailableError) {
      // The MCP shim shows the agent only `output`, so the refusal text goes there too.
      return { ok: false, output: err.message, error: err.message };
    }
    const message = safeErrorMessage(err);
    log.warn({ taskId: payload.taskId, action: payload.action, err }, 'ddev-control failed');
    return { ok: false, output: '', error: message };
  }
}

export function startDdevControlWorker(): Worker<DdevControlPayload, DdevControlResult> {
  const worker = new Worker<DdevControlPayload, DdevControlResult>(
    QUEUE_NAMES.DDEV_CONTROL,
    safeProcessor(async (job: Job<DdevControlPayload>) => {
      if (job.name !== DDEV_CONTROL_JOB_NAMES.RUN) {
        throw new Error(`Unknown ddev-control job: ${job.name}`);
      }
      return runDdevControl(job.data);
    }),
    { connection: getBullRedis(), concurrency: 3 },
  );
  worker.on('failed', (job, err) => {
    log.warn(
      { jobId: job?.id, taskId: job?.data?.taskId, action: job?.data?.action, err },
      'ddev-control job failed',
    );
  });
  return worker;
}
