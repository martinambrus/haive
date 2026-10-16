import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const USER = vi.hoisted(() => '00000000-0000-4000-8000-0000000000a1');
const h = vi.hoisted(() => ({
  db: undefined as unknown,
  queue: undefined as unknown,
  beforeRename: null as null | (() => void | Promise<void>),
}));

vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/queues.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/queues.js')>()),
  getRepoQueue: () => h.queue,
  getBundleQueue: () => h.queue,
}));
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
    renameNoFollow: async (...args: Parameters<typeof real.renameNoFollow>) => {
      await h.beforeRename?.();
      return real.renameNoFollow(...args);
    },
  };
});

import { Hono } from 'hono';
import { and, eq, lt } from 'drizzle-orm';
import { schema } from '@haive/database';
import { createFakeDb, type FakeDbHandle, type FakeRow } from '@haive/database/testing';
import { logger } from '@haive/shared';
import { repoRoutes } from '../src/routes/repos.js';
import { dbDumpRoutes } from '../src/routes/db-dumps.js';
import { bundleRoutes } from '../src/routes/bundles.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';

// A complete and a cancel race the upload reaper, and a cancel never takes a finished upload: the
// row decides, in one UPDATE guarded on 'uploading', and whoever commits first wins.

const SESSION = '00000000-0000-4000-8000-0000000000b1';
const BUNDLE = '00000000-0000-4000-8000-0000000000c1';
const REPO = '00000000-0000-4000-8000-0000000000f1';
const HOUR = 60 * 60 * 1000;
const STALE_MS = 24 * HOUR + 60_000;
const CONTENT = 'archive bytes';

type UploadTable =
  typeof schema.repoUploads | typeof schema.dbUploads | typeof schema.customBundleUploads;

const mount = (routes: Hono<AppEnv>): Hono<AppEnv> => {
  const app = new Hono<AppEnv>();
  app.route('/', routes);
  app.onError(errorHandler);
  return app;
};

interface Family {
  name: string;
  app: Hono<AppEnv>;
  table: UploadTable;
  pathKey: 'archivePath' | 'dumpPath';
  volume: 'repos' | 'bundles';
  completeUrl: (id: string) => string;
  cancelUrl: (id: string) => string;
  partial: (id: string) => string;
  finished: (id: string) => string;
  columns: Record<string, unknown>;
  created: () => number;
}

let fake: ReturnType<typeof makeFake>;

const FAMILIES: Family[] = [
  {
    name: 'repos',
    app: mount(repoRoutes),
    table: schema.repoUploads,
    pathKey: 'archivePath',
    volume: 'repos',
    completeUrl: (id) => `/upload/${id}/complete`,
    cancelUrl: (id) => `/upload/${id}`,
    partial: (id) => `_uploads/${USER}/${id}.zip.partial`,
    finished: (id) => `_uploads/${USER}/${id}.zip`,
    columns: { filename: 'a.zip', archiveFormat: 'zip' },
    created: () => fake.rows(schema.repositories).length,
  },
  {
    name: 'db-dumps',
    app: mount(dbDumpRoutes),
    table: schema.dbUploads,
    pathKey: 'dumpPath',
    volume: 'repos',
    completeUrl: (id) => `/upload/${id}/complete`,
    cancelUrl: (id) => `/upload/${id}`,
    partial: (id) => `_uploads/${USER}/db-${id}.sql.partial`,
    finished: (id) => `_uploads/${USER}/db-${id}.sql`,
    columns: { filename: 'a.sql', dumpFormat: 'sql' },
    created: () => 0,
  },
  {
    name: 'bundles',
    app: mount(bundleRoutes),
    table: schema.customBundleUploads,
    pathKey: 'archivePath',
    volume: 'bundles',
    completeUrl: (id) => `/uploads/${id}/complete`,
    cancelUrl: (id) => `/uploads/${id}`,
    partial: (id) => `_uploads/${USER}/${id}.zip.partial`,
    finished: (id) => `${USER}/${id}/source.zip`,
    columns: {
      repositoryId: REPO,
      name: 'kit',
      enabledKinds: ['agent', 'skill'],
      filename: 'kit.zip',
      archiveFormat: 'zip',
    },
    created: () => fake.rows(schema.customBundles).length,
  },
];

function makeFake() {
  return createFakeDb({
    repositories: schema.repositories,
    repoUploads: schema.repoUploads,
    dbUploads: schema.dbUploads,
    customBundles: schema.customBundles,
    customBundleUploads: schema.customBundleUploads,
    projectStateOutbox: schema.projectStateOutbox,
  });
}

interface FakeJob {
  id: string;
  name: string;
  data: Record<string, unknown>;
}

