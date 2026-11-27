vi.mock('../src/repo/interactive-checkout.js', async (original) => ({
  ...(await original<typeof import('../src/repo/interactive-checkout.js')>()),
  suspendCheckoutSessions: async () => () => {},
}));
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { Queue, QueueEvents, type Job, type Worker } from 'bullmq';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBullRedisConnection, QUEUE_NAMES, REPO_JOB_NAMES } from '@haive/shared';
import type { RepoJobPayload } from '@haive/shared';
import { acquireRootClaim, schema, type Database } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';

// The refresh route adds its job with `attempts: 3`, and BullMQ runs a processor that throws again.
// This is the one place the real queue, the real repo worker and the real rebuild meet, so what a
// retry would do to the old folder is measured rather than read. Opt-in on a Redis of its own,
// never the application's: set REFRESH_RETRIES_TEST_REDIS_URL to one, in a database other than 0.
const redisUrl = process.env.REFRESH_RETRIES_TEST_REDIS_URL;
if (redisUrl && !/^\/(?:[1-9]|1[0-5])$/.test(new URL(redisUrl).pathname))
  throw new Error('REFRESH_RETRIES_TEST_REDIS_URL must name database 1-15, never the default 0');

const h = vi.hoisted(() => ({
  redis: null as unknown,
  persist: vi.fn(),
  restore: vi.fn(),
  seed: vi.fn(),
  holding: false,
  realClaims: false,
  /** Stand in for the copy and the clone that follow the move. Null runs the real copy; the clone
   *  is never real, and with no stand-in it finishes and leaves nothing. */
  copyFault: null as null | ((src: string, dest: string) => Promise<void>),
  cloneFault: null as null | ((url: string, dest: string) => Promise<void>),
}));
vi.mock('../src/repo/clone.js', async (original) => {
  const real = await original<typeof import('../src/repo/clone.js')>();
  return {
    ...real,
    withRootClaim: (...args: Parameters<typeof real.withRootClaim>) =>
      h.realClaims ? real.withRootClaim(...args) : args[2](),
    persistDetection: h.persist,
    restoreProjectData: h.restore,
    copyTree: (src: string, dest: string) =>
      h.copyFault ? h.copyFault(src, dest) : real.copyTree(src, dest),
    gitClone: (url: string, dest: string) =>
      h.cloneFault ? h.cloneFault(url, dest) : Promise.resolve(),
  };
});
vi.mock('../src/plan/mirror.js', async (original) => ({
  ...(await original<typeof import('../src/plan/mirror.js')>()),
  seedPlanBaseFromCheckout: h.seed,
}));
vi.mock('../src/db.js', () => ({ getDb: () => db }));
vi.mock('../src/redis.js', () => ({ getBullRedis: () => h.redis }));
import { startRepoWorker } from '../src/queues/repo-queue.js';

const exec = promisify(execFile);
const git = async (cwd: string, args: string[]) =>
  (
    await exec('git', args, {
      cwd,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'T',
        GIT_AUTHOR_EMAIL: 't@local',
        GIT_COMMITTER_NAME: 'T',
        GIT_COMMITTER_EMAIL: 't@local',
      },
    })
  ).stdout.trim();
const REPO = '00000000-0000-4000-8000-000000000001';
const { compileWhere } = createFakeDb({ repositories: schema.repositories });
const row: {
  id: string;
  status: string;
  statusMessage?: string;
  checkoutAsidePaths?: string[];
  checkoutAsideJobId?: string | null;
  errorCode?: string | null;
  refreshPending: boolean;
  refreshJobId: string | null;
  rootClaimedAt?: Date | null;
  rootClaimOwner?: string | null;
  rootClaimKind?: string | null;
} = {
  id: REPO,
  status: 'cloning',
  refreshPending: false,
  refreshJobId: null,
};
const db = {
  execute: async () => {},
  select: () => ({
    from: (table: unknown) => ({
      where: (predicate: unknown) => ({
        limit: async () =>
          table === schema.repositories && compileWhere(schema.repositories, predicate)(row)
            ? [{ ...row }]
            : [],
      }),
    }),
  }),
  transaction: async (fn: (tx: unknown) => unknown) => fn(db),
  query: { tasks: { findMany: async () => (h.holding ? [{ id: 'live' }] : []) } },
  update: () => ({
    set: (values: object) => ({
      where: (predicate: unknown) => {
        const updated = compileWhere(schema.repositories, predicate)(row)
          ? [Object.assign(row, values)]
          : [];
        return Object.assign(Promise.resolve(updated), { returning: async () => updated });
      },
    }),
  }),
} as unknown as Database;

