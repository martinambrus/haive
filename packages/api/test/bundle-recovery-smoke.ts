/** Explicit, isolated PostgreSQL/Redis fixtures only. No provider or remote Git is contacted.
 * --serve keeps the real API and seeded onboarding form available for a browser check. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { serve } from '@hono/node-server';
import { eq } from 'drizzle-orm';
import { Queue, Worker } from 'bullmq';
import { schema } from '@haive/database';
import { configService, secretsService, userSecretsService, QUEUE_NAMES } from '@haive/shared';
import { encryptEmail } from '@haive/shared/crypto';
import { initDatabase } from '../src/db.js';
import { initRedis, closeRedis } from '../src/redis.js';
import { getBundleQueue, getRepoQueue, closeQueues } from '../src/queues.js';
import { createApiApp } from '../src/index.js';
import { signAccessToken } from '../src/auth/jwt.js';
// Runtime imports keep the API package's typecheck rooted in the API; this fixture exercises
// both services together without introducing a production package dependency.
const workerRedisModule = new URL('../../worker/src/redis.js', import.meta.url).href;
const workerQueueModule = new URL('../../worker/src/queues/bundle-queue.js', import.meta.url).href;
const workerRecoveryModule = new URL('../../worker/src/data-migrations.js', import.meta.url).href;
const { initRedis: initWorkerRedis, closeRedis: closeWorkerRedis } = await import(
  workerRedisModule
);
const { startBundleWorker } = await import(workerQueueModule);
const { reconcileStrandedCloningRepos } = await import(workerRecoveryModule);

const databaseUrl = process.env.HAIVE_TEST_DATABASE_URL;
const redisUrl = process.env.HAIVE_TEST_REDIS_URL;
assert(
  databaseUrl && redisUrl,
  'HAIVE_TEST_DATABASE_URL and HAIVE_TEST_REDIS_URL must name exclusive fixtures',
);
assert(new URL(databaseUrl).pathname !== '/haive', 'the development database is forbidden');
assert(
  new URL(redisUrl).pathname !== '' && new URL(redisUrl).pathname !== '/0',
  'select an exclusive Redis DB',
);
const db = initDatabase(databaseUrl);
const storage = await mkdtemp(path.join(tmpdir(), 'bundle-recovery-'));
process.env.BUNDLE_STORAGE_ROOT = storage;
const apiPort = Number(process.env.HAIVE_TEST_API_PORT ?? '46116');
const webOrigin = process.env.HAIVE_TEST_WEB_ORIGIN ?? 'http://127.0.0.1:46117';
const userId = randomUUID();
let server: ReturnType<typeof serve> | undefined;
let worker: import('bullmq').Worker | undefined;

try {
  const { bullRedis: fixtureConnection } = initRedis(redisUrl);
  initWorkerRedis(redisUrl);
  await configService.initialize(redisUrl);
  await secretsService.initialize(db);
  await userSecretsService.initialize(db, await secretsService.getMasterKek());
  await db.insert(schema.users).values({
    id: userId,
    emailEncrypted: encryptEmail(
      'bundle-recovery@test.local',
      await configService.getEncryptionKey(),
    ),
    emailBlindIndex: randomUUID(),
    passwordHash: 'fixture-only',
    role: 'user',
    status: 'active',
  });
  const [repo] = await db
    .insert(schema.repositories)
    .values({
      userId,
      name: 'Bundle recovery fixture',
      source: 'local_path',
      localPath: storage,
      storagePath: storage,
      status: 'ready',
    })
    .returning();
  assert(repo);
  const token = await signAccessToken({ sub: userId, role: 'user', tv: 0 });
  const app = createApiApp(webOrigin);
  const post = (url: string, body?: unknown) =>
    app.request(url, {
      method: 'POST',
      headers: {
        cookie: `haive_access=${token}`,
        origin: webOrigin,
        'content-type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const [git] = await db
    .insert(schema.customBundles)
    .values({
      userId,
      repositoryId: repo.id,
      name: 'Git fixture',
      sourceType: 'git',
      gitUrl: 'https://example.invalid/never-contacted',
      storageRoot: storage,
      status: 'active',
    })
    .returning();
  assert(git);
  const concurrent = await Promise.all(
    Array.from({ length: 8 }, () => post(`/bundles/${git.id}/sync`)),
  );
  assert.deepEqual(
    concurrent.map((r) => r.status).sort(),
    [200, 409, 409, 409, 409, 409, 409, 409],
  );
  const queue = getBundleQueue();
  const jobs = await queue.getJobs(['waiting', 'active', 'delayed', 'prioritized']);
  assert.equal(jobs.filter((j) => j.data.bundleId === git.id).length, 1);
  console.info(
    'PASS actual sync route: eight concurrent PostgreSQL admissions create one Redis job',
  );
  for (const job of jobs) await job.remove();
  // A failed sync is retryable; its previous historical failed job cannot lock it out.
  await db
    .update(schema.customBundles)
    .set({ status: 'failed' })
    .where(eq(schema.customBundles.id, git.id));
  assert.equal((await post(`/bundles/${git.id}/sync`)).status, 200);
  for (const job of await queue.getJobs(['waiting'])) await job.remove();

  // Failure injection happens after the real Redis command commits, before its acknowledgement.
  await db
    .update(schema.customBundles)
    .set({ status: 'active' })
    .where(eq(schema.customBundles.id, git.id));
  const originalAdd = queue.add.bind(queue);
  queue.add = async (name, data, opts) => {
    await originalAdd(name, data, opts);
    throw new Error('fixture: Redis accepted the job but its acknowledgement was lost');
  };
  try {
    assert.equal((await post(`/bundles/${git.id}/sync`)).status, 500);
  } finally {
    queue.add = originalAdd;
  }
  const beforeRetry = await db.query.customBundles.findFirst({
    where: eq(schema.customBundles.id, git.id),
  });
  assert.equal((await post(`/bundles/${git.id}/sync`)).status, 409);
  const afterRetry = await db.query.customBundles.findFirst({
    where: eq(schema.customBundles.id, git.id),
  });
  assert.deepEqual(
    afterRetry,
    beforeRetry,
    'a refused duplicate cannot overwrite another admission state',
  );
  const acknowledgedJobs = (await queue.getJobs(['waiting'])).filter(
    (job) => job.data.bundleId === git.id,
  );
  assert.equal(acknowledgedJobs.length, 1);
  for (const job of acknowledgedJobs) await job.remove();
  console.info(
    'PASS actual Redis acknowledgement-loss injection: retry refuses the existing anonymous live job without changing its state',
  );

  const old = new Date(Date.now() - 20 * 60_000);
  const rows = await db
    .insert(schema.repositories)
    .values([
      {
        userId,
        name: 'stranded',
        source: 'upload' as const,
        status: 'cloning' as const,
        updatedAt: old,
      },
      {
        userId,
        name: 'queued',
        source: 'upload' as const,
        status: 'cloning' as const,
        updatedAt: old,
      },
      { userId, name: 'fresh', source: 'upload' as const, status: 'cloning' as const },
      {
        userId,
        name: 'claimed',
        source: 'upload' as const,
        status: 'cloning' as const,
        updatedAt: old,
        rootClaimedAt: new Date(),
        rootClaimOwner: randomUUID(),
        rootClaimKind: 'rebuild',
      },
    ])
    .returning();
  const queued = await getRepoQueue().add('fixture-never-consumed', { repositoryId: rows[1]!.id });
  await reconcileStrandedCloningRepos(db);
  await reconcileStrandedCloningRepos(db);
  const statuses = await Promise.all(
    rows.map((row) =>
      db.query.repositories.findFirst({ where: eq(schema.repositories.id, row.id) }),
    ),
  );
  assert.deepEqual(
    statuses.map((r) => r?.status),
    ['error', 'cloning', 'cloning', 'cloning'],
  );
  await queued.remove();
  console.info(
    'PASS actual recovery: only old, unclaimed repository without a live queue job fails; second pass is idempotent',
  );

  await queue.pause();
  worker = startBundleWorker(storage);
  assert(worker);
  await worker.waitUntilReady();
  assert.equal(worker.opts.concurrency, 2);
  assert.equal(worker.opts.maxStalledCount, 10);
  console.info(
    `PASS actual bundle Worker options: concurrency=${worker.opts.concurrency}, maxStalledCount=${worker.opts.maxStalledCount}`,
  );
  const stallQueue = new Queue(`bundle-stall-fixture-${randomUUID()}`, {
    connection: fixtureConnection,
  });
  const stallWorker = new Worker(stallQueue.name, undefined, {
    connection: fixtureConnection,
    autorun: false,
    maxStalledCount: worker.opts.maxStalledCount,
    stalledInterval: 1,
  });
  try {
    const stalledJob = await stallQueue.add('fixture', {});
    assert(stalledJob.id);
    for (let count = 1; count <= 11; count += 1) {
      assert(await stallWorker.getNextJob('fixture-token', { block: false }));
      await fixtureConnection.del(stallQueue.toKey(`${stalledJob.id}:lock`));
      await fixtureConnection.sadd(stallQueue.toKey('stalled'), stalledJob.id);
      await fixtureConnection.del(stallQueue.toKey('stalled-check'));
      await (
        stallWorker as unknown as { moveStalledJobsToWait(): Promise<void> }
      ).moveStalledJobsToWait();
      const reason = await fixtureConnection.hget(stallQueue.toKey(stalledJob.id), 'defa');
      if (count <= 10) assert.equal(reason, null);
      else assert.equal(reason, 'job stalled more than allowable limit');
    }
    console.info(
      'PASS real BullMQ stall recovery using actual bundle options: ten stalls allowed, eleventh records deferred failure',
    );
  } finally {
    await stallWorker.close();
    await stallQueue.obliterate({ force: true });
    await stallQueue.close();
  }
  await worker.close();
  worker = undefined;
  await queue.resume();

  const [zip] = await db
    .insert(schema.customBundles)
    .values({
      userId,
      repositoryId: repo.id,
      name: 'ZIP fixture',
      sourceType: 'zip',
      archiveFilename: 'old.zip',
      archiveFormat: 'zip',
      archivePath: path.join(storage, 'old.zip'),
      storageRoot: storage,
      status: 'active',
    })
    .returning();
  assert(zip);
  const init = await post(`/bundles/${zip.id}/replace/init`, {
    filename: 'new.zip',
    totalSize: 7,
    chunkSize: 7,
  });
  assert.equal(init.status, 201);
  const { session } = (await init.json()) as { session: { id: string } };
  const chunk = await app.request(`/bundles/uploads/${session.id}/chunk`, {
    method: 'PUT',
    headers: { cookie: `haive_access=${token}`, origin: webOrigin, 'content-range': 'bytes 0-6/7' },
    body: 'ARCHIVE',
  });
  assert.equal(chunk.status, 200);
  const completeUrl = `/bundles/${zip.id}/replace/${session.id}/complete`;
  const completions = await Promise.all([post(completeUrl), post(completeUrl)]);
  assert(completions.some((r) => r.status === 200));
  assert(completions.every((r) => r.status === 200 || r.status === 409));
  assert.equal((await post(completeUrl)).status, 200);
  const zipJobs = (await queue.getJobs(['waiting'])).filter((j) => j.data.bundleId === zip.id);
  assert.equal(zipJobs.length, 1);
  for (const job of zipJobs) await job.remove();
  console.info(
    'PASS actual init/chunk/complete routes: concurrent completion and duplicate response retain one ingest job',
  );

  if (process.argv.includes('--serve')) {
    await db
      .update(schema.customBundles)
      .set({ status: 'syncing' })
      .where(eq(schema.customBundles.id, git.id));
    const [task] = await db
      .insert(schema.tasks)
      .values({
        userId,
        repositoryId: repo.id,
        type: 'onboarding',
        title: 'Bundle recovery browser fixture',
        status: 'waiting_user',
        currentStepId: '06_3-custom-bundles',
        runListSnapshot: ['06_3-custom-bundles'],
      })
      .returning();
    assert(task);
    await db.insert(schema.taskSteps).values({
      taskId: task.id,
      stepId: '06_3-custom-bundles',
      stepIndex: 0,
      runSeq: 0,
      title: 'Custom bundles',
      status: 'waiting_form',
      waitingStartedAt: new Date(),
      formSchema: {
        title: 'Custom bundles',
        fields: [
          {
            name: 'bundles',
            type: 'bundle-composer',
            label: 'Bundles',
            required: false,
            initialBundles: [],
            allowAddZip: true,
            allowAddGit: true,
            credentialOptions: [],
          },
        ],
      },
    });
    server = serve({ fetch: app.fetch, port: apiPort, hostname: '127.0.0.1' });
    const metadata = process.env.HAIVE_TEST_BROWSER_METADATA;
    assert(metadata, 'HAIVE_TEST_BROWSER_METADATA must be outside the worktree');
    await writeFile(
      metadata,
      JSON.stringify({
        token,
        taskId: task.id,
        bundleId: git.id,
        zipId: zip.id,
        userId,
        repoId: repo.id,
      }),
      { mode: 0o600 },
    );
    console.info(
      `READY real API on 127.0.0.1:${apiPort}; task ${task.id}; queue ${QUEUE_NAMES.BUNDLE}`,
    );
    await new Promise<void>((resolve) => {
      process.once('SIGTERM', resolve);
      process.once('SIGINT', resolve);
    });
  }
} finally {
  await worker?.close();
  if (server)
    await new Promise<void>((resolve, reject) =>
      server!.close((err) => (err ? reject(err) : resolve())),
    );
  for (const queue of [getBundleQueue(), getRepoQueue()]) {
    for (const job of await queue.getJobs(['waiting', 'delayed', 'failed', 'completed'])) {
      if (job.data.userId === userId || job.name === 'fixture-never-consumed') await job.remove();
    }
  }
  await db.delete(schema.users).where(eq(schema.users.id, userId));
  await getBundleQueue().resume();
  await closeQueues();
  await closeRedis();
  await closeWorkerRedis();
  await configService.close();
  await db.$client.end({ timeout: 5 });
  await rm(storage, { recursive: true, force: true });
  console.info(
    'CLEANED owned fixture rows, archive tree, queues, Redis connections and API listener',
  );
}
