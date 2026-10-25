/** Explicit, isolated PostgreSQL/Redis fixtures only. No provider or remote Git is contacted.
 * --serve keeps the real API and seeded onboarding form available for a browser check. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

  async function exerciseCappedSnapshot(
    bundleId: string,
    url: string,
    zipSource?: string,
  ): Promise<void> {
    await db
      .update(schema.customBundles)
      .set({ status: 'failed' })
      .where(eq(schema.customBundles.id, bundleId));
    const before = await db.query.customBundles.findFirst({
      where: eq(schema.customBundles.id, bundleId),
    });
    const marker = zipSource
      ? path.join(path.dirname(zipSource), 'extracted', 'keep.md')
      : undefined;
    if (marker) {
      await mkdir(path.dirname(marker), { recursive: true });
      await writeFile(marker, 'a live ingest still owns this tree');
    }
    const sourceBytes = zipSource ? await readFile(zipSource) : undefined;
    // FIFO insertion puts the target outside the newest1000 waiting jobs. All jobs are owned
    // fixture jobs and no consumer runs on this isolated Redis database.
    const target = await queue.add('fixture-old-anonymous-ingest', { bundleId, userId });
    await queue.addBulk(
      Array.from({ length: 1000 }, () => ({
        name: 'fixture-unrelated',
        data: { bundleId: randomUUID(), userId },
      })),
    );
    const states = ['waiting', 'active', 'delayed', 'prioritized', 'waiting-children'] as const;
    const initialIds = await queue.getRanges([...states], 0, 999);
    assert.equal(initialIds.length, 1000);
    assert(!initialIds.includes(target.id!));
    const originalGetJob = queue.getJob.bind(queue);
    const originalGetJobs = queue.getJobs.bind(queue);
    const originalGetRanges = queue.getRanges.bind(queue);
    let removedId: string | undefined;
    let capturedIds: string[] = [];
    let hydratedCount: number | null = null;
    const deleteSelected = async (id: string): Promise<void> => {
      if (removedId) return;
      removedId = id;
      const victim = await originalGetJob(id);
      assert(victim && victim.id !== target.id);
      await victim.remove();
    };
    // On1641 this is the gate between the real Lua snapshot and getJobs' re-hydration.
    queue.getJob = async (id) => {
      if (!initialIds.includes(id)) return originalGetJob(id);
      capturedIds.push(id);
      await deleteSelected(id);
      return originalGetJob(id);
    };
    queue.getJobs = async (...args) => {
      const jobs = await originalGetJobs(...args);
      hydratedCount = jobs.length;
      return jobs;
    };
    // The corrected reader uses the public unhydrated range API. Delete after its same atomic
    // snapshot too: the retained ID count must remain capped even when a selected hash vanishes.
    queue.getRanges = async (...args) => {
      const ids = await originalGetRanges(...args);
      capturedIds = ids;
      await deleteSelected(ids[0]!);
      return ids;
    };
    try {
      const response = await post(url);
      const after = await db.query.customBundles.findFirst({
        where: eq(schema.customBundles.id, bundleId),
      });
      const treePreserved = marker
        ? await readFile(marker, 'utf8').then(
            (body) => body === 'a live ingest still owns this tree',
            () => false,
          )
        : null;
      console.info(
        JSON.stringify({
          check: zipSource ? 'replace capped snapshot' : 'sync capped snapshot',
          status: response.status,
          capturedIds: capturedIds.length,
          hydratedCount,
          removedSelectedJob: Boolean(removedId),
          targetStillLive: await target.getState(),
          sourceUnchanged: after?.archivePath === before?.archivePath,
          treePreserved,
        }),
      );
      assert(
        removedId,
        'the selected unrelated job must actually be removed at the snapshot/hydration boundary',
      );
      assert.equal(
        response.status,
        503,
        'a capped snapshot cannot become complete when hydration drops a job',
      );
      assert.deepEqual(
        await db.query.customBundles.findFirst({ where: eq(schema.customBundles.id, bundleId) }),
        before,
      );
      assert.equal(await target.getState(), 'waiting');
      if (zipSource && marker) {
        assert.deepEqual(await readFile(zipSource), sourceBytes);
        assert.equal(await readFile(marker, 'utf8'), 'a live ingest still owns this tree');
      }
    } finally {
      queue.getJob = originalGetJob;
      queue.getJobs = originalGetJobs;
      queue.getRanges = originalGetRanges;
      const owned = (await queue.getJobs(['waiting'])).filter((job) => job.data.userId === userId);
      for (const job of owned) await job.remove();
      assert.equal(
        (await queue.getJobs(['waiting'])).filter((job) => job.data.userId === userId).length,
        0,
      );
      console.info(
        `CLEANED capped-snapshot fixture: target plus1000 unrelated jobs; removed selected job=${Boolean(removedId)}`,
      );
    }
  }
  if (process.env.HAIVE_TEST_CAP_CASE !== 'replace') {
    await exerciseCappedSnapshot(git.id, `/bundles/${git.id}/sync`);
  }
  if (process.env.HAIVE_TEST_CAP_CASE !== 'sync') {
    const replacementInit = await post(`/bundles/${zip.id}/replace/init`, {
      filename: 'later.zip',
      totalSize: 7,
      chunkSize: 7,
    });
    const replacementSession = ((await replacementInit.json()) as { session: { id: string } })
      .session;
    assert.equal(replacementInit.status, 201);
    assert.equal(
      (
        await app.request(`/bundles/uploads/${replacementSession.id}/chunk`, {
          method: 'PUT',
          headers: {
            cookie: `haive_access=${token}`,
            origin: webOrigin,
            'content-range': 'bytes 0-6/7',
          },
          body: 'LATER!!',
        })
      ).status,
      200,
    );
    const currentZip = await db.query.customBundles.findFirst({
      where: eq(schema.customBundles.id, zip.id),
    });
    assert(currentZip?.archivePath);
    await exerciseCappedSnapshot(
      zip.id,
      `/bundles/${zip.id}/replace/${replacementSession.id}/complete`,
      currentZip.archivePath,
    );
  }

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