const connection = redisUrl ? createBullRedisConnection(redisUrl) : null;
h.redis = connection;
const queue = connection ? new Queue(QUEUE_NAMES.REPO, { connection }) : null;
let worker: Worker | null = null;
let root: string;

beforeEach(async () => {
  vi.clearAllMocks();
  row.status = 'cloning';
  delete row.statusMessage;
  delete row.checkoutAsidePaths;
  delete row.checkoutAsideJobId;
  row.errorCode = 'stale';
  row.refreshPending = false;
  row.refreshJobId = null;
  h.holding = false;
  h.realClaims = false;
  row.rootClaimedAt = null;
  row.rootClaimOwner = null;
  row.rootClaimKind = null;
  h.copyFault = null;
  h.cloneFault = null;
  h.seed.mockResolvedValue(undefined);
  h.restore.mockReset().mockResolvedValue(undefined);
  h.persist.mockImplementation(async (_db, _id, _dest, note) => {
    row.status = 'ready';
    row.errorCode = null;
    row.statusMessage = note;
  });
  root = await mkdtemp(path.join(tmpdir(), 'refresh-retries-'));
});
afterEach(async () => {
  await worker?.close();
  worker = null;
  await queue?.obliterate({ force: true });
  await rm(root, { recursive: true, force: true });
});
afterAll(async () => {
  await queue?.close();
  await connection?.quit();
});

/** A checkout whose HEAD is gone, standing where an import put it, and the folder it came from. */
async function fixture() {
  const source = path.join(root, 'source');
  const dest = path.join(root, 'u1', REPO);
  await mkdir(source);
  await mkdir(path.dirname(dest));
  await git(source, ['init', '-b', 'main']);
  await git(source, ['commit', '--allow-empty', '-m', 'one']);
  await git(root, ['clone', source, dest]);
  await writeFile(path.join(dest, 'notes.md'), 'keep me\n');
  await rm(path.join(dest, '.git/HEAD'));
  return {
    source,
    dest,
    payload: {
      source: 'local_path',
      localPath: source,
      userId: 'u1',
      repositoryId: REPO,
    } as RepoJobPayload,
  };
}

const remote = {
  source: 'git_https',
  remoteUrl: 'https://git.example.test/r1.git',
  branch: 'main',
  userId: 'u1',
  repositoryId: REPO,
} as RepoJobPayload;

/** Adds the refresh job the way the route does, with its attempts and a backoff short enough to wait out. */
async function refreshJob(payload: RepoJobPayload): Promise<Job> {
  // Model API admission, then enqueue exactly the UUID that owns the pending row.
  const jobId = randomUUID();
  row.refreshPending = true;
  row.refreshJobId = jobId;
  worker = startRepoWorker(root);
  await worker.waitUntilReady();
  const job = await queue!.add(REPO_JOB_NAMES.REFRESH, payload, {
    jobId,
    attempts: 3,
    backoff: { type: 'exponential', delay: 100 },
  });
  for (let waited = 0; waited < 30_000; waited += 100) {
    const state = await job.getState();
    if (state === 'failed' || state === 'completed') return (await queue!.getJob(job.id!))!;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`the refresh job never settled (${await job.getState()})`);
}
const asides = async (dest: string) =>
  (await readdir(path.dirname(dest))).filter((entry) => entry.startsWith(`${REPO}.aside-`));

