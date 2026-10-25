import { randomBytes } from 'node:crypto';
import { DrizzleQueryError } from 'drizzle-orm/errors';
import { afterEach, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  error: undefined as unknown,
  processors: new Map<string, (job: unknown, token?: string) => Promise<unknown>>(),
}));
vi.mock('bullmq', async (original) => ({
  ...(await original<typeof import('bullmq')>()),
  Queue: class {},
  Worker: class {
    constructor(name: string, processor: (job: unknown) => Promise<unknown>) {
      h.processors.set(name, processor);
    }
    on() {
      return this;
    }
  },
}));
vi.mock('../src/db.js', () => ({
  getDb: () => {
    if (h.error) throw h.error;
    return {};
  },
}));
vi.mock('../src/redis.js', () => ({ getBullRedis: () => ({}), getRedis: () => ({}) }));
vi.mock('@haive/shared', async (original) => ({
  ...(await original<typeof import('@haive/shared')>()),
  configService: { getBoolean: async () => true, getNumber: async () => 1 },
}));

import {
  QUEUE_NAMES,
  CLI_EXEC_JOB_NAMES,
  PLAN_MIRROR_JOB_NAMES,
  RUNTIME_ENSURE_JOB_NAMES,
  IDE_ENSURE_JOB_NAMES,
  DDEV_CONTROL_JOB_NAMES,
  GLOBAL_KB_JOB_NAMES,
  TASK_JOB_NAMES,
  REPO_JOB_NAMES,
  BUNDLE_JOB_NAMES,
  MODULE_CONTROL_JOB_NAMES,
} from '@haive/shared';
import { startCliExecWorker } from '../src/queues/cli-exec/handlers.js';
import { startPlanMirrorWorker } from '../src/queues/plan-mirror-queue.js';
import { startModuleControlWorker } from '../src/queues/module-control-queue.js';
import { startRuntimeEnsureWorker } from '../src/queues/runtime-ensure-queue.js';
import { startIdeEnsureWorker } from '../src/queues/ide-ensure-queue.js';
import { startDdevControlWorker } from '../src/queues/ddev-control-queue.js';
import { startGlobalKbSyncWorker } from '../src/queues/global-kb-sync-queue.js';
import { startUsagePollWorker } from '../src/queues/usage-poll-queue.js';
import { startPrPollWorker } from '../src/queues/pr-poll-queue.js';
import { startRepoWorker } from '../src/queues/repo-queue.js';
import { startBundleWorker } from '../src/queues/bundle-queue.js';
import { startTaskWorker } from '../src/queues/task-queue.js';

const cases = [
  [QUEUE_NAMES.CLI_EXEC, CLI_EXEC_JOB_NAMES.PROBE, startCliExecWorker],
  [QUEUE_NAMES.CLI_EXEC, CLI_EXEC_JOB_NAMES.LOGIN_CREATE, startCliExecWorker],
  [QUEUE_NAMES.CLI_EXEC, CLI_EXEC_JOB_NAMES.REFRESH_VERSIONS, startCliExecWorker],
  [QUEUE_NAMES.CLI_EXEC, CLI_EXEC_JOB_NAMES.SIGN_OUT, startCliExecWorker],
  [QUEUE_NAMES.PLAN_MIRROR, PLAN_MIRROR_JOB_NAMES.RESOLVE_PROJECT_STATE, startPlanMirrorWorker],
  [
    QUEUE_NAMES.MODULE_CONTROL,
    MODULE_CONTROL_JOB_NAMES.TEARDOWN,
    () => startModuleControlWorker({ loaded: [], entries: [] }),
  ],
  [QUEUE_NAMES.RUNTIME_ENSURE, RUNTIME_ENSURE_JOB_NAMES.ENSURE, startRuntimeEnsureWorker],
  [QUEUE_NAMES.IDE_ENSURE, IDE_ENSURE_JOB_NAMES.ENSURE, startIdeEnsureWorker],
  [QUEUE_NAMES.DDEV_CONTROL, DDEV_CONTROL_JOB_NAMES.RUN, startDdevControlWorker],
  [QUEUE_NAMES.GLOBAL_KB_SYNC, GLOBAL_KB_JOB_NAMES.SYNC_ENTRY, startGlobalKbSyncWorker],
  [QUEUE_NAMES.USAGE_POLL, 'usage-poll-tick', startUsagePollWorker],
  [QUEUE_NAMES.PR_POLL, 'pr-poll-tick', startPrPollWorker],
  [QUEUE_NAMES.REPO, REPO_JOB_NAMES.CLONE, () => startRepoWorker('/unused')],
  [QUEUE_NAMES.BUNDLE, BUNDLE_JOB_NAMES.INGEST_ZIP, () => startBundleWorker('/unused')],
  [QUEUE_NAMES.TASK, TASK_JOB_NAMES.START, startTaskWorker],
] as const;

afterEach(() => {
  h.error = undefined;
  vi.unstubAllEnvs();
});
it.each(cases)('fix5 sanitizes %s / %s at the registered processor', async (queue, name, start) => {
  vi.stubEnv('REDIS_URL', '');
  h.error = undefined;
  await start();
  const processor = h.processors.get(queue)!;
  expect(typeof processor).toBe('function');
  const secret = randomBytes(24).toString('base64url');
  h.error = new DrizzleQueryError(
    'select $1',
    [secret],
    Object.assign(new Error(secret), { code: '23505' }),
  );
  const job = {
    id: 'queue-control',
    name,
    data: { taskId: 'task', repositoryId: 'repo', userId: 'user' },
  };
  const err = await Promise.resolve()
    .then(() => processor(job, 'token'))
    .catch((err: unknown) => err);
  expect(err instanceof Error).toBe(true);
  const text = JSON.stringify({
    failedReason: (err as Error).message,
    stacktrace: [(err as Error).stack],
  });
  expect(
    Array.from({ length: secret.length - 5 }, (_, i) => secret.slice(i, i + 6)).some((part) =>
      text.includes(part),
    ),
  ).toBe(false);
  expect((err as Error).message.includes('23505')).toBe(true);
  const ordinary = new TypeError('ordinary diagnosis\n  keep whitespace');
  h.error = ordinary;
  const unchanged = await Promise.resolve()
    .then(() => processor(job, 'token'))
    .catch((err: unknown) => err);
  expect(unchanged === ordinary).toBe(true);
});
