import { UnrecoverableError, type Job } from 'bullmq';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { eq, type SQL } from 'drizzle-orm';
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
import { RagCleanupDeferredError } from '../src/step-engine/steps/onboarding/_rag-connection.js';

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
      jobId: expect.stringMatching(new RegExp(`^repo-cleanup-${ROW(1)}-1-\\d+$`)),
    });
    const [row] = fake.rows(schema.repoCleanups);
    expect(row!.attempts).toBe(1);
    expect(row!.lastEnqueuedAt).toBeInstanceOf(Date);
  });

  it('counts the attempt before the job exists, so a job that runs at once refunds a counted one', async () => {
    const { fake, db, add } = setup();
    add(1, { attempts: 2, lastEnqueuedAt: ago(REPO_CLEANUP_STALE_MS + 60_000) });
    const seen: number[] = [];
    const deps: RepoCleanupDeps = {
      enqueueRepoCleanup: async () => {
        seen.push(fake.rows(schema.repoCleanups)[0]!.attempts as number);
      },
    };
    expect(await redriveRepoCleanups(db, deps)).toBe(1);
    expect(seen).toEqual([3]);
    expect(fake.rows(schema.repoCleanups)[0]!.attempts).toBe(3);
  });

  it('queues a fresh job id when a refunded attempt is counted again', async () => {
    const { db, add, queued, deps } = setup();
    add(1, { attempts: 2, lastEnqueuedAt: ago(REPO_CLEANUP_STALE_MS + 60_000) });
    await redriveRepoCleanups(db, deps);
    await db
      .update(schema.repoCleanups)
      .set({ attempts: 2, lastEnqueuedAt: ago(REPO_CLEANUP_STALE_MS + 60_000) })
      .where(eq(schema.repoCleanups.id, ROW(1)));
    await new Promise((resolve) => setTimeout(resolve, 2));
    await redriveRepoCleanups(db, deps);
    expect(queued).toHaveLength(2);
    expect(queued[0]!.jobId).not.toBe(queued[1]!.jobId);
  });

  it('rolls back only its own claim when a later sweep claimed the row meanwhile', async () => {
    const { fake, db, add } = setup();
    add(1, { attempts: 1, lastEnqueuedAt: ago(REPO_CLEANUP_STALE_MS + 60_000) });
    const later = new Date(Date.now() + 60_000);
    const deps: RepoCleanupDeps = {
      enqueueRepoCleanup: async () => {
        await db
          .update(schema.repoCleanups)
          .set({ lastEnqueuedAt: later, attempts: 3 })
          .where(eq(schema.repoCleanups.id, ROW(1)));
        throw new Error('queue refused');
      },
    };
    await redriveRepoCleanups(db, deps);
    expect(fake.rows(schema.repoCleanups)[0]).toMatchObject({ attempts: 3, lastEnqueuedAt: later });
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
    expect(queued.map((q) => q.jobId)).toEqual([
      expect.stringMatching(new RegExp(`^repo-cleanup-${ROW(1)}-3-\\d+$`)),
    ]);
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
    expect(queued.map((q) => q.jobId)).toEqual([
      expect.stringMatching(new RegExp(`^repo-cleanup-${ROW(2)}-2-\\d+$`)),
    ]);
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

  it('spends no attempt on a refused enqueue, however often the queue refuses', async () => {
    const { fake, db, add } = setup();
    add(1);
    const refusing: RepoCleanupDeps = {
      enqueueRepoCleanup: async () => {
        throw new Error('redis down');
      },
    };
    for (let i = 0; i < REPO_CLEANUP_MAX_ATTEMPTS + 2; i += 1) {
      await redriveRepoCleanups(db, refusing);
    }
    const [row] = fake.rows(schema.repoCleanups);
    expect(row).toMatchObject({ attempts: 0, lastEnqueuedAt: null });
  });
});

