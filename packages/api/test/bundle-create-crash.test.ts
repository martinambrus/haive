import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const USER = vi.hoisted(() => '00000000-0000-4000-8000-0000000000a1');
const h = vi.hoisted(() => ({
  db: undefined as unknown,
  queue: undefined as unknown,
  beforeRemove: null as null | ((rel: string) => void),
  beforeRename: null as null | (() => void | Promise<void>),
}));

vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/queues.js', () => ({ getBundleQueue: () => h.queue }));
vi.mock('../src/middleware/auth.js', () => ({
  requireAuth: async (c: { set: (key: string, value: string) => void }, next: () => unknown) => {
    c.set('userId', USER);
    await next();
  },
}));
vi.mock('@haive/shared/fs-safe', async (importOriginal) => {
  const real = await importOriginal<typeof import('@haive/shared/fs-safe')>();
  return {
    ...real,
    removeNoFollow: (...args: Parameters<typeof real.removeNoFollow>) => {
      h.beforeRemove?.(args[1]);
      return real.removeNoFollow(...args);
    },
    renameNoFollow: async (...args: Parameters<typeof real.renameNoFollow>) => {
      await h.beforeRename?.();
      return real.renameNoFollow(...args);
    },
  };
});

import { Hono } from 'hono';
import { schema } from '@haive/database';
import { createFakeDb, type FakeDbHandle, type FakeRow } from '@haive/database/testing';
import { BUNDLE_JOB_NAMES, logger } from '@haive/shared';
import { bundleRoutes } from '../src/routes/bundles.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';

const REPO = '00000000-0000-4000-8000-0000000000f1';
const SESSION = '00000000-0000-4000-8000-0000000000b1';
const REPLACE = '00000000-0000-4000-8000-0000000000b2';
const BUNDLE = '00000000-0000-4000-8000-0000000000c1';

const app = new Hono<AppEnv>();
app.route('/', bundleRoutes);
app.onError(errorHandler);

interface FakeJob {
  id: string;
  name: string;
  data: Record<string, unknown>;
}

function makeQueue() {
  const jobs: FakeJob[] = [];
  const state = { refuse: null as Error | null, onAdd: null as null | (() => void) };
  return {
    jobs,
    state,
    add: async (name: string, data: Record<string, unknown>, opts: { jobId?: string } = {}) => {
      state.onAdd?.();
      if (state.refuse) throw state.refuse;
      const id = opts.jobId ?? `n${jobs.length + 1}`;
      const known = jobs.find((j) => j.id === id);
      if (known) return known;
      const job = { id, name, data };
      jobs.push(job);
      return job;
    },
    getJob: async (id: string) => jobs.find((j) => j.id === id),
  };
}

function makeFake() {
  return createFakeDb({
    repositories: schema.repositories,
    customBundles: schema.customBundles,
    customBundleUploads: schema.customBundleUploads,
    projectStateOutbox: schema.projectStateOutbox,
  });
}

let storage: string;
let saved: string | undefined;
let fake: ReturnType<typeof makeFake>;
let queue: ReturnType<typeof makeQueue>;

function setup() {
  const db = makeFake();
  db.insert(schema.repositories, { id: REPO, userId: USER, name: 'repo', status: 'ready' });
  const noRows = (): unknown => {
    const query: Record<string, unknown> = {};
    for (const method of ['where', 'groupBy']) query[method] = () => query;
    query.then = (ok: (rows: unknown[]) => unknown, bad: (err: unknown) => unknown) =>
      Promise.resolve([]).then(ok, bad);
    return query;
  };
  const stamped = (handle: FakeDbHandle): FakeDbHandle => ({
    ...handle,
    insert: (table) => ({
      values: (values) =>
        handle
          .insert(table)
          .values(
            table === schema.customBundles
              ? { updatedAt: new Date(), ...(values as FakeRow) }
              : values,
          ),
    }),
    transaction: (fn) => handle.transaction((tx) => fn(stamped(tx))),
  });
  h.db = {
    ...stamped(db.db as unknown as FakeDbHandle),
    select: (fields?: Record<string, unknown>) => ({
      from: (table: unknown) =>
        table === schema.customBundleItems ? noRows() : db.db.select(fields).from(table as never),
    }),
  };
  return db;
}

