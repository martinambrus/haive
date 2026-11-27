import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { logger, REPO_JOB_NAMES } from '@haive/shared';

const h = vi.hoisted(() => ({
  db: undefined as unknown,
  processor: undefined as ((job: unknown) => Promise<unknown>) | undefined,
  prepare: vi.fn(),
  imports: vi.fn(),
}));
vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/redis.js', () => ({ getBullRedis: () => ({}) }));
vi.mock('bullmq', async (original) => ({
  ...(await original<typeof import('bullmq')>()),
  Worker: class {
    constructor(_name: string, processor: (job: unknown) => Promise<unknown>) {
      h.processor = processor;
    }
    on() {}
  },
}));
vi.mock('../src/repo/clone.js', () => ({
  handleClone: h.prepare,
  handleCopyLocal: h.prepare,
  handleExtract: h.prepare,
  handleInit: h.prepare,
  handleScan: h.prepare,
  completePreparationImports: h.imports,
}));
import { startRepoWorker } from '../src/queues/repo-queue.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

it.each([REPO_JOB_NAMES.CLONE, REPO_JOB_NAMES.COPY, REPO_JOB_NAMES.INIT, REPO_JOB_NAMES.EXTRACT])(
  '%s preserves the ready result and user edits when completion cleanup fails once',
  async (name) => {
    const fake = createFakeDb({ repositories: schema.repositories });
    const repositoryId = randomUUID();
    const jobId = randomUUID();
    const storagePath = '/fixture/checkout';
    fake.insert(schema.repositories, {
      id: repositoryId,
      status: 'cloning',
      refreshPending: true,
      refreshJobId: jobId,
    });
    h.db = fake.db;
    // Model the handler's replacement at its seam. Re-entering it destroys these edits,
    // so this control fails on both the wrong status and the consequential retry path.
    const checkout = new Map<string, string>();
    h.prepare.mockImplementation(async () => {
      checkout.clear();
      checkout.set('source.txt', 'prepared source');
      fake.patch(schema.repositories, repositoryId, {
        status: 'ready',
        storagePath,
        detectedFramework: 'node',
        statusMessage: 'ready with a caveat',
        errorCode: null,
      });
    });
    const cleanupError = new Error('completion cleanup failed once');
    const cleanup = vi.fn().mockRejectedValueOnce(cleanupError).mockResolvedValue(undefined);
    fake.hooks.beforeUpdate = async () => cleanup();
    vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    startRepoWorker('/fixture');
    const job = {
      id: jobId,
      name,
      data: { repositoryId, userId: 'fixture-user' },
      attemptsMade: 0,
      opts: { attempts: 3 },
    };

    await expect(h.processor!(job)).rejects.toThrow(cleanupError.message);
    const ready = {
      status: 'ready',
      statusMessage: 'ready with a caveat',
      detectedFramework: 'node',
      errorCode: null,
    };
    expect.soft(fake.rows(schema.repositories)[0]).toMatchObject({
      ...ready,
      refreshPending: true,
      refreshJobId: jobId,
    });
    checkout.set('user-edit.txt', 'saved during backoff');

    await h.processor!({ ...job, attemptsMade: 1 });

    expect.soft(h.prepare).toHaveBeenCalledTimes(1);
    expect.soft(checkout.get('user-edit.txt')).toBe('saved during backoff');
    expect.soft(h.imports).toHaveBeenCalledExactlyOnceWith(fake.db, repositoryId, storagePath);
    expect.soft(cleanup).toHaveBeenCalledTimes(2);
    expect(fake.rows(schema.repositories)[0]).toMatchObject({
      ...ready,
      refreshPending: false,
      refreshJobId: null,
    });
  },
);

it.each([1, 3])(
  'claim contention delays even the last of %i allowed attempts without changing ready',
  async (attempts) => {
    const { RootClaimBusyError } = await import('../src/repo/root-claim-busy.js');
    const { DelayedError } = await import('bullmq');
    const fake = createFakeDb({ repositories: schema.repositories });
    const repositoryId = randomUUID();
    const jobId = randomUUID();
    fake.insert(schema.repositories, {
      id: repositoryId,
      status: 'ready',
      refreshPending: true,
      refreshJobId: jobId,
    });
    h.db = fake.db;
    h.prepare
      .mockRejectedValueOnce(new RootClaimBusyError('mutation'))
      .mockResolvedValueOnce(undefined);
    startRepoWorker('/fixture');
    const moveToDelayed = vi.fn().mockResolvedValue(undefined);
    const job = {
      id: jobId,
      name: REPO_JOB_NAMES.SCAN,
      data: { repositoryId, userId: 'fixture-user' },
      opts: { attempts },
      attemptsMade: attempts - 1,
      moveToDelayed,
    };
    await expect(h.processor!(job)).rejects.toBeInstanceOf(DelayedError);
    expect(moveToDelayed).toHaveBeenCalledOnce();
    expect(fake.rows(schema.repositories)[0]).toMatchObject({
      status: 'ready',
      refreshPending: true,
      refreshJobId: jobId,
    });
    await h.processor!(job);
    expect(fake.rows(schema.repositories)[0]).toMatchObject({
      status: 'ready',
      refreshPending: false,
      refreshJobId: null,
    });
  },
);
