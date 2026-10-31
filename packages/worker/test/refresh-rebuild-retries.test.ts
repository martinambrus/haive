import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
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
}));
vi.mock('../src/repo/clone.js', async (original) => ({
  ...(await original<typeof import('../src/repo/clone.js')>()),
  withRootClaim: async (_db: unknown, _id: string, fn: () => Promise<void>) => fn(),
  persistDetection: h.persist,
}));
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
const row: { status: string; statusMessage?: string } = { status: 'cloning' };
const db = {
  query: { tasks: { findMany: async () => [] } },
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
  h.seed.mockResolvedValue(undefined);
  h.persist.mockImplementation(async (_db, _id, _dest, note) => {
    row.status = 'ready';
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

describe.skipIf(!redisUrl)('a refresh job with attempts: 3 on a real queue', () => {
  it('a dead folder source leaves the checkout where it was, whichever attempt runs', async () => {
    const { source, dest, payload } = await fixture();
    await rm(path.join(source, '.git/objects'), { recursive: true });
    const job = await refreshJob(payload);
    expect(await asides(dest)).toEqual([]);
    expect(await readdir(path.dirname(dest))).toEqual(['r1']);
    expect(h.persist).not.toHaveBeenCalled();
    expect(row.status).toBe('error');
    expect(row.statusMessage).toMatch(/is not a usable git checkout\. Nothing was moved\.$/);
    expect(await job.getState()).toBe('failed');
  });
});
