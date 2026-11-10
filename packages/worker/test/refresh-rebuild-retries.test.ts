import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { Queue, type Job, type Worker } from 'bullmq';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBullRedisConnection, QUEUE_NAMES, REPO_JOB_NAMES } from '@haive/shared';
import type { RepoJobPayload } from '@haive/shared';
import type { Database } from '@haive/database';

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
  seed: vi.fn(),
  holding: false,
  /** Stand in for the copy and the clone that follow the move. Null runs the real copy; the clone
   *  is never real, and with no stand-in it finishes and leaves nothing. */
  copyFault: null as null | ((src: string, dest: string) => Promise<void>),
  cloneFault: null as null | ((url: string, dest: string) => Promise<void>),
}));
vi.mock('../src/repo/clone.js', async (original) => {
  const real = await original<typeof import('../src/repo/clone.js')>();
  return {
    ...real,
    withRootClaim: async (_db: unknown, _id: string, fn: () => Promise<void>) => fn(),
    persistDetection: h.persist,
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
const row: { status: string; statusMessage?: string; errorCode?: string | null } = {
  status: 'cloning',
};
const db = {
  execute: async () => {},
  transaction: async (fn: (tx: unknown) => unknown) => fn(db),
  query: { tasks: { findMany: async () => (h.holding ? [{ id: 'live' }] : []) } },
  update: () => ({ set: (values: object) => ({ where: async () => Object.assign(row, values) }) }),
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
  row.errorCode = 'stale';
  h.holding = false;
  h.copyFault = null;
  h.cloneFault = null;
  h.seed.mockResolvedValue(undefined);
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
  const dest = path.join(root, 'u1', 'r1');
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
      repositoryId: 'r1',
    } as RepoJobPayload,
  };
}

const remote = {
  source: 'git_https',
  remoteUrl: 'https://git.example.test/r1.git',
  branch: 'main',
  userId: 'u1',
  repositoryId: 'r1',
} as RepoJobPayload;

/** Adds the refresh job the way the route does, with its attempts and a backoff short enough to wait out. */
async function refreshJob(payload: RepoJobPayload): Promise<Job> {
  worker = startRepoWorker(root);
  await worker.waitUntilReady();
  const job = await queue!.add(REPO_JOB_NAMES.REFRESH, payload, {
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
  (await readdir(path.dirname(dest))).filter((entry) => entry.startsWith('r1.aside-'));

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
  it('a dead folder source leaves the checkout where it was, whichever attempt runs', async () => {
    const { source, dest, payload } = await fixture();
    await rm(path.join(source, '.git/objects'), { recursive: true });
    const job = await refreshJob(payload);
    expect(await asides(dest)).toEqual([]);
    expect(await readdir(path.dirname(dest))).toEqual(['r1']);
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
    expect(h.persist).toHaveBeenCalledWith(db, 'r1', dest, expect.any(String), {
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
      'r1',
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
