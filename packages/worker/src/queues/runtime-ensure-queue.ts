import { Worker, type Job } from 'bullmq';
import { eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import {
  QUEUE_NAMES,
  RUNTIME_ENSURE_JOB_NAMES,
  logger,
  type RuntimeEnsurePayload,
  type RuntimeEnsureResult,
} from '@haive/shared';
import { getDb } from '../db.js';
import { getBullRedis } from '../redis.js';
import {
  ensureAppServing,
  type AppRuntimeCtx,
} from '../step-engine/steps/workflow/_app-runtime.js';
import { startBrowserDesktop as startDdevBrowserDesktop } from '../sandbox/ddev-runner.js';
import { startBrowserDesktop as startAppBrowserDesktop } from '../sandbox/app-runner.js';

// The worker side of the VNC "ensure runtime" handshake. The api enqueues a job
// here when the live Browser panel opens; the worker brings the task's app +
// headed-browser desktop up (the api cannot — spawning task containers is
// worker-only) and returns once the desktop is reachable, so the api's VNC bridge
// connects to a live desktop instead of silently tearing down a dead one.

const log = logger.child({ module: 'runtime-ensure' });

/** Ensure the task's app is serving and its headed-browser desktop is up. Reads
 *  the task's repo path the same way the task worker builds a step context, then
 *  delegates to the shared ensureAppServing primitive. Idempotent. */
export async function ensureRuntimeForTask(taskId: string): Promise<RuntimeEnsureResult> {
  const db = getDb();
  const task = await db.query.tasks.findFirst({
    where: eq(schema.tasks.id, taskId),
    columns: { repositoryId: true },
  });
  if (!task?.repositoryId) return { ok: false, url: null, mode: 'none' };
  const repo = await db.query.repositories.findFirst({
    where: eq(schema.repositories.id, task.repositoryId),
    columns: { storagePath: true, localPath: true },
  });
  const repoPath = repo?.storagePath ?? repo?.localPath ?? null;
  if (!repoPath) return { ok: false, url: null, mode: 'none' };

  const ctx: AppRuntimeCtx = { db, taskId, repoPath, logger: log };
  const runtime = await ensureAppServing(ctx);
  // Bring up the headed-browser desktop the VNC bridge attaches to (mirrors 08a).
  if (runtime.mode === 'ddev') await startDdevBrowserDesktop(runtime.handle);
  else if (runtime.mode === 'app-runner') await startAppBrowserDesktop(runtime.handle);
  return { ok: runtime.mode !== 'none', url: runtime.url, mode: runtime.mode };
}

export function startRuntimeEnsureWorker(): Worker<RuntimeEnsurePayload, RuntimeEnsureResult> {
  const worker = new Worker<RuntimeEnsurePayload, RuntimeEnsureResult>(
    QUEUE_NAMES.RUNTIME_ENSURE,
    async (job: Job<RuntimeEnsurePayload>) => {
      if (job.name !== RUNTIME_ENSURE_JOB_NAMES.ENSURE) {
        throw new Error(`Unknown runtime-ensure job: ${job.name}`);
      }
      return ensureRuntimeForTask(job.data.taskId);
    },
    { connection: getBullRedis(), concurrency: 3 },
  );
  worker.on('failed', (job, err) => {
    log.warn({ jobId: job?.id, taskId: job?.data?.taskId, err }, 'runtime-ensure job failed');
  });
  return worker;
}
