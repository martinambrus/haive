import type { Job } from 'bullmq';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { TASK_JOB_NAMES } from '@haive/shared';

const h = vi.hoisted(() => ({
  db: undefined as unknown,
  ragCleanup: vi.fn(async (..._args: unknown[]) => ({ dropped: [], kept: [] })),
}));

vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/step-engine/steps/onboarding/_rag-connection.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  cleanupRagForRepository: h.ragCleanup,
}));

import { processTaskJob } from '../src/queues/task-queue.js';
import {
  REPO_CLEANUP_MAX_ATTEMPTS,
  REPO_CLEANUP_STALE_MS,
  redriveRepoCleanups,
  type RepoCleanupDeps,
} from '../src/queues/stalled-redrive.js';
import type { Database } from '@haive/database';

const USER = '00000000-0000-4000-8000-0000000000a1';
const REPO = '00000000-0000-4000-8000-0000000000b1';
const ROW = (n: number) => `00000000-0000-4000-8000-0000000000e${n}`;

function setup() {
  const fake = createFakeDb({ repoCleanups: schema.repoCleanups });
  const add = (n: number, over: Record<string, unknown> = {}) =>
    fake.insert(schema.repoCleanups, {
      id: ROW(n),
      userId: USER,
      repositoryId: REPO,
      kind: 'resources',
      payload: {
        userId: USER,
        repositoryId: REPO,
        taskIds: [],
        envTemplateIds: [],
        storagePath: null,
      },
      attempts: 0,
      lastEnqueuedAt: null,
      createdAt: new Date(Date.now() - REPO_CLEANUP_STALE_MS - 1000),
      ...over,
    });
  const queued: { kind: string; payload: unknown; jobId: string }[] = [];
  const deps: RepoCleanupDeps = {
    enqueueRepoCleanup: async (kind, payload, jobId) => {
      queued.push({ kind, payload, jobId });
    },
  };
  return { fake, db: fake.db as unknown as Database, add, queued, deps };
}

const ago = (ms: number) => new Date(Date.now() - ms);

describe('redriveRepoCleanups', () => {
  it('queues a cleanup whose enqueue was never recorded, and counts the attempt', async () => {
    const { fake, db, add, queued, deps } = setup();
    add(1);
    expect(await redriveRepoCleanups(db, deps)).toBe(1);
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({
      kind: 'resources',
      payload: { repositoryId: REPO, cleanupId: ROW(1) },
      jobId: `repo-cleanup-${ROW(1)}-1`,
    });
    const [row] = fake.rows(schema.repoCleanups);
    expect(row!.attempts).toBe(1);
    expect(row!.lastEnqueuedAt).toBeInstanceOf(Date);
  });

  it('leaves a just-written row to the api that is queuing it', async () => {
    const { db, add, queued, deps } = setup();
    add(1, { createdAt: new Date() });
    expect(await redriveRepoCleanups(db, deps)).toBe(0);
    expect(queued).toEqual([]);
  });

  it('queues a rag cleanup under its own kind', async () => {
    const { db, add, queued, deps } = setup();
    add(1, { kind: 'rag', payload: { userId: USER, repositoryId: REPO, projectNames: ['p'] } });
    await redriveRepoCleanups(db, deps);
    expect(queued[0]).toMatchObject({
      kind: 'rag',
      payload: { projectNames: ['p'], cleanupId: ROW(1) },
    });
  });

  it('queues one whose last enqueue is older than the stale window', async () => {
    const { db, add, queued, deps } = setup();
    add(1, { attempts: 2, lastEnqueuedAt: ago(REPO_CLEANUP_STALE_MS + 60_000) });
    await redriveRepoCleanups(db, deps);
    expect(queued.map((q) => q.jobId)).toEqual([`repo-cleanup-${ROW(1)}-3`]);
  });

  it('leaves a recently queued one alone', async () => {
    const { fake, db, add, queued, deps } = setup();
    add(1, { attempts: 1, lastEnqueuedAt: ago(60_000) });
    expect(await redriveRepoCleanups(db, deps)).toBe(0);
    expect(queued).toEqual([]);
    expect(fake.rows(schema.repoCleanups)[0]!.attempts).toBe(1);
  });

  it('drops one past the attempt cap with nothing queued', async () => {
    const { fake, db, add, queued, deps } = setup();
    add(1, {
      attempts: REPO_CLEANUP_MAX_ATTEMPTS,
      lastEnqueuedAt: ago(REPO_CLEANUP_STALE_MS + 60_000),
    });
    add(2, { attempts: 1, lastEnqueuedAt: ago(REPO_CLEANUP_STALE_MS + 60_000) });
    await redriveRepoCleanups(db, deps);
    expect(fake.rows(schema.repoCleanups).map((r) => r.id)).toEqual([ROW(2)]);
    expect(queued.map((q) => q.jobId)).toEqual([`repo-cleanup-${ROW(2)}-2`]);
  });

  it('a second sweep right after the first queues nothing', async () => {
    const { db, add, queued, deps } = setup();
    add(1);
    await redriveRepoCleanups(db, deps);
    await redriveRepoCleanups(db, deps);
    expect(queued).toHaveLength(1);
  });

  it('keeps the row for the next window when the queue refuses the job', async () => {
    const { fake, db, add } = setup();
    add(1);
    const refusing: RepoCleanupDeps = {
      enqueueRepoCleanup: async () => {
        throw new Error('redis down');
      },
    };
    expect(await redriveRepoCleanups(db, refusing)).toBe(0);
    expect(fake.rows(schema.repoCleanups)).toHaveLength(1);
  });
});

describe('the rag cleanup job', () => {
  beforeEach(() => h.ragCleanup.mockClear());

  const run = (cleanupId?: string) =>
    processTaskJob({
      name: TASK_JOB_NAMES.CLEANUP_REPO_RAG,
      data: {
        userId: USER,
        repositoryId: REPO,
        projectNames: ['p'],
        ...(cleanupId ? { cleanupId } : {}),
      },
    } as unknown as Job);

  it('deletes its repo_cleanups row once it has run', async () => {
    const { fake, add } = setup();
    add(1, { kind: 'rag' });
    add(2, { kind: 'rag' });
    h.db = fake.db;
    await run(ROW(1));
    expect(fake.rows(schema.repoCleanups).map((r) => r.id)).toEqual([ROW(2)]);
  });

  it('keeps the row when the cleanup throws, so the sweep can try again', async () => {
    const { fake, add } = setup();
    add(1, { kind: 'rag' });
    h.db = fake.db;
    h.ragCleanup.mockRejectedValueOnce(new Error('db busy'));
    await expect(run(ROW(1))).rejects.toThrow('db busy');
    expect(fake.rows(schema.repoCleanups)).toHaveLength(1);
  });

  it('runs a payload with no cleanupId as before', async () => {
    const { fake, add } = setup();
    add(1, { kind: 'rag' });
    h.db = fake.db;
    await run();
    expect(h.ragCleanup).toHaveBeenCalledTimes(1);
    expect(fake.rows(schema.repoCleanups)).toHaveLength(1);
  });
});
