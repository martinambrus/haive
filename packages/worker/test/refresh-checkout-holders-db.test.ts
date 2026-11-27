import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ensureDirNoFollow, writeFileNoFollow, readFileNoFollow } from '@haive/shared/fs-safe';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { UnrecoverableError, type Job, type Processor } from 'bullmq';
import { configService, REPO_JOB_NAMES, type RepoJobPayload } from '@haive/shared';
import { createDatabase, schema, type Database } from '@haive/database';
import { checkoutHoldingTasks } from '../src/repo/refresh.js';
import { CheckoutRepairNeededError } from '../src/repo/repair-needed.js';

const h = vi.hoisted(() => ({
  db: undefined as unknown,
  processor: undefined as Processor<RepoJobPayload> | undefined,
  scan: vi.fn(),
  realScan: undefined as unknown as typeof import('../src/repo/clone.js').handleScan,
  detect: vi.fn(),
  sync: vi.fn(async () => ({ outcome: 'absent' })),
  jobs: [] as unknown[],
  apiAdd: vi.fn(async (..._args: unknown[]) => undefined),
  userId: '',
  afterClaim: undefined as undefined | (() => Promise<void>),
}));
vi.mock('../../api/src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../../api/src/middleware/auth.js', () => ({
  requireAdmin: async (_c: unknown, next: () => Promise<void>) => next(),
  requireAuth: async (
    c: { set: (key: string, value: string) => void },
    next: () => Promise<void>,
  ) => {
    c.set('userId', h.userId);
    await next();
  },
}));
vi.mock('../../api/src/queues.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  getRepoQueue: () => ({ add: h.apiAdd, getJobs: async () => [] }),
}));
vi.mock('@haive/database', async (original) => {
  const real = await original<typeof import('@haive/database')>();
  return {
    ...real,
    acquireRootClaim: async (...args: Parameters<typeof real.acquireRootClaim>) => {
      const claim = await real.acquireRootClaim(...args);
      if (claim) await h.afterClaim?.();
      return claim;
    },
  };
});
vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/redis.js', () => ({ getBullRedis: () => ({}) }));
vi.mock('bullmq', async (original) => ({
  ...(await original<typeof import('bullmq')>()),
  Queue: class {
    async getJobs() {
      return h.jobs;
    }
  },
  Worker: class {
    constructor(_name: string, processor: Processor<RepoJobPayload>) {
      h.processor = processor;
    }
    on() {}
  },
}));
vi.mock('../src/repo/clone.js', async (original) => {
  const real = await original<typeof import('../src/repo/clone.js')>();
  h.realScan = real.handleScan;
  return { ...real, handleScan: h.scan, handleExtract: h.scan, handleInit: h.scan };
});
vi.mock('../src/repo/refresh.js', async (original) => ({
  ...(await original<typeof import('../src/repo/refresh.js')>()),
  handleRefresh: h.scan,
}));
vi.mock('../src/repo/framework-detect.js', () => ({ detectFromDirectory: h.detect }));
vi.mock('../src/project-state/sync.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  syncProjectStateFromCheckout: h.sync,
}));
vi.mock('../src/plan/sync-checkout.js', () => ({ syncPlanFromCheckout: async () => {} }));
vi.mock('../src/project-state/rtk-conflict.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  raiseRtkQuestion: async () => {},
}));
import { reconcileStrandedCloningRepos } from '../src/data-migrations.js';
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
    h.userId = userId;
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
      const initialId = randomUUID();
      await db
        .update(schema.repositories)
        .set({ refreshPending: true, refreshJobId: initialId })
        .where(eq(schema.repositories.id, repositoryId));
      h.scan.mockImplementationOnce(async () => {
        // persistDetection publishes ready before mirror imports finish, without a root claim.
        await db
          .update(schema.repositories)
          .set({ status: 'ready', refreshPending: false })
          .where(eq(schema.repositories.id, repositoryId));
        // A refresh is admitted while that initial scan is still importing mirrors.
        await db
          .update(schema.repositories)
          .set({
            status: 'ready',
            errorCode: null,
            statusMessage: 'new success',
            refreshPending: true,
            refreshJobId: newerJobId,
          })
          .where(eq(schema.repositories.id, repositoryId));
        if (outcome === 'final failure') throw new Error('initial scan failed');
      });
      const job = {
        id: initialId,
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
      expect(row).toMatchObject({
        status: 'ready',
        errorCode: null,
        statusMessage: 'new success',
        refreshPending: true,
        refreshJobId: newerJobId,
      });
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
    else if (ownsMarker) await expect(h.processor!(job, 'token')).rejects.toThrow();
    else await h.processor!(job, 'token');
    h.scan.mockReset();
    const retained = !ownsMarker || outcome === 'backoff';
    const row = await db.query.repositories.findFirst({
      where: eq(schema.repositories.id, repositoryId),
    });
    expect(row).toMatchObject({
      refreshPending: retained,
      refreshJobId: retained ? ownerId : null,
    });
  });

  function barrier() {
    let release!: () => void;
    const promise = new Promise<void>((r) => {
      release = r;
    });
    return { promise, release };
  }
  const read = () =>
    db.query.repositories.findFirst({ where: eq(schema.repositories.id, repositoryId) });
  const admit = (jobId: string, values = {}) =>
    db
      .update(schema.repositories)
      .set({ refreshPending: true, refreshJobId: jobId, ...values })
      .where(eq(schema.repositories.id, repositoryId));
  function job(id: string, name: string = REPO_JOB_NAMES.SCAN, attemptsMade = 0) {
    return {
      id,
      name,
      data: {
        repositoryId,
        userId,
        source: 'local_path',
        localPath: '/unused',
        remoteUrl: 'https://127.0.0.1:1/repo.git',
      },
      attemptsMade,
      opts: { attempts: 3 },
    } as Job<RepoJobPayload>;
  }
  it.each(['ready', 'cloning'] as const)(
    'old failure arriving during newer %s preserves the complete outcome',
    async (status) => {
      const oldId = randomUUID(),
        newId = randomUUID();
      await admit(oldId);
      const entered = barrier(),
        resume = barrier();
      h.scan.mockImplementationOnce(async () => {
        entered.release();
        await resume.promise;
        throw new CheckoutRepairNeededError('old failure');
      });
      const old = h.processor!(job(oldId), 'token');
      const rejected = expect(old).rejects.toThrow('old failure');
      await entered.promise;
      await admit(newId, {
        status,
        errorCode: null,
        statusMessage: 'new outcome',
        detectedFramework: 'new-framework',
        detectedLanguages: ['new-language'],
      });
      const before = await read();
      resume.release();
      await rejected;
      expect(await read()).toEqual(before);
    },
  );
  it('two scans overlap detection: the obsolete detection cannot publish or import', async () => {
    const oldId = randomUUID(),
      newId = randomUUID();
    const entered = barrier(),
      resume = barrier();
    const detection = (framework: string) => ({
      framework,
      languages: [framework],
      fileTree: [`${framework}.ts`],
      sizeBytes: framework === 'old' ? 10 : 20,
    });
    h.detect.mockImplementationOnce(async () => {
      entered.release();
      await resume.promise;
      return detection('old');
    });
    h.detect.mockImplementationOnce(async () => detection('new'));
    // Run the real scan through the queue seam.
    h.scan.mockImplementationOnce(h.realScan);
    await admit(oldId);
    const old = h.processor!(job(oldId), 'token');
    await entered.promise;
    await admit(newId);
    h.scan.mockImplementationOnce(h.realScan);
    await h.processor!(job(newId), 'token');
    const before = await read();
    h.sync.mockClear();
    resume.release();
    await old;
    expect(await read()).toEqual(before);
    expect(h.sync).not.toHaveBeenCalled();
  });
  it.each([
    ['new owner', 0],
    ['new owner', 1],
    ['completed owner', 0],
    ['legacy ownerless', 0],
  ] as const)(
    'obsolete clone redelivery with %s at attempt %i touches no checkout bytes',
    async (kind, attemptsMade) => {
      const root = await mkdtemp(path.join(tmpdir(), 'repo-owner-'));
      try {
        startRepoWorker(root);
        const rel = `${userId}/${repositoryId}`;
        await ensureDirNoFollow(root, rel);
        await writeFileNoFollow(root, `${rel}/sentinel`, 'new checkout');
        await db
          .update(schema.repositories)
          .set({
            refreshPending: kind === 'new owner',
            refreshJobId: kind === 'new owner' ? randomUUID() : null,
            status: 'ready',
          })
          .where(eq(schema.repositories.id, repositoryId));
        const before = await read();
        await h.processor!(job(randomUUID(), REPO_JOB_NAMES.CLONE, attemptsMade), 'token').catch(
          () => undefined,
        );
        expect((await readFileNoFollow(root, `${rel}/sentinel`))?.data.toString('utf8')).toBe(
          'new checkout',
        );
        expect(await read()).toEqual(before);
      } finally {
        startRepoWorker('/unused');
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it.each([REPO_JOB_NAMES.COPY, REPO_JOB_NAMES.INIT, REPO_JOB_NAMES.CLONE, REPO_JOB_NAMES.EXTRACT])(
    'same-owner %s redelivery after ready resumes imports without touching the checkout',
    async (name) => {
      const root = await mkdtemp(path.join(tmpdir(), 'repo-ready-redelivery-'));
      const real =
        await vi.importActual<typeof import('../src/repo/clone.js')>('../src/repo/clone.js');
      const jobId = randomUUID();
      try {
        startRepoWorker(root);
        const rel = `${userId}/${repositoryId}`;
        await ensureDirNoFollow(root, rel);
        await writeFileNoFollow(root, `${rel}/sentinel`, 'user work after ready');
        await admit(jobId, {
          status: 'ready',
          storagePath: path.join(root, rel),
          statusMessage: 'kept caveat',
        });
        h.scan.mockReset();
        if (name === REPO_JOB_NAMES.INIT) h.scan.mockImplementationOnce(real.handleInit);
        if (name === REPO_JOB_NAMES.EXTRACT) h.scan.mockImplementationOnce(real.handleExtract);
        h.detect.mockClear();
        h.sync.mockClear();
        const delivery = job(jobId, name);
        delivery.data.localPath = path.join(root, 'missing-source');
        delivery.data.archivePath = path.join(root, '_uploads', userId, 'missing.tar');
        delivery.data.archiveFormat = 'tar';
        await h.processor!(delivery, 'token').catch(() => undefined);
        expect
          .soft((await readFileNoFollow(root, `${rel}/sentinel`))?.data.toString())
          .toBe('user work after ready');
        expect.soft(h.detect).not.toHaveBeenCalled();
        expect
          .soft(h.sync)
          .toHaveBeenCalledWith(db, { repositoryId, repoPath: path.join(root, rel) });
        expect(await read()).toMatchObject({
          status: 'ready',
          statusMessage: 'kept caveat',
          refreshPending: false,
          refreshJobId: null,
        });
      } finally {
        h.scan.mockReset();
        startRepoWorker('/unused');
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it('ownership is checked again after the root claim and before clone removes anything', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'repo-owner-claim-'));
    const entered = barrier(),
      resume = barrier();
    const oldId = randomUUID(),
      newId = randomUUID();
    let running: Promise<unknown> | undefined;
    try {
      startRepoWorker(root);
      const rel = `${userId}/${repositoryId}`;
      await ensureDirNoFollow(root, rel);
      await writeFileNoFollow(root, `${rel}/sentinel`, 'new checkout');
      await admit(oldId, { status: 'cloning' });
      h.afterClaim = async () => {
        entered.release();
        await resume.promise;
      };
      running = h.processor!(job(oldId, REPO_JOB_NAMES.CLONE), 'token');
      await entered.promise;
      await admit(newId, { status: 'cloning', statusMessage: 'newer job' });
      resume.release();
      await running;
      expect((await readFileNoFollow(root, `${rel}/sentinel`))?.data.toString()).toBe(
        'new checkout',
      );
      expect(await read()).toMatchObject({
        status: 'cloning',
        statusMessage: 'newer job',
        refreshPending: true,
        refreshJobId: newId,
      });
    } finally {
      h.afterClaim = undefined;
      resume.release();
      await running?.catch(() => undefined);
      startRepoWorker('/unused');
      await rm(root, { recursive: true, force: true });
    }
  });
  it('refused ownerless legacy preparation remains recoverable by the stranded sweep', async () => {
    await db
      .update(schema.repositories)
      .set({
        status: 'cloning',
        refreshPending: false,
        refreshJobId: null,
        updatedAt: new Date('2020-01-01'),
        errorCode: null,
      })
      .where(eq(schema.repositories.id, repositoryId));
    const before = await read();
    h.scan.mockReset();
    await h.processor!(job(randomUUID()), 'token');
    expect(await read()).toEqual(before);
    expect(h.scan).not.toHaveBeenCalled();
    h.jobs = [];
    await reconcileStrandedCloningRepos(db);
    expect(await read()).toMatchObject({
      status: 'error',
      refreshPending: false,
      refreshJobId: null,
    });
  });
  it.each(['ready', 'cloning'] as const)(
    'stale %s marker is recovered and its obsolete redelivery stays refused',
    async (status) => {
      const staleId = randomUUID();
      await admit(staleId, {
        status,
        errorCode: null,
        statusMessage: 'kept ready copy',
        updatedAt: new Date('2020-01-01'),
      });
      h.jobs = [];
      await reconcileStrandedCloningRepos(db);
      expect(await read()).toMatchObject({
        status: status === 'ready' ? 'ready' : 'error',
        refreshPending: false,
        refreshJobId: null,
      });
      if (status === 'ready') expect((await read())?.statusMessage).toBe('kept ready copy');
      const recovered = await read();
      h.scan.mockImplementationOnce(async () => {
        throw new Error('obsolete job after stale-marker recovery');
      });
      await h.processor!(job(staleId), 'token').catch(() => undefined);
      expect(await read()).toEqual(recovered);
      expect(h.scan).not.toHaveBeenCalled();
      h.scan.mockReset();
    },
  );

  it('initial import held after ready remains counted by maintenance and updater', async () => {
    const reposPath = new URL('../../api/src/routes/repos.ts', import.meta.url).href;
    const maintenancePath = new URL('../../api/src/routes/maintenance.ts', import.meta.url).href;
    const updaterPath = new URL('../../updater/src/run.ts', import.meta.url).href;
    const { repoRoutes } = await import(reposPath);
    const { listBlockingJobs } = await import(maintenancePath);
    const { liveWorkCount } = await import(updaterPath);
    const spy = vi.spyOn(configService, 'getFresh').mockResolvedValue('normal');
    const root = await mkdtemp(path.join(tmpdir(), 'repo-import-owner-'));
    const entered = barrier(),
      resume = barrier();
    let importing: Promise<unknown> | undefined;
    let createdId: string | undefined;
    try {
      h.apiAdd.mockClear();
      const response = await repoRoutes.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: 'blank', name: 'initial' }),
      });
      expect(response.status).toBe(201);
      const [name, data, opts] = h.apiAdd.mock.calls[0] as [
        string,
        RepoJobPayload,
        { jobId: string },
      ];
      createdId = data.repositoryId;
      const beforeImport = await liveWorkCount(db.$client);
      h.detect.mockResolvedValue({ framework: null, languages: [], fileTree: [], sizeBytes: 0 });
      h.sync.mockImplementationOnce(async () => {
        entered.release();
        await resume.promise;
        return { outcome: 'absent' };
      });
      h.scan.mockImplementationOnce((payload, db) =>
        h.realScan({ ...payload, localPath: root }, db),
      );
      importing = h.processor!(
        {
          id: opts.jobId,
          name,
          data,
          opts: { attempts: 3 },
          attemptsMade: 0,
        } as Job<RepoJobPayload>,
        'token',
      );
      await entered.promise;
      const row = await db.query.repositories.findFirst({
        where: eq(schema.repositories.id, createdId!),
      });
      expect
        .soft(row)
        .toMatchObject({ status: 'ready', refreshPending: true, refreshJobId: opts.jobId });
      expect
        .soft((await listBlockingJobs(db)).jobs)
        .toContainEqual(expect.objectContaining({ id: createdId, status: 'pending preparation' }));
      const count = await liveWorkCount(db.$client);
      expect.soft(count).toBe(beforeImport);
      resume.release();
      await importing;
      expect.soft(await liveWorkCount(db.$client)).toBe(beforeImport - 1);
      expect((await listBlockingJobs(db)).jobs).not.toContainEqual(
        expect.objectContaining({ id: createdId }),
      );
    } finally {
      resume.release();
      await importing?.catch(() => undefined);
      spy.mockRestore();
      if (createdId)
        await db.delete(schema.repositories).where(eq(schema.repositories.id, createdId));
      await rm(root, { recursive: true, force: true });
    }
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