/** The copy or clone that follows the move leaves half a tree behind and throws, on every attempt,
 *  as an interrupted `cp -a` does. */
function failBuilding(kind: 'copy' | 'clone', cause: Error) {
  const leaveHalf = async (to: string) => {
    await mkdir(to, { recursive: true });
    await writeFile(path.join(to, 'half.txt'), 'x\n');
    throw cause;
  };
  if (kind === 'copy') h.copyFault = (_src, to) => leaveHalf(to);
  else h.cloneFault = (_url, to) => leaveHalf(to);
}
/** The copy finishes with a file and no checkout; a clone with no stand-in finishes with nothing. */
function buildNoCheckout(kind: 'copy' | 'clone') {
  if (kind === 'copy')
    h.copyFault = async (_src, to) => {
      await writeFile(path.join(to, 'notes.md'), 'no .git\n');
    };
}
/** BullMQ stopped after the first attempt: one run of the processor, one aside, and the row and the
 *  failure BullMQ stored both name where the old folder is. */
async function endedAfterOneRun(job: Job, dest: string) {
  expect(await job.getState()).toBe('failed');
  expect(job.attemptsMade).toBe(1);
  expect(h.seed).toHaveBeenCalledTimes(1);
  const found = await asides(dest);
  expect(found).toHaveLength(1);
  expect(h.persist).not.toHaveBeenCalled();
  expect(row.status).toBe('error');
  expect(row.errorCode).toBeNull();
  expect(row.statusMessage).toContain(`kept next to the checkout as ${found[0]!}`);
  expect(job.failedReason).toBe(row.statusMessage);
}

describe.skipIf(!redisUrl)('a refresh job with attempts: 3 on a real queue', () => {
  it('keeps the aside notice in page copy when a bound-query failure is sanitized', async () => {
    const { dest } = await fixture();
    const secret = 'never-publish-this-bound-value';
    failBuilding(
      'clone',
      Object.assign(new Error(`query failed: ${secret}`), {
        query: 'update repository set secret=$1',
        params: [secret],
        code: 'XX000',
      }),
    );
    await refreshJob(remote);
    const kept = await asides(dest);
    expect(kept).toHaveLength(1);
    expect(row.status).toBe('error');
    expect(row.checkoutAsidePaths).toEqual(kept);
    expect(row.statusMessage).toContain('Database operation failed');
    expect(row.statusMessage).toContain(kept[0]);
    expect(row.statusMessage).not.toContain(secret);
  });

  it('persists every aside as structured data and in the failure shown by the repository page', async () => {
    const { dest } = await fixture();
    const original = `${REPO}.aside-2026-01-01T00-00-00-000Z`;
    await rename(dest, path.join(path.dirname(dest), original));
    await mkdir(dest);
    await writeFile(path.join(dest, 'half.txt'), 'an older interrupted clone');
    failBuilding('clone', new Error('clone failed again'));
    const job = await refreshJob(remote);
    const kept = (await asides(dest)).sort();
    expect(kept).toHaveLength(2);
    expect(row.checkoutAsidePaths).toEqual(kept);
    expect(row.status).toBe('error');
    for (const name of kept) expect(row.statusMessage).toContain(name);
    expect(job.failedReason).toBe(row.statusMessage);
    expect(job.attemptsMade).toBe(1);
    expect(await readFile(path.join(path.dirname(dest), original, 'notes.md'), 'utf8')).toBe(
      'keep me\n',
    );
  });

  it('a real BullMQ retry retains the rebuild notice and a later refresh clears it', async () => {
    const { dest, payload } = await fixture();
    const publish = h.persist.getMockImplementation()!;
    h.persist.mockImplementationOnce(async (...args) => {
      await publish(...args);
      throw new Error('detection import failed after ready');
    });
    const job = await refreshJob(payload);
    expect(await job.getState()).toBe('completed');
    expect(job.attemptsMade).toBe(2);
    expect(row.status).toBe('ready');
    const kept = await asides(dest);
    expect(kept).toHaveLength(1);
    expect(row.checkoutAsidePaths).toEqual(kept);
    expect(row.statusMessage).toContain(kept[0]);
    expect(h.persist).toHaveBeenCalledTimes(2);
    const next = await refreshJob(payload);
    expect(await next.getState()).toBe('completed');
    expect(next.attemptsMade).toBe(1);
    expect(row.statusMessage).toBeNull();
    expect(row.checkoutAsidePaths).toEqual(kept);
  });

  it('a dead folder source leaves the checkout where it was, whichever attempt runs', async () => {
    const { source, dest, payload } = await fixture();
    await rm(path.join(source, '.git/objects'), { recursive: true });
    const job = await refreshJob(payload);
    expect(await asides(dest)).toEqual([]);
    expect(await readdir(path.dirname(dest))).toEqual([REPO]);
    expect(h.persist).not.toHaveBeenCalled();
    expect(row.status).toBe('error');
    expect(row.errorCode).toBeNull();
    expect(row.statusMessage).toMatch(/is not a usable git checkout\. Nothing was moved\.$/);
    expect(await job.getState()).toBe('failed');
  });

  it.each(['copy', 'clone'] as const)(
    'a %s that throws after the move ends the job on its first attempt',
    async (kind) => {
      const { dest, payload } = await fixture();
      failBuilding(kind, new Error(`${kind} failed: simulated`));
      await endedAfterOneRun(await refreshJob(kind === 'copy' ? payload : remote), dest);
    },
  );

  it.each(['copy', 'clone'] as const)(
    'a %s that builds a tree that is not usable ends the job on its first attempt',
    async (kind) => {
      const { dest, payload } = await fixture();
      buildNoCheckout(kind);
      await endedAfterOneRun(await refreshJob(kind === 'copy' ? payload : remote), dest);
    },
  );
});

