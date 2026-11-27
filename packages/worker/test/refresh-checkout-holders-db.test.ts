import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { UnrecoverableError, type Job, type Processor } from 'bullmq';
import { REPO_JOB_NAMES, type RepoJobPayload } from '@haive/shared';
import { createDatabase, schema, type Database } from '@haive/database';
import { checkoutHoldingTasks } from '../src/repo/refresh.js';

const h = vi.hoisted(() => ({
  db: undefined as unknown,
  processor: undefined as Processor<RepoJobPayload> | undefined,
  scan: vi.fn(),
}));
vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/redis.js', () => ({ getBullRedis: () => ({}) }));
vi.mock('bullmq', async (original) => ({
  ...(await original<typeof import('bullmq')>()),
  Worker: class {
    constructor(_name: string, processor: Processor<RepoJobPayload>) {
      h.processor = processor;
    }
    on() {}
  },
}));
vi.mock('../src/repo/clone.js', async (original) => ({
  ...(await original<typeof import('../src/repo/clone.js')>()),
  handleScan: h.scan,
  handleExtract: h.scan,
}));
vi.mock('../src/repo/refresh.js', async (original) => ({
  ...(await original<typeof import('../src/repo/refresh.js')>()),
  handleRefresh: h.scan,
}));
import { startRepoWorker } from '../src/queues/repo-queue.js';

const url = process.env.CHECKOUT_HOLDERS_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/checkout_holders_test')) {
  throw new Error('Use a dedicated checkout_holders_test database');
}

describe.skipIf(!url)('root checkout holders and refresh ownership', () => {
  let db: Database;
  const userId = randomUUID();
  let repositoryId: string;
  beforeAll(async () => {
    db = createDatabase(url!);
    h.db = db;
    startRepoWorker('/unused');
    await db.insert(schema.users).values({
      id: userId,
      emailEncrypted: 'x',
      emailBlindIndex: userId,
      passwordHash: 'x',
    });
    const [repo] = await db
      .insert(schema.repositories)
      .values({
        userId,
        name: 'scratch',
        source: 'blank',
      })
      .returning();
    repositoryId = repo!.id;
  });
  afterAll(async () => {
    if (!db) return;
    await db.delete(schema.users).where(eq(schema.users.id, userId));
    await db.$client.end({ timeout: 5 });
  });

  it.each(['success', 'final failure'])(
    'T594 fix-3: an initial scan ending in %s keeps a refresh admitted during its imports',
    async (outcome) => {
      const newerJobId = randomUUID();
      h.scan.mockImplementationOnce(async () => {
        // persistDetection publishes ready before mirror imports finish, without a root claim.
        await db
          .update(schema.repositories)
          .set({ status: 'ready', refreshPending: false })
          .where(eq(schema.repositories.id, repositoryId));
        // A refresh is admitted while that initial scan is still importing mirrors.
        await db
          .update(schema.repositories)
          .set({ refreshPending: true, refreshJobId: newerJobId })
          .where(eq(schema.repositories.id, repositoryId));
        if (outcome === 'final failure') throw new Error('initial scan failed');
      });
      const job = {
        id: 'initial-scan',
        name: REPO_JOB_NAMES.SCAN,
        data: { repositoryId, userId, source: 'local_path', localPath: '/unused' },
        attemptsMade: 0,
        opts: { attempts: 1 },
      } as Job<RepoJobPayload>;
      if (outcome === 'success') await h.processor!(job, 'token');
      else await expect(h.processor!(job, 'token')).rejects.toThrow('initial scan failed');
      const row = await db.query.repositories.findFirst({
        where: eq(schema.repositories.id, repositoryId),
      });
      expect(row).toMatchObject({ refreshPending: true, refreshJobId: newerJobId });
    },
  );

  it.each([
    [REPO_JOB_NAMES.SCAN, 'success', true],
    [REPO_JOB_NAMES.EXTRACT, 'success', true],
    [REPO_JOB_NAMES.REFRESH, 'success', true],
    [REPO_JOB_NAMES.SCAN, 'backoff', true],
    [REPO_JOB_NAMES.SCAN, 'final failure', true],
    [REPO_JOB_NAMES.SCAN, 'unrecoverable', true],
    [REPO_JOB_NAMES.SCAN, 'success', false],
    [REPO_JOB_NAMES.SCAN, 'final failure', false],
    [REPO_JOB_NAMES.SCAN, 'unrecoverable', false],
  ] as const)('T594 fix-3: %s %s with marker ownership %s', async (name, outcome, ownsMarker) => {
    const jobId = randomUUID();
    const ownerId = ownsMarker ? jobId : randomUUID();
    await db
      .update(schema.repositories)
      .set({ status: 'ready', refreshPending: true, refreshJobId: ownerId })
      .where(eq(schema.repositories.id, repositoryId));
    h.scan.mockImplementationOnce(async () => {
      if (outcome === 'unrecoverable') throw new UnrecoverableError('cannot retry');
      if (outcome !== 'success') throw new Error('scan failed');
    });
    const job = {
      id: jobId,
      name,
      data: { repositoryId, userId, source: 'local_path' },
      attemptsMade: outcome === 'final failure' ? 2 : 0,
      opts: { attempts: 3 },
    } as Job<RepoJobPayload>;
    if (outcome === 'success') await h.processor!(job, 'token');
    else await expect(h.processor!(job, 'token')).rejects.toThrow();
    const retained = !ownsMarker || outcome === 'backoff';
    const row = await db.query.repositories.findFirst({
      where: eq(schema.repositories.id, repositoryId),
    });
    expect(row).toMatchObject({
      refreshPending: retained,
      refreshJobId: retained ? ownerId : null,
    });
  });

  it.each([
    ['skipped', '/old/worktree', 'old-branch', {}, 1],
    ['done', '/active/worktree', 'active-branch', {}, 0],
    ['done', null, null, { worktreePath: '/legacy/worktree', branchName: 'legacy' }, 0],
    ['done', null, 'branch-only', {}, 0],
    ['done', null, null, {}, 1],
  ] as const)(
    'latest 01 %s with columns %s / %s and output %j counts %i',
    async (status, worktreePath, worktreeBranch, output, expected) => {
      const [task] = await db
        .insert(schema.tasks)
        .values({
          userId,
          repositoryId,
          type: 'workflow',
          title: 'holder',
          status: 'running',
          worktreePath,
          worktreeBranch,
        })
        .returning();
      try {
        await db.insert(schema.taskSteps).values([
          {
            taskId: task!.id,
            stepId: '01-worktree-setup',
            stepIndex: 1,
            title: 'worktree',
            round: 0,
            status: 'done',
            output: { worktreePath: '/earlier', branchName: 'earlier' },
          },
          {
            taskId: task!.id,
            stepId: '01-worktree-setup',
            stepIndex: 1,
            title: 'worktree',
            round: 1,
            status,
            output,
          },
        ]);
        expect(await checkoutHoldingTasks(db, repositoryId, { rootOnly: true })).toBe(expected);
        expect(await checkoutHoldingTasks(db, repositoryId)).toBe(1);
        expect(
          await checkoutHoldingTasks(db, repositoryId, { rootOnly: true, excludeTaskId: task!.id }),
        ).toBe(0);
      } finally {
        await db.delete(schema.tasks).where(eq(schema.tasks.id, task!.id));
      }
    },
  );
});
