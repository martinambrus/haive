import { afterEach, expect, it, vi } from 'vitest';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { REPO_JOB_NAMES, logger } from '@haive/shared';

const h = vi.hoisted(() => ({
  db: undefined as unknown,
  processor: undefined as ((job: unknown) => Promise<unknown>) | undefined,
}));
vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/redis.js', () => ({ getBullRedis: () => ({}) }));
vi.mock('bullmq', async (original) => ({
  ...(await original<typeof import('bullmq')>()),
  Worker: class {
    constructor(_name: string, processor: (job: unknown) => Promise<unknown>) {
      h.processor = processor;
    }
    on() {
      return this;
    }
  },
}));
vi.mock('../src/repo/clone.js', () => ({
  handleClone: async () => {
    throw new Error("EACCES: mkdir '/srv/private/repo'");
  },
  handleCopyLocal: vi.fn(),
  handleExtract: vi.fn(),
  handleInit: vi.fn(),
  handleScan: vi.fn(),
}));
import { startRepoWorker } from '../src/queues/repo-queue.js';

afterEach(() => vi.restoreAllMocks());
it('stores a repository failure without the server path and rethrows the original error', async () => {
  const fake = createFakeDb({ repositories: schema.repositories });
  const id = '00000000-0000-4000-8000-000000000001';
  fake.insert(schema.repositories, {
    id,
    status: 'cloning',
    refreshPending: true,
    refreshJobId: 'error-path-job',
  });
  h.db = fake.db;
  vi.spyOn(logger, 'error').mockImplementation(() => undefined);
  startRepoWorker('/unused');
  await expect(
    h.processor!({ id: 'error-path-job', name: REPO_JOB_NAMES.CLONE, data: { repositoryId: id } }),
  ).rejects.toThrow("EACCES: mkdir '/srv/private/repo'");
  expect(fake.rows(schema.repositories)[0]).toMatchObject({
    status: 'error',
    statusMessage: "EACCES: mkdir '[path]'",
  });
});

it.each([
  ['no_owner_on_row', null, false],
  ['different_owner', 'new-job', true],
  ['not_pending', 'refused-job', false],
] as const)(
  'warns with structural refusal reason %s and leaves the row untouched',
  async (reason, owner, pending) => {
    const fake = createFakeDb({ repositories: schema.repositories });
    const id = '00000000-0000-4000-8000-000000000001';
    fake.insert(schema.repositories, {
      id,
      status: 'ready',
      refreshJobId: owner,
      refreshPending: pending,
      statusMessage: 'arbitrary copy that cannot determine ownership',
    });
    h.db = fake.db;
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const before = structuredClone(fake.rows(schema.repositories));
    startRepoWorker('/unused');
    await h.processor!({
      id: 'refused-job',
      name: REPO_JOB_NAMES.CLONE,
      data: { repositoryId: id },
    });
    expect(warn).toHaveBeenCalledWith(
      { repositoryId: id, jobId: 'refused-job', reason },
      'Obsolete or ownerless repository job refused',
    );
    expect(fake.rows(schema.repositories)).toEqual(before);
  },
);