describe.skipIf(!redisUrl)('repair-needed refresh and explicit checkout recovery', () => {
  it('records a structural code for exit 128 over metadata not proved dead', async () => {
    const { dest, payload } = await fixture();
    await writeFile(path.join(dest, '.git/HEAD'), 'ref: refs/heads/main\n');
    await writeFile(path.join(dest, '.git/config'), '[core\n');
    const job = await refreshJob(payload);
    expect(await job.getState()).toBe('failed');
    expect(row).toMatchObject({ status: 'error', errorCode: 'checkout_repair_needed' });
    expect(await asides(dest)).toEqual([]);
    expect(h.persist).not.toHaveBeenCalled();
  });

  it('an explicit recovery keeps the old checkout and skips mirror import into existing data', async () => {
    const { dest, payload } = await fixture();
    await writeFile(path.join(dest, '.git/HEAD'), 'ref: refs/heads/main\n');
    await writeFile(path.join(dest, '.git/config'), '[core\n');
    const job = await refreshJob({ ...payload, recoverCheckout: true } as RepoJobPayload);
    expect(await job.getState()).toBe('completed');
    const kept = await asides(dest);
    expect(kept).toHaveLength(1);
    expect(await readFile(path.join(path.dirname(dest), kept[0]!, 'notes.md'), 'utf8')).toBe(
      'keep me\n',
    );
    expect(h.persist).toHaveBeenCalledWith(db, REPO, dest, expect.any(String), {
      preserveProjectData: true,
    });
    expect(h.seed).toHaveBeenCalledTimes(1);
  });
});

describe.skipIf(!redisUrl)('a source folder that needs repair', () => {
  it('records a source repair code and retains the managed checkout', async () => {
    const { source, dest, payload } = await fixture();
    await writeFile(path.join(source, '.git/config'), '[core\n');
    const job = await refreshJob(payload);
    expect(await job.getState()).toBe('failed');
    expect(row).toMatchObject({ status: 'error', errorCode: 'source_repair_needed' });
    expect(await asides(dest)).toEqual([]);
    expect(h.persist).not.toHaveBeenCalled();
  });
});