function makeQueue() {
  const jobs: FakeJob[] = [];
  return {
    jobs,
    add: async (name: string, data: Record<string, unknown>, opts: { jobId?: string } = {}) => {
      const job = { id: opts.jobId ?? `n${jobs.length + 1}`, name, data };
      jobs.push(job);
      return job;
    },
    getJob: async (id: string) => jobs.find((j) => j.id === id),
  };
}

let storage: string;
let volumes: { repos: string; bundles: string };
let queue: ReturnType<typeof makeQueue>;
const saved: Record<string, string | undefined> = {};

beforeEach(async () => {
  vi.spyOn(logger, 'error').mockImplementation(() => undefined);
  storage = await mkdtemp(path.join(tmpdir(), 'upload-guards-'));
  volumes = { repos: path.join(storage, 'repos'), bundles: path.join(storage, 'bundles') };
  for (const [env, root] of [
    ['REPO_STORAGE_ROOT', volumes.repos],
    ['BUNDLE_STORAGE_ROOT', volumes.bundles],
  ] as const) {
    saved[env] = process.env[env];
    process.env[env] = root;
  }
  fake = makeFake();
  const noRows = (): unknown => {
    const query: Record<string, unknown> = {};
    for (const method of ['where', 'groupBy']) query[method] = () => query;
    query.then = (ok: (rows: unknown[]) => unknown, bad: (err: unknown) => unknown) =>
      Promise.resolve([]).then(ok, bad);
    return query;
  };
  // The fake defaults only id and createdAt, and the bundle response mapper reads updatedAt.
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
    ...stamped(fake.db as unknown as FakeDbHandle),
    select: (fields?: Record<string, unknown>) => ({
      from: (table: unknown) =>
        table === schema.customBundleItems ? noRows() : fake.db.select(fields).from(table as never),
    }),
  };
  queue = makeQueue();
  h.queue = queue;
});

afterEach(async () => {
  vi.restoreAllMocks();
  h.beforeRename = null;
  for (const env of ['REPO_STORAGE_ROOT', 'BUNDLE_STORAGE_ROOT']) {
    if (saved[env] === undefined) delete process.env[env];
    else process.env[env] = saved[env];
  }
  await rm(storage, { recursive: true, force: true });
});

const absolute = (family: Family, rel: string) => path.join(volumes[family.volume], rel);
const exists = async (file: string) => (await stat(file).catch(() => null)) !== null;
const rowOf = (family: Family): FakeRow => {
  const row = fake.rows(family.table).find((r) => r.id === SESSION);
  if (!row) throw new Error('the session row is gone');
  return row;
};

interface Staged {
  partial: string;
  finished: string;
}

async function stage(
  family: Family,
  opts: { status?: string; idleMs?: number; at?: 'partial' | 'finished' } = {},
): Promise<Staged> {
  const status = opts.status ?? 'uploading';
  const at = opts.at ?? (status === 'uploading' ? 'partial' : 'finished');
  const partial = absolute(family, family.partial(SESSION));
  const finished = absolute(family, family.finished(SESSION));
  const file = at === 'partial' ? partial : finished;
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, CONTENT);
  fake.insert(family.table, {
    id: SESSION,
    userId: USER,
    totalSize: CONTENT.length,
    bytesReceived: CONTENT.length,
    chunkSize: CONTENT.length,
    status,
    updatedAt: new Date(Date.now() - (opts.idleMs ?? 0)),
    [family.pathKey]: file,
    ...family.columns,
  });
  return { partial, finished };
}