beforeEach(async () => {
  vi.spyOn(logger, 'error').mockImplementation(() => undefined);
  storage = await mkdtemp(path.join(tmpdir(), 'bundle-crash-'));
  saved = process.env.BUNDLE_STORAGE_ROOT;
  process.env.BUNDLE_STORAGE_ROOT = storage;
  fake = setup();
  queue = makeQueue();
  h.queue = queue;
});

afterEach(async () => {
  vi.restoreAllMocks();
  h.beforeRemove = null;
  h.beforeRename = null;
  if (saved === undefined) delete process.env.BUNDLE_STORAGE_ROOT;
  else process.env.BUNDLE_STORAGE_ROOT = saved;
  await rm(storage, { recursive: true, force: true });
});

const post = async (url: string, body?: unknown) =>
  app.request(
    url,
    body === undefined
      ? { method: 'POST' }
      : {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        },
  );
const complete = (id: string) => post(`/uploads/${id}/complete`);

function expect2xx(res: Response) {
  expect(res.status).toBeGreaterThanOrEqual(200);
  expect(res.status).toBeLessThan(300);
}

const partialOf = (id: string) => path.join(storage, '_uploads', USER, `${id}.zip.partial`);
const bundleDir = (id: string) => path.join(storage, USER, id);
const ingestJobs = () => queue.jobs.filter((j) => j.name === BUNDLE_JOB_NAMES.INGEST_ZIP);

async function stage(id: string, content: string, over: Record<string, unknown> = {}) {
  await mkdir(path.dirname(partialOf(id)), { recursive: true });
  await writeFile(partialOf(id), content);
  const size = Buffer.byteLength(content);
  fake.insert(schema.customBundleUploads, {
    id,
    userId: USER,
    repositoryId: REPO,
    name: 'kit',
    enabledKinds: ['agent', 'skill'],
    filename: 'kit.zip',
    archiveFormat: 'zip',
    totalSize: size,
    bytesReceived: size,
    chunkSize: size,
    archivePath: partialOf(id),
    status: 'uploading',
    updatedAt: new Date(),
    ...over,
  });
}

async function seedZipBundle(): Promise<string> {
  const dir = bundleDir(BUNDLE);
  await mkdir(path.join(dir, 'extracted'), { recursive: true });
  await writeFile(path.join(dir, 'source.zip'), 'OLD-ARCHIVE');
  await writeFile(path.join(dir, 'extracted', 'old.md'), 'old');
  fake.insert(schema.customBundles, {
    id: BUNDLE,
    userId: USER,
    repositoryId: REPO,
    name: 'kit',
    sourceType: 'zip',
    archiveFilename: 'kit.zip',
    archiveFormat: 'zip',
    archivePath: path.join(dir, 'source.zip'),
    storageRoot: path.join(dir, 'extracted'),
    enabledKinds: ['agent', 'skill'],
    status: 'active',
    updatedAt: new Date(),
  });
  return dir;
}

function seedGitBundle() {
  fake.insert(schema.customBundles, {
    id: BUNDLE,
    userId: USER,
    repositoryId: REPO,
    name: 'kit',
    sourceType: 'git',
    gitUrl: 'https://example.com/kit.git',
    gitBranch: 'main',
    storageRoot: path.join(bundleDir(BUNDLE), 'extracted'),
    enabledKinds: ['agent', 'skill'],
    status: 'active',
    updatedAt: new Date(),
  });
}