describe.skipIf(!redisUrl)('failed explicit recovery', () => {
  it('keeps recovery explicit after a build failure, without importing mirrors on Retry', async () => {
    const { dest, payload } = await fixture();
    failBuilding('copy', new Error('copy failed'));
    const job = await refreshJob({ ...payload, recoverCheckout: true });
    expect(await job.getState()).toBe('failed');
    expect(job.attemptsMade).toBe(1);
    expect(row).toMatchObject({ status: 'error', errorCode: 'checkout_repair_needed' });
    expect(await asides(dest)).toHaveLength(1);
    expect(h.persist).not.toHaveBeenCalled();
  });
});

describe.skipIf(!redisUrl)('recovery pickup task fence', () => {
  it('finishes ready when tasks hold a checkout that was repaired before recovery pickup', async () => {
    const { dest, payload } = await fixture();
    await writeFile(path.join(dest, '.git/HEAD'), 'ref: refs/heads/main\n');
    h.holding = true;
    const job = await refreshJob({ ...payload, recoverCheckout: true });
    expect(await job.getState()).toBe('completed');
    expect(row).toMatchObject({ status: 'ready', errorCode: null });
    expect(await asides(dest)).toEqual([]);
    expect(h.persist).toHaveBeenCalledWith(
      db,
      REPO,
      dest,
      'Not refreshed: 1 task is using this repository. Refresh once it finishes.',
    );
  });
});

describe.skipIf(!redisUrl)('a rebuilt checkout that needs repair', () => {
  it('keeps the repair code when final verification finds unknown Git metadata', async () => {
    const { dest, payload } = await fixture();
    h.copyFault = async (src, to) => {
      await cp(src, to, { recursive: true });
      await writeFile(path.join(to, '.git/config'), '[core\n');
    };
    const job = await refreshJob(payload);
    expect(await job.getState()).toBe('failed');
    expect(row).toMatchObject({ status: 'error', errorCode: 'checkout_repair_needed' });
    expect(await asides(dest)).toHaveLength(1);
    expect(h.persist).not.toHaveBeenCalled();
  });
});

describe.skipIf(!redisUrl)('preparation waits behind an admitted upload lease', () => {
  it('keeps ready and re-drives attempts: 1 after the lease releases without a failure attempt', async () => {
    const { dest, payload } = await fixture();
    await writeFile(path.join(dest, '.git/HEAD'), 'ref: refs/heads/main\n');
    row.status = 'ready';
    h.holding = true; // A live task makes this usable refresh finish without moving Git.
    h.realClaims = true;
    const upload = (await acquireRootClaim(db, REPO, 'mutation'))!;
    expect(upload).not.toBeNull();
    const events = new QueueEvents(QUEUE_NAMES.REPO, { connection: connection! });
    await events.waitUntilReady();
    const delayed = new Promise<string>((resolve) => {
      events.once('delayed', () => resolve('delayed'));
      events.once('failed', () => resolve('failed'));
    });
    const completed = new Promise<void>((resolve) => events.once('completed', () => resolve()));
    const jobId = randomUUID();
    row.refreshPending = true;
    row.refreshJobId = jobId;
    worker = startRepoWorker(root);
    await worker.waitUntilReady();
    try {
      const job = await queue!.add(REPO_JOB_NAMES.REFRESH, payload, { jobId, attempts: 1 });
      expect(await delayed).toBe('delayed');
      expect(row).toMatchObject({ status: 'ready', refreshPending: true, refreshJobId: jobId });
      expect((await queue!.getJob(jobId))!.attemptsMade).toBe(0);
      await upload.release();
      await job.promote(); // Drive delayed pickup explicitly; no wall-clock backoff wait.
      await completed;
      const ended = (await queue!.getJob(jobId))!;
      expect(await ended.getState()).toBe('completed');
      expect(ended.attemptsMade).toBe(1);
      expect(row).toMatchObject({ status: 'ready', refreshPending: false, refreshJobId: null });
      expect(await readFile(path.join(dest, 'notes.md'), 'utf8')).toBe('keep me\n');
    } finally {
      await upload.release();
      await events.close();
    }
  });
});
