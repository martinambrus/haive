import { Worker, type Job } from 'bullmq';
import {
  CONFIG_KEYS,
  IDE_ENSURE_JOB_NAMES,
  QUEUE_NAMES,
  configService,
  logger,
  type IdeEnsurePayload,
  type IdeEnsureResult,
} from '@haive/shared';
import { getDb } from '../db.js';
import { getBullRedis } from '../redis.js';
import { ensureIdeRunnerStarted } from '../sandbox/ide-runner.js';
import { resolveIdeSettingsJson } from '../sandbox/ide-settings.js';

// The worker side of the Editor-tab "ensure IDE" handshake. The api enqueues a job
// here when the user opens the editor; the worker lazily launches the task's
// code-server container (the api cannot — spawning task containers is worker-only)
// and returns once it is up. jobId-coalesced per task so rapid reopens share one
// boot. Mirrors runtime-ensure-queue.

const log = logger.child({ module: 'ide-ensure' });

/** Ensure the task's IDE container is up. Honors the global kill-switch and
 *  reports a reason when the IDE can't start (disabled, or no editable repo).
 *  Idempotent. */
export async function ensureIdeForTask(taskId: string, userId: string): Promise<IdeEnsureResult> {
  const enabled = await configService.getBoolean(CONFIG_KEYS.IDE_ENABLED, true);
  if (!enabled) return { ok: false, reason: 'disabled' };
  const db = getDb();
  const settingsJson = await resolveIdeSettingsJson(db, userId);
  const handle = await ensureIdeRunnerStarted(db, taskId, userId, settingsJson);
  if (!handle) return { ok: false, reason: 'no-editable-repo' };
  return { ok: true };
}

export function startIdeEnsureWorker(): Worker<IdeEnsurePayload, IdeEnsureResult> {
  const worker = new Worker<IdeEnsurePayload, IdeEnsureResult>(
    QUEUE_NAMES.IDE_ENSURE,
    async (job: Job<IdeEnsurePayload>) => {
      if (job.name !== IDE_ENSURE_JOB_NAMES.ENSURE) {
        throw new Error(`Unknown ide-ensure job: ${job.name}`);
      }
      return ensureIdeForTask(job.data.taskId, job.data.userId);
    },
    { connection: getBullRedis(), concurrency: 3 },
  );
  worker.on('failed', (job, err) => {
    log.warn({ jobId: job?.id, taskId: job?.data?.taskId, err }, 'ide-ensure job failed');
  });
  return worker;
}