describe('C1: a fault right after the zip bundle insert commits', () => {
  it('leaves one bundle with the upload id, and one job, once complete is retried', async () => {
    await stage(SESSION, 'zip bytes');
    let phase: 'waiting' | 'armed' | 'spent' = 'waiting';
    fake.hooks.beforeCommit = () => {
      if (phase === 'waiting') phase = 'armed';
    };
    fake.hooks.beforeUpdate = () => {
      if (phase !== 'armed') return;
      phase = 'spent';
      throw new Error('the process died here');
    };

    expect((await complete(SESSION)).status).toBe(500);
    expect(fake.rows(schema.customBundleUploads)[0]).toMatchObject({ status: 'uploading' });
    expect2xx(await complete(SESSION));

    expect(fake.rows(schema.customBundles).map((r) => r.id)).toEqual([SESSION]);
    expect(ingestJobs()).toHaveLength(1);
    expect(fake.rows(schema.customBundleUploads)[0]).toMatchObject({
      status: 'complete',
      bundleId: SESSION,
    });
  });

  it('keeps the bundle when the archive move fails once, and the retry finishes it', async () => {
    await stage(SESSION, 'zip bytes');
    let failures = 1;
    h.beforeRename = () => {
      if (failures-- > 0) throw new Error('the move failed');
    };

    expect((await complete(SESSION)).status).toBe(500);
    expect2xx(await complete(SESSION));

    expect(fake.rows(schema.customBundles).map((r) => r.id)).toEqual([SESSION]);
    expect(ingestJobs()).toHaveLength(1);
    expect(await readFile(path.join(bundleDir(SESSION), 'source.zip'), 'utf8')).toBe('zip bytes');
  });

  it('treats the move as done when another call has just made it', async () => {
    await stage(SESSION, 'zip bytes');
    h.beforeRename = async () => {
      await mkdir(bundleDir(SESSION), { recursive: true });
      await rename(partialOf(SESSION), path.join(bundleDir(SESSION), 'source.zip'));
    };

    expect((await complete(SESSION)).status).toBe(201);

    expect(fake.rows(schema.customBundles).map((r) => r.id)).toEqual([SESSION]);
    expect(ingestJobs()).toHaveLength(1);
  });

  it('commits the bundle row and the upload link together, or neither', async () => {
    await stage(SESSION, 'zip bytes');
    let uploadWrites = 0;
    fake.hooks.beforeUpdate = (table) => {
      // The first write to the upload row is the claim; the one that fails is the link.
      if (table === schema.customBundleUploads && (uploadWrites += 1) === 2) {
        throw new Error('the link write failed');
      }
    };

    expect((await complete(SESSION)).status).toBe(500);

    expect(fake.rows(schema.customBundles)).toEqual([]);
    expect(queue.jobs).toHaveLength(0);
    expect(fake.rows(schema.customBundleUploads)[0]).toMatchObject({ status: 'uploading' });

    fake.hooks.beforeUpdate = null;
    expect2xx(await complete(SESSION));
    expect(fake.rows(schema.customBundles).map((r) => r.id)).toEqual([SESSION]);
  });

  it('finishes a complete whose archive was moved and whose job was never queued', async () => {
    await stage(SESSION, 'zip bytes');
    const final = path.join(bundleDir(SESSION), 'source.zip');
    await mkdir(bundleDir(SESSION), { recursive: true });
    await rename(partialOf(SESSION), final);
    fake.insert(schema.customBundles, {
      id: SESSION,
      userId: USER,
      repositoryId: REPO,
      name: 'kit',
      sourceType: 'zip',
      archiveFilename: 'kit.zip',
      archiveFormat: 'zip',
      archivePath: final,
      storageRoot: path.join(bundleDir(SESSION), 'extracted'),
      enabledKinds: ['agent', 'skill'],
      status: 'syncing',
      updatedAt: new Date(Date.now() - 10 * 60_000),
    });
    fake.patch(schema.customBundleUploads, SESSION, { bundleId: SESSION });

    expect2xx(await complete(SESSION));

    const stored = fake.rows(schema.customBundles);
    expect(stored).toHaveLength(1);
    expect((stored[0]!.updatedAt as Date).getTime()).toBeGreaterThan(Date.now() - 60_000);
    expect(ingestJobs()).toHaveLength(1);
    expect(fake.rows(schema.customBundleUploads)[0]).toMatchObject({ status: 'complete' });
  });
});