// A zip bundle whose archive a replace session swaps; returns its directory.
async function seedZipBundle(): Promise<string> {
  const dir = path.join(volumes.bundles, USER, BUNDLE);
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

// What the worker's row pass does to a table: one UPDATE guarded on 'uploading' and the TTL, then
// the partials of the rows it took are removed.
async function reap(family: Family): Promise<number> {
  const table = family.table as typeof schema.repoUploads;
  const stored = (family.table as unknown as Record<string, typeof table.archivePath>)[
    family.pathKey
  ]!;
  const cutoff = new Date(Date.now() - 24 * HOUR);
  const claimed = await fake.db
    .update(table)
    .set({ status: 'cancelled', updatedAt: new Date() })
    .where(and(eq(table.status, 'uploading'), lt(table.updatedAt, cutoff)))
    .returning({ stored });
  for (const row of claimed as { stored: string }[]) await rm(row.stored, { force: true });
  return claimed.length;
}

// The reaper's claim lands after the route has read the session and before the route's own claim.
function reaperClaimsBeforeTheRoutesWrite(family: Family): void {
  fake.hooks.beforeUpdate = async (table) => {
    if (table !== family.table) return;
    fake.hooks.beforeUpdate = null;
    await reap(family);
  };
}

const request = (app: Hono<AppEnv>, method: 'POST' | 'DELETE', url: string) =>
  app.request(url, { method });
const errorOf = async (res: Response) => ((await res.json()) as { error: string }).error;

describe('U3: a complete that a reaper claim reaches first', () => {
  it.each(FAMILIES)(
    '$name: answers 409 session cancelled, creates nothing and leaves the session cancelled',
    async (family) => {
      const staged = await stage(family, { idleMs: STALE_MS });
      reaperClaimsBeforeTheRoutesWrite(family);

      const res = await request(family.app, 'POST', family.completeUrl(SESSION));

      expect(res.status).toBe(409);
      expect(await errorOf(res)).toBe('session cancelled');
      expect(rowOf(family).status).toBe('cancelled');
      expect(family.created()).toBe(0);
      expect(queue.jobs).toHaveLength(0);
      expect(await exists(staged.finished)).toBe(false);
      expect(await exists(staged.partial)).toBe(false);
    },
  );

  it('bundle replace: answers 409 session cancelled and leaves the bundle’s archive and tree alone', async () => {
    const family = FAMILIES[2]!;
    const dir = await seedZipBundle();
    const staged = await stage(family, { idleMs: STALE_MS });
    fake.patch(schema.customBundleUploads, SESSION, { bundleId: BUNDLE });
    reaperClaimsBeforeTheRoutesWrite(family);

    const res = await request(family.app, 'POST', `/${BUNDLE}/replace/${SESSION}/complete`);

    expect(res.status).toBe(409);
    expect(await errorOf(res)).toBe('session cancelled');
    expect(rowOf(family).status).toBe('cancelled');
    expect(await readFile(path.join(dir, 'source.zip'), 'utf8')).toBe('OLD-ARCHIVE');
    expect(await exists(path.join(dir, 'extracted', 'old.md'))).toBe(true);
    expect(await exists(staged.partial)).toBe(false);
    expect(queue.jobs).toHaveLength(0);
  });
});

describe('U3: a complete whose claim is already in when a reaper pass runs', () => {
  it.each(FAMILIES)(
    '$name: the pass between the size check and the move takes nothing, and the complete finishes',
    async (family) => {
      const staged = await stage(family, { idleMs: STALE_MS });
      let taken = -1;
      h.beforeRename = async () => {
        h.beforeRename = null;
        taken = await reap(family);
      };

      const res = await request(family.app, 'POST', family.completeUrl(SESSION));

      expect(res.status).toBe(201);
      expect(taken).toBe(0);
      expect(rowOf(family).status).toBe('complete');
      expect(await readFile(staged.finished, 'utf8')).toBe(CONTENT);
      expect(await exists(staged.partial)).toBe(false);
    },
  );

  it('bundle replace: the pass between the size check and the move takes nothing', async () => {
    const family = FAMILIES[2]!;
    const dir = await seedZipBundle();
    await stage(family, { idleMs: STALE_MS });
    fake.patch(schema.customBundleUploads, SESSION, { bundleId: BUNDLE });
    let taken = -1;
    h.beforeRename = async () => {
      h.beforeRename = null;
      taken = await reap(family);
    };

    const res = await request(family.app, 'POST', `/${BUNDLE}/replace/${SESSION}/complete`);

    expect(res.status).toBe(200);
    expect(taken).toBe(0);
    expect(rowOf(family).status).toBe('complete');
    expect(await readFile(path.join(dir, 'source.zip'), 'utf8')).toBe(CONTENT);
  });
});

describe('U3: a cancel that lands after the claim is not overwritten with complete', () => {
  // The claim is the first write to the upload row; the final status write comes after the move.
  function cancelBeforeTheFinalWrite(family: Family, writes: number): void {
    let seen = 0;
    fake.hooks.beforeUpdate = (table) => {
      if (table !== family.table || (seen += 1) !== writes) return;
      fake.patch(family.table, SESSION, { status: 'cancelled' });
    };
  }

  it('bundles: the row stays cancelled', async () => {
    const family = FAMILIES[2]!;
    await stage(family);
    cancelBeforeTheFinalWrite(family, 3);

    await request(family.app, 'POST', family.completeUrl(SESSION));

    expect(rowOf(family).status).toBe('cancelled');
  });

  it('bundle replace: the row stays cancelled', async () => {
    const family = FAMILIES[2]!;
    await seedZipBundle();
    await stage(family);
    fake.patch(schema.customBundleUploads, SESSION, { bundleId: BUNDLE });
    cancelBeforeTheFinalWrite(family, 2);

    await request(family.app, 'POST', `/${BUNDLE}/replace/${SESSION}/complete`);

    expect(rowOf(family).status).toBe('cancelled');
  });
});

describe('U3: a repository or dump session names the finished file before the file moves', () => {
  const rowAtTheMove = [FAMILIES[0]!, FAMILIES[1]!];

  it.each(rowAtTheMove)(
    '$name: the row is complete and names the final path at the move',
    async (family) => {
      const staged = await stage(family);
      let seen: { status?: unknown; stored?: unknown } = {};
      h.beforeRename = () => {
        seen = { status: rowOf(family).status, stored: rowOf(family)[family.pathKey] };
      };

      const res = await request(family.app, 'POST', family.completeUrl(SESSION));

      expect(res.status).toBe(201);
      expect(seen).toEqual({ status: 'complete', stored: staged.finished });
    },
  );

  it.each(rowAtTheMove)(
    '$name: a failed move puts the session back to uploading',
    async (family) => {
      const staged = await stage(family);
      h.beforeRename = () => {
        throw new Error('the move failed');
      };

      const res = await request(family.app, 'POST', family.completeUrl(SESSION));

      expect(res.status).toBe(500);
      expect(rowOf(family)).toMatchObject({
        status: 'uploading',
        [family.pathKey]: staged.partial,
      });
      expect(family.created()).toBe(0);
      expect(await readFile(staged.partial, 'utf8')).toBe(CONTENT);

      h.beforeRename = null;
      expect((await request(family.app, 'POST', family.completeUrl(SESSION))).status).toBe(201);
      expect(await readFile(staged.finished, 'utf8')).toBe(CONTENT);
    },
  );

  it.each(rowAtTheMove)(
    '$name: a size mismatch puts the session back to uploading',
    async (family) => {
      const staged = await stage(family);
      await writeFile(staged.partial, `${CONTENT} and a tail`);

      const res = await request(family.app, 'POST', family.completeUrl(SESSION));

      expect(res.status).toBe(409);
      expect(rowOf(family)).toMatchObject({
        status: 'uploading',
        [family.pathKey]: staged.partial,
      });
    },
  );
});

describe('U4: cancelling a session that is not uploading', () => {
  it.each(FAMILIES)(
    '$name: answers 409 for a complete session and keeps the finished file',
    async (family) => {
      const staged = await stage(family, { status: 'complete' });

      const res = await request(family.app, 'DELETE', family.cancelUrl(SESSION));

      expect(res.status).toBe(409);
      expect(await errorOf(res)).toBe('session is complete');
      expect(await readFile(staged.finished, 'utf8')).toBe(CONTENT);
      expect(rowOf(family)).toMatchObject({
        status: 'complete',
        [family.pathKey]: staged.finished,
      });
    },
  );

  it.each(FAMILIES)('$name: answers 409 for a cancelled session', async (family) => {
    await stage(family, { status: 'cancelled', at: 'partial' });

    const res = await request(family.app, 'DELETE', family.cancelUrl(SESSION));

    expect(res.status).toBe(409);
    expect(await errorOf(res)).toBe('session is cancelled');
  });

  it('db-dumps: answers 409 for a consumed session', async () => {
    const family = FAMILIES[1]!;
    await stage(family, { status: 'consumed', at: 'partial' });

    const res = await request(family.app, 'DELETE', family.cancelUrl(SESSION));

    expect(res.status).toBe(409);
    expect(rowOf(family).status).toBe('consumed');
  });

  it.each(FAMILIES)(
    '$name: still cancels an uploading session and removes its partial',
    async (family) => {
      const staged = await stage(family);

      const res = await request(family.app, 'DELETE', family.cancelUrl(SESSION));

      expect(res.status).toBe(200);
      expect(rowOf(family).status).toBe('cancelled');
      expect(await exists(staged.partial)).toBe(false);
    },
  );

  it.each(FAMILIES)(
    '$name: removes nothing when a complete claims the session first',
    async (family) => {
      const staged = await stage(family);
      fake.hooks.beforeUpdate = async (table) => {
        if (table !== family.table) return;
        fake.hooks.beforeUpdate = null;
        fake.patch(family.table, SESSION, {
          status: 'complete',
          [family.pathKey]: staged.finished,
        });
      };

      const res = await request(family.app, 'DELETE', family.cancelUrl(SESSION));

      expect(res.status).toBe(409);
      expect(rowOf(family).status).toBe('complete');
      expect(await exists(staged.partial)).toBe(true);
    },
  );
});
