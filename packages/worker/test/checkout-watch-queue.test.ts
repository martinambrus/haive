import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { Queue, QueueEvents, type Worker } from 'bullmq';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { createDatabase, schema } from '@haive/database';
import {
  configService,
  createBullRedisConnection,
  PLAN_MIRROR_JOB_NAMES,
  QUEUE_NAMES,
} from '@haive/shared';
import { emptyProjectState, renderProjectState } from '@haive/shared/project-state';

const h = vi.hoisted(() => ({ db: null as unknown, redis: null as unknown }));
vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/redis.js', () => ({ getBullRedis: () => h.redis }));
import * as checkoutQueue from '../src/queues/plan-mirror-queue.js';
const { schedulePlanMirrorSweep, startPlanMirrorWorker, sweepCheckouts } = checkoutQueue;

const url = process.env.T117_DATABASE_URL;
const redisUrl = process.env.T117_REDIS_URL;
// CI owns its default-port service; an explicit URL and scratch name are still required.
if (url && !/^\/codex_t117_[a-z0-9_]+$/.test(new URL(url).pathname))
  throw new Error('exclusive T117 database required');
if (redisUrl && !/^redis:\/\/(?:127\.0\.0\.1|localhost):\d+\/14$/.test(redisUrl))
  throw new Error('dedicated loopback Redis database 14 required');
const db = url ? createDatabase(url) : null;
const connection = redisUrl ? createBullRedisConnection(redisUrl) : null;
h.db = db;
h.redis = connection;
const queue = connection ? new Queue(QUEUE_NAMES.PLAN_MIRROR, { connection }) : null;
const events = connection ? new QueueEvents(QUEUE_NAMES.PLAN_MIRROR, { connection }) : null;
let worker: Worker | null = null;
const users: string[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await worker?.close();
  worker = null;
  if (queue) await queue.obliterate({ force: true });
  for (const id of users.splice(0)) await db!.delete(schema.users).where(eq(schema.users.id, id));
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});
afterAll(async () => {
  await events?.close();
  await queue?.close();
  await connection?.quit();
  await db?.$client.end({ timeout: 5 });
});

describe.skipIf(!url || !redisUrl)('real checkout scheduler and worker queue', () => {
  it('observes the branch for a reset without record import or its admission locks', async () => {
    vi.spyOn(configService, 'getBoolean').mockRejectedValue(new Error('must not read sync config'));
    const root = await mkdtemp(join(tmpdir(), 'k1-reset-observe-'));
    dirs.push(root);
    execFileSync('git', ['init', '-q', '-b', 'feature-x'], { cwd: root });
    execFileSync(
      'git',
      [
        '-c',
        'user.name=fixture',
        '-c',
        'user.email=fixture@local',
        'commit',
        '--allow-empty',
        '-qm',
        'initial',
      ],
      { cwd: root },
    );
    // An unreadable record and an active reset hold the full sync, but not branch observation.
    await mkdir(join(root, '.haive-data/state'), { recursive: true });
    await writeFile(join(root, '.haive-data/state/format.json'), 'invalid');
    const userId = randomUUID();
    users.push(userId);
    await db!.insert(schema.users).values({
      id: userId,
      emailEncrypted: 'fixture',
      emailBlindIndex: userId,
      passwordHash: 'fixture',
    });
    const [repo] = await db!
      .insert(schema.repositories)
      .values({
        userId,
        source: 'blank',
        name: 'reset observation',
        storagePath: root,
        checkoutBranch: 'main',
        rootClaimedAt: new Date(),
        rootClaimKind: 'reset',
      })
      .returning();
    await events!.waitUntilReady();
    worker = startPlanMirrorWorker();
    const job = await queue!.add(
      PLAN_MIRROR_JOB_NAMES.OBSERVE_CHECKOUT_BRANCH,
      {
        repositoryId: repo!.id,
        userId,
      },
      { jobId: `reset-checkout-${randomUUID()}`, removeOnComplete: true },
    );

    expect(await job.waitUntilFinished(events!, 5_000)).toEqual({ branch: 'feature-x' });
    expect(
      (await db!.select().from(schema.repositories).where(eq(schema.repositories.id, repo!.id)))[0],
    ).toMatchObject({ checkoutBranch: 'feature-x', renderContext: null });
    expect(
      await db!
        .select()
        .from(schema.projectStateSync)
        .where(eq(schema.projectStateSync.repositoryId, repo!.id)),
    ).toEqual([]);
    expect(await readFile(join(root, '.haive-data/state/format.json'), 'utf8')).toBe('invalid');
    expect(configService.getBoolean).not.toHaveBeenCalled();
  });
  it('retains the 10s writer scheduler and registers a 60s checkout backstop', async () => {
    await schedulePlanMirrorSweep();
    const schedulers = await queue!.getJobSchedulers(0, -1, true);
    expect(schedulers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: PLAN_MIRROR_JOB_NAMES.SWEEP, every: 10000 }),
        expect.objectContaining({ name: 'sweep-checkouts', every: 60000 }),
      ]),
    );
  });
  it('deduplicates per-repository hints, executes the real observer, and admits another hint after completion', async () => {
    vi.spyOn(configService, 'getBoolean').mockResolvedValue(true);
    const root = await mkdtemp(join(tmpdir(), 't117-queue-'));
    dirs.push(root);
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: 'fixture',
      GIT_AUTHOR_EMAIL: 'fixture@local',
      GIT_COMMITTER_NAME: 'fixture',
      GIT_COMMITTER_EMAIL: 'fixture@local',
    };
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
    for (const [rel, text] of renderProjectState({
      ...emptyProjectState(),
      render: {
        projectInfo: { name: 'queued checkout' },
        framework: null,
        acceptedAgentIds: [],
        customAgentSpecs: [],
        lspLanguages: [],
      },
    })) {
      const path = join(root, '.haive-data/state', rel);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, text);
    }
    execFileSync('git', ['add', '-A'], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'record'], { cwd: root, env });
    const id = randomUUID();
    users.push(id);
    await db!
      .insert(schema.users)
      .values({ id, emailEncrypted: 'fixture', emailBlindIndex: id, passwordHash: 'fixture' });
    const [repo] = await db!
      .insert(schema.repositories)
      .values({ userId: id, source: 'blank', name: 'queued', storagePath: root })
      .returning();
    await sweepCheckouts();
    await sweepCheckouts();
    const jobs = await queue!.getJobs(['waiting', 'active', 'delayed']);
    expect(jobs.filter((job) => job.data.repositoryId === repo!.id)).toHaveLength(1);
    const job = jobs.find((job) => job.data.repositoryId === repo!.id)!;
    expect(job.name).toBe('sync-checkout');
    await events!.waitUntilReady();
    worker = startPlanMirrorWorker();
    expect(await job.waitUntilFinished(events!, 20_000)).toBe('synced');
    await worker.close();
    worker = null;
    expect(
      (await db!.select().from(schema.repositories).where(eq(schema.repositories.id, repo!.id)))[0]
        ?.renderContext,
    ).toMatchObject({ projectInfo: { name: 'queued checkout' } });
    expect(await queue!.getJob(job.id!)).toBeUndefined();
    await sweepCheckouts();
    expect(await queue!.getJob(job.id!)).toBeTruthy();
    vi.mocked(configService.getBoolean).mockResolvedValue(false);
    worker = startPlanMirrorWorker();
    const queued = await queue!.getJob(job.id!);
    expect(await queued!.waitUntilFinished(events!, 20_000)).toBe('disabled');
  });
});