describe('C2: completing an upload twice', () => {
  it('answers 2xx both times, with the same bundle', async () => {
    await stage(SESSION, 'zip bytes');

    const first = await complete(SESSION);
    const second = await complete(SESSION);

    expect2xx(first);
    expect2xx(second);
    const a = (await first.json()) as { bundle: { id: string } };
    const b = (await second.json()) as { bundle: { id: string } };
    expect(b.bundle.id).toBe(a.bundle.id);
    expect(fake.rows(schema.customBundles)).toHaveLength(1);
    expect(ingestJobs()).toHaveLength(1);
  });

  it('answers 400 for an upload that replaces a bundle archive, and creates no bundle', async () => {
    await seedZipBundle();
    await stage(REPLACE, 'new archive', { bundleId: BUNDLE });

    expect((await complete(REPLACE)).status).toBe(400);

    expect(fake.rows(schema.customBundles).map((r) => r.id)).toEqual([BUNDLE]);
    expect(queue.jobs).toHaveLength(0);
  });
});

describe('C3: the queue refuses the job', () => {
  const sites: Array<[string, () => Promise<Response>]> = [
    [
      'git create',
      () =>
        post('/', {
          repositoryId: REPO,
          name: 'kit',
          gitUrl: 'https://example.com/kit.git',
          enabledKinds: ['agent', 'skill'],
        }),
    ],
    [
      'zip complete',
      async () => {
        await stage(SESSION, 'zip bytes');
        return complete(SESSION);
      },
    ],
    [
      'replace complete',
      async () => {
        await seedZipBundle();
        await stage(REPLACE, 'new archive', { bundleId: BUNDLE });
        return post(`/${BUNDLE}/replace/${REPLACE}/complete`);
      },
    ],
    [
      'resync',
      async () => {
        seedGitBundle();
        return post(`/${BUNDLE}/sync`);
      },
    ],
  ];

  it.each(sites)(
    '%s: the request fails and the bundle ends failed with a message',
    async (_s, run) => {
      queue.state.refuse = new Error('redis is down');

      const res = await run();

      expect(res.status).toBe(500);
      const rows = fake.rows(schema.customBundles);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ status: 'failed' });
      expect(String(rows[0]!.lastSyncError)).not.toBe('');
    },
  );

  it('lets a zip complete be retried when the queue is back: syncing again, one job', async () => {
    await stage(SESSION, 'zip bytes');
    queue.state.refuse = new Error('redis is down');
    expect((await complete(SESSION)).status).toBe(500);
    queue.state.refuse = null;

    expect2xx(await complete(SESSION));

    expect(fake.rows(schema.customBundles)).toMatchObject([
      { id: SESSION, status: 'syncing', lastSyncError: null },
    ]);
    expect(ingestJobs()).toHaveLength(1);
    expect(fake.rows(schema.customBundleUploads)[0]).toMatchObject({ status: 'complete' });
  });
});

describe('C6: a fault between the replace move and its deletes', () => {
  it('leaves the new archive on disk', async () => {
    const dir = await seedZipBundle();
    await stage(REPLACE, 'NEW-ARCHIVE', { bundleId: BUNDLE });
    h.beforeRemove = (rel) => {
      if (rel.endsWith('/extracted')) throw new Error('the process died here');
    };

    const res = await post(`/${BUNDLE}/replace/${REPLACE}/complete`);

    expect(res.status).toBe(500);
    expect(await readFile(path.join(dir, 'source.zip'), 'utf8')).toBe('NEW-ARCHIVE');
  });

  it('still swaps the archive, drops the old tree and queues the ingest without a fault', async () => {
    const dir = await seedZipBundle();
    await stage(REPLACE, 'NEW-ARCHIVE', { bundleId: BUNDLE });

    expect2xx(await post(`/${BUNDLE}/replace/${REPLACE}/complete`));

    expect(await readFile(path.join(dir, 'source.zip'), 'utf8')).toBe('NEW-ARCHIVE');
    await expect(stat(path.join(dir, 'extracted'))).rejects.toThrow();
    expect(fake.rows(schema.customBundles)).toMatchObject([{ id: BUNDLE, status: 'syncing' }]);
    expect(fake.rows(schema.customBundleUploads)[0]).toMatchObject({ status: 'complete' });
    expect(ingestJobs()).toHaveLength(1);
  });
});