describe('the rag cleanup job', () => {
  beforeEach(() => h.ragCleanup.mockClear());

  const CLAIM = new Date('2026-10-12T08:00:00.000Z');
  const run = (cleanupId?: string, claimStamp: string | null = CLAIM.toISOString()) =>
    processTaskJob({
      name: TASK_JOB_NAMES.CLEANUP_REPO_RAG,
      data: {
        userId: USER,
        repositoryId: REPO,
        projectNames: ['p'],
        ...(cleanupId ? { cleanupId } : {}),
        ...(claimStamp ? { claimStamp } : {}),
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

  it('keeps the row and rejects when the cleanup is deferred by a running sync', async () => {
    const { fake, add } = setup();
    add(1, { kind: 'rag' });
    h.db = fake.db;
    h.ragCleanup.mockRejectedValueOnce(new RagCleanupDeferredError(REPO, 'a sync holds the lock'));
    await expect(run(ROW(1))).rejects.toBeInstanceOf(RagCleanupDeferredError);
    expect(fake.rows(schema.repoCleanups)).toHaveLength(1);
  });

  it('makes a deferral unrecoverable, so BullMQ never retries the attempt it refunds', () => {
    expect(new RagCleanupDeferredError('r', 'held')).toBeInstanceOf(UnrecoverableError);
  });

  describe('a deferral', () => {
    const renderedAttempts = (fake: ReturnType<typeof setup>['fake']) => {
      const [row] = fake.rows(schema.repoCleanups);
      return new PgDialect().sqlToQuery(row!.attempts as SQL).sql;
    };

    it('refunds the attempt it was queued with, floored at zero, and keeps the row', async () => {
      const { fake, add } = setup();
      add(1, { kind: 'rag', attempts: 3, lastEnqueuedAt: CLAIM });
      h.db = fake.db;
      h.ragCleanup.mockRejectedValueOnce(new RagCleanupDeferredError(REPO, 'a sync holds it'));
      await expect(run(ROW(1))).rejects.toBeInstanceOf(RagCleanupDeferredError);
      expect(fake.rows(schema.repoCleanups)).toHaveLength(1);
      expect(renderedAttempts(fake)).toBe('greatest("repo_cleanups"."attempts" - 1, 0)');
      expect(fake.rows(schema.repoCleanups)[0]!.lastEnqueuedAt).toEqual(
        new Date(CLAIM.getTime() + 1),
      );
    });

    it('refunds a claim once, however often the job is delivered', async () => {
      const { fake, add } = setup();
      add(1, { kind: 'rag', attempts: 3, lastEnqueuedAt: CLAIM });
      h.db = fake.db;
      h.ragCleanup.mockRejectedValue(new RagCleanupDeferredError(REPO, 'a sync holds it'));
      await expect(run(ROW(1))).rejects.toBeInstanceOf(RagCleanupDeferredError);
      // The fake keeps the refund as SQL; a plain number shows whether a second refund lands.
      await fake.db
        .update(schema.repoCleanups)
        .set({ attempts: 2 })
        .where(eq(schema.repoCleanups.id, ROW(1)));
      await expect(run(ROW(1))).rejects.toBeInstanceOf(RagCleanupDeferredError);
      h.ragCleanup.mockReset();
      expect(fake.rows(schema.repoCleanups)[0]!.attempts).toBe(2);
    });

    it('refunds nothing for a job no sweep counted', async () => {
      const { fake, add } = setup();
      add(1, { kind: 'rag', attempts: 3, lastEnqueuedAt: CLAIM });
      h.db = fake.db;
      h.ragCleanup.mockRejectedValueOnce(new RagCleanupDeferredError(REPO, 'a sync holds it'));
      await expect(run(ROW(1), null)).rejects.toBeInstanceOf(RagCleanupDeferredError);
      expect(fake.rows(schema.repoCleanups)[0]!.attempts).toBe(3);
    });

    it('leaves attempts alone when the job carries no cleanupId', async () => {
      const { fake, add } = setup();
      add(1, { kind: 'rag', attempts: 3 });
      h.db = fake.db;
      h.ragCleanup.mockRejectedValueOnce(new RagCleanupDeferredError(REPO, 'a sync holds it'));
      await expect(run()).rejects.toBeInstanceOf(RagCleanupDeferredError);
      expect(fake.rows(schema.repoCleanups)[0]!.attempts).toBe(3);
    });

    it('does not refund a cleanup that failed for another reason', async () => {
      const { fake, add } = setup();
      add(1, { kind: 'rag', attempts: 3 });
      h.db = fake.db;
      h.ragCleanup.mockRejectedValueOnce(new Error('db busy'));
      await expect(run(ROW(1))).rejects.toThrow('db busy');
      expect(fake.rows(schema.repoCleanups)[0]!.attempts).toBe(3);
    });

    it('still rethrows the deferral when the refund write fails', async () => {
      const { fake, add } = setup();
      add(1, { kind: 'rag', attempts: 3 });
      h.db = new Proxy(fake.db as object, {
        get: (target, prop, receiver) =>
          prop === 'update'
            ? () => {
                throw new Error('write refused');
              }
            : Reflect.get(target, prop, receiver),
      });
      h.ragCleanup.mockRejectedValueOnce(new RagCleanupDeferredError(REPO, 'a sync holds it'));
      await expect(run(ROW(1))).rejects.toBeInstanceOf(RagCleanupDeferredError);
      expect(fake.rows(schema.repoCleanups)[0]!.attempts).toBe(3);
    });
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