describe('I1: a replace complete that fails after the move gives its session back', () => {
  const replaceUrl = `/${BUNDLE}/replace/${REPLACE}/complete`;
  const cancel = () => app.request(`/uploads/${REPLACE}`, { method: 'DELETE' });
  const sessionStatus = () =>
    fake.rows(schema.customBundleUploads).find((r) => r.id === REPLACE)?.status;

  async function stageReplace() {
    const dir = await seedZipBundle();
    await stage(REPLACE, 'NEW-ARCHIVE', { bundleId: BUNDLE });
    return dir;
  }

  it('a failed removal of the old tree: the session is uploading again and a cancel answers 200', async () => {
    const dir = await stageReplace();
    h.beforeRemove = (rel) => {
      if (rel.endsWith('/extracted')) throw new Error('the removal failed');
    };

    const res = await post(replaceUrl);
    h.beforeRemove = null;

    expect(res.status).toBe(500);
    expect(await readFile(path.join(dir, 'source.zip'), 'utf8')).toBe('NEW-ARCHIVE');
    expect(sessionStatus()).toBe('uploading');
    expect((await cancel()).status).toBe(200);
    expect(sessionStatus()).toBe('cancelled');
  });

  it('a failed bundle update: the session is uploading again and a cancel answers 200', async () => {
    const dir = await stageReplace();
    fake.hooks.beforeUpdate = (table) => {
      if (table !== schema.customBundles) return;
      fake.hooks.beforeUpdate = null;
      throw new Error('the update failed');
    };

    const res = await post(replaceUrl);

    expect(res.status).toBe(500);
    expect(await readFile(path.join(dir, 'source.zip'), 'utf8')).toBe('NEW-ARCHIVE');
    expect(sessionStatus()).toBe('uploading');
    expect(ingestJobs()).toHaveLength(0);
    expect((await cancel()).status).toBe(200);
    expect(sessionStatus()).toBe('cancelled');
  });

  it('a failed enqueue comes after the final write, so the session stays complete and a cancel answers 409', async () => {
    await stageReplace();
    queue.state.refuse = new Error('redis is down');

    const res = await post(replaceUrl);

    expect(res.status).toBe(500);
    expect(sessionStatus()).toBe('complete');
    expect((await cancel()).status).toBe(409);
  });
});

describe('zip complete, the normal path', () => {
  it('creates the bundle under the upload id, moves the archive in and queues one job', async () => {
    await stage(SESSION, 'zip bytes');
    const final = path.join(bundleDir(SESSION), 'source.zip');

    const res = await complete(SESSION);

    expect(res.status).toBe(201);
    expect(fake.rows(schema.customBundles)).toMatchObject([
      {
        id: SESSION,
        status: 'syncing',
        sourceType: 'zip',
        archivePath: final,
        storageRoot: path.join(bundleDir(SESSION), 'extracted'),
      },
    ]);
    expect(await readFile(final, 'utf8')).toBe('zip bytes');
    expect(queue.jobs).toMatchObject([
      {
        id: `ingest-zip-${SESSION}`,
        name: BUNDLE_JOB_NAMES.INGEST_ZIP,
        data: { bundleId: SESSION, userId: USER, archivePath: final, archiveFormat: 'zip' },
      },
    ]);
    expect(fake.rows(schema.customBundleUploads)[0]).toMatchObject({
      status: 'complete',
      bundleId: SESSION,
      archivePath: final,
    });
  });

  it('queues the job while the upload still reads completing', async () => {
    await stage(SESSION, 'zip bytes');
    let statusAtAdd: unknown;
    queue.state.onAdd = () => {
      statusAtAdd = fake.rows(schema.customBundleUploads)[0]?.status;
    };

    expect2xx(await complete(SESSION));

    expect(statusAtAdd).toBe('completing');
  });
});
