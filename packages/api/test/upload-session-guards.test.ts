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
import { and, eq, inArray, lt } from 'drizzle-orm';
import { schema } from '@haive/database';
import { createFakeDb, type FakeDbHandle, type FakeRow } from '@haive/database/testing';
import { configService, logger } from '@haive/shared';
import { repoRoutes } from '../src/routes/repos.js';
import { dbDumpRoutes } from '../src/routes/db-dumps.js';
import { bundleRoutes } from '../src/routes/bundles.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import {
  COMPLETE_CLAIM_RENEW_MS,
  COMPLETE_CLAIM_STALE_MS,
} from '../src/lib/upload-complete-claim.js';
import type { AppEnv } from '../src/context.js';

// A complete and a cancel race the upload reaper, and a cancel never takes a finished upload: the
// row decides, in one UPDATE guarded on 'uploading', and whoever commits first wins.

const SESSION = '00000000-0000-4000-8000-0000000000b1';
const BUNDLE = '00000000-0000-4000-8000-0000000000c1';
const REPO = '00000000-0000-4000-8000-0000000000f1';
const MIN = 60_000;
const HOUR = 60 * MIN;
const STALE_MS = 24 * HOUR + MIN;
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
  // What one finished complete leaves: rows in `created()` and jobs on the queue.
  made: number;
  jobs: number;
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
    made: 1,
    jobs: 1,
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
    made: 0,
    jobs: 0,
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
    made: 1,
    jobs: 1,
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
    getRanges: async () => jobs.map((job) => job.id),
    getJobs: async () => jobs,
    getJob: async (id: string) => jobs.find((j) => j.id === id),
  };
}

let storage: string;
let volumes: { repos: string; bundles: string };
let queue: ReturnType<typeof makeQueue>;
const saved: Record<string, string | undefined> = {};

beforeEach(async () => {
  vi.spyOn(logger, 'error').mockImplementation(() => undefined);
  vi.spyOn(configService, 'getFresh').mockResolvedValue('normal');
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

// What the worker's pass does to a table: one UPDATE guarded on 'uploading' or 'completing' and the
// TTL parks the rows it took in reaping, their partials are removed, and the rows turn cancelled.
async function reap(family: Family): Promise<number> {
  const table = family.table as typeof schema.repoUploads;
  const stored = (family.table as unknown as Record<string, typeof table.archivePath>)[
    family.pathKey
  ]!;
  const cutoff = new Date(Date.now() - 24 * HOUR);
  const claimed = await fake.db
    .update(table)
    .set({ status: 'reaping', updatedAt: new Date() })
    .where(and(inArray(table.status, ['uploading', 'completing']), lt(table.updatedAt, cutoff)))
    .returning({ id: table.id, stored });
  for (const row of claimed as { id: string; stored: string }[]) {
    await rm(row.stored, { force: true });
    await fake.db
      .update(table)
      .set({ status: 'cancelled', updatedAt: new Date() })
      .where(and(eq(table.id, row.id), eq(table.status, 'reaping')));
  }
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
    expect(await readFile(path.join(dir, `source.${SESSION}.zip`), 'utf8')).toBe(CONTENT);
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

  it('bundles: the row stays cancelled, and the complete does not report success', async () => {
    const family = FAMILIES[2]!;
    await stage(family);
    cancelBeforeTheFinalWrite(family, 3);

    const res = await request(family.app, 'POST', family.completeUrl(SESSION));

    expect(res.status).toBe(409);
    expect(rowOf(family).status).toBe('cancelled');
  });

  it('bundle replace: the row stays cancelled, and the complete does not report success', async () => {
    const family = FAMILIES[2]!;
    await seedZipBundle();
    await stage(family);
    fake.patch(schema.customBundleUploads, SESSION, { bundleId: BUNDLE });
    cancelBeforeTheFinalWrite(family, 2);

    const res = await request(family.app, 'POST', `/${BUNDLE}/replace/${SESSION}/complete`);

    expect(res.status).toBe(409);
    expect(rowOf(family).status).toBe('cancelled');
    expect(queue.jobs).toHaveLength(0);
  });
});

describe('F1: a repository or dump session reads complete only once its file has moved', () => {
  const rowAtTheMove = [FAMILIES[0]!, FAMILIES[1]!];

  it.each(rowAtTheMove)(
    '$name: at the move the row is completing and still names the partial; after it, complete and the final path',
    async (family) => {
      const staged = await stage(family);
      let seen: { status?: unknown; stored?: unknown } = {};
      h.beforeRename = () => {
        seen = { status: rowOf(family).status, stored: rowOf(family)[family.pathKey] };
      };

      const res = await request(family.app, 'POST', family.completeUrl(SESSION));

      expect(res.status).toBe(201);
      expect(seen).toEqual({ status: 'completing', stored: staged.partial });
      expect(rowOf(family)).toMatchObject({
        status: 'complete',
        [family.pathKey]: staged.finished,
      });
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

// A complete that failed after its move gives the session back to uploading, final file only.
describe('A3: cancelling an uploading session takes the finished file a complete left behind', () => {
  const finishable = [FAMILIES[0]!, FAMILIES[1]!];

  it.each(finishable)(
    '$name: removes the finished file and the partial when both are there',
    async (family) => {
      const staged = await stage(family);
      await writeFile(staged.finished, CONTENT);

      const res = await request(family.app, 'DELETE', family.cancelUrl(SESSION));

      expect(res.status).toBe(200);
      expect(rowOf(family).status).toBe('cancelled');
      expect(await exists(staged.partial)).toBe(false);
      expect(await exists(staged.finished)).toBe(false);
    },
  );

  it.each(finishable)(
    '$name: removes the file a complete moved before its last write failed',
    async (family) => {
      const staged = await stage(family);
      let writes = 0;
      // The claim is the first write to the upload row and the final write is the second.
      fake.hooks.beforeUpdate = (table) => {
        if (table === family.table && (writes += 1) === 2)
          throw new Error('the final write failed');
      };

      const failed = await request(family.app, 'POST', family.completeUrl(SESSION));
      fake.hooks.beforeUpdate = null;

      expect(failed.status).toBe(500);
      expect(rowOf(family)).toMatchObject({
        status: 'uploading',
        [family.pathKey]: staged.partial,
      });
      expect(await exists(staged.partial)).toBe(false);
      expect(await readFile(staged.finished, 'utf8')).toBe(CONTENT);

      const res = await request(family.app, 'DELETE', family.cancelUrl(SESSION));

      expect(res.status).toBe(200);
      expect(rowOf(family).status).toBe('cancelled');
      expect(await exists(staged.finished)).toBe(false);
    },
  );

  it.each(finishable)(
    '$name: removes the finished file even when the partial cannot be removed',
    async (family) => {
      const staged = await stage(family);
      await rm(staged.partial);
      await mkdir(staged.partial);
      await writeFile(path.join(staged.partial, 'inner.txt'), 'inner');
      await writeFile(staged.finished, CONTENT);

      const res = await request(family.app, 'DELETE', family.cancelUrl(SESSION));

      expect(res.status).toBe(200);
      expect(await exists(staged.finished)).toBe(false);
      expect(await readFile(path.join(staged.partial, 'inner.txt'), 'utf8')).toBe('inner');
    },
  );

  it.each(finishable)(
    '$name: removes nothing, the finished file included, when a complete claims the session first',
    async (family) => {
      const staged = await stage(family);
      await writeFile(staged.finished, CONTENT);
      fake.hooks.beforeUpdate = async (table) => {
        if (table !== family.table) return;
        fake.hooks.beforeUpdate = null;
        fake.patch(family.table, SESSION, {
          status: 'completing',
          updatedAt: new Date(),
        });
      };

      const res = await request(family.app, 'DELETE', family.cancelUrl(SESSION));

      expect(res.status).toBe(409);
      expect(rowOf(family).status).toBe('completing');
      expect(await exists(staged.partial)).toBe(true);
      expect(await readFile(staged.finished, 'utf8')).toBe(CONTENT);
    },
  );
});

describe('A1: a bundle complete holds its session against a cancel', () => {
  const bundles = FAMILIES[2]!;
  const replaceUrl = `/${BUNDLE}/replace/${SESSION}/complete`;

  async function stageReplace(): Promise<string> {
    const dir = await seedZipBundle();
    await stage(bundles);
    fake.patch(schema.customBundleUploads, SESSION, { bundleId: BUNDLE });
    return dir;
  }

  // A client's cancel served while the complete is past its claim, at the archive move.
  function cancelAtTheMove(): { response: Response | null } {
    const seen: { response: Response | null } = { response: null };
    h.beforeRename = async () => {
      h.beforeRename = null;
      seen.response = await request(bundles.app, 'DELETE', bundles.cancelUrl(SESSION));
    };
    return seen;
  }

  // A client's cancel served after the complete read the session and before its claim.
  function cancelBeforeTheClaim(): void {
    fake.hooks.beforeUpdate = async (table) => {
      if (table !== bundles.table) return;
      fake.hooks.beforeUpdate = null;
      await request(bundles.app, 'DELETE', bundles.cancelUrl(SESSION));
    };
  }

  const bundleIdOf = async (res: Response) =>
    ((await res.json()) as { bundle: { id: string } }).bundle.id;

  it('create: a cancel after the claim answers 409, and the complete ends complete with one bundle', async () => {
    const staged = await stage(bundles);
    const cancel = cancelAtTheMove();

    const res = await request(bundles.app, 'POST', bundles.completeUrl(SESSION));

    expect(cancel.response?.status).toBe(409);
    expect(await errorOf(cancel.response!)).toBe('session is completing');
    expect(res.status).toBe(201);
    expect(rowOf(bundles).status).toBe('complete');
    expect(fake.rows(schema.customBundles).map((r) => r.id)).toEqual([SESSION]);
    expect(await readFile(staged.finished, 'utf8')).toBe(CONTENT);
    expect(queue.jobs).toHaveLength(1);
  });

  it('create: a cancel before the claim leaves the complete answering 409 session cancelled, with no bundle', async () => {
    await stage(bundles);
    cancelBeforeTheClaim();

    const res = await request(bundles.app, 'POST', bundles.completeUrl(SESSION));

    expect(res.status).toBe(409);
    expect(await errorOf(res)).toBe('session cancelled');
    expect(rowOf(bundles).status).toBe('cancelled');
    expect(fake.rows(schema.customBundles)).toEqual([]);
    expect(queue.jobs).toHaveLength(0);
  });

  it('create: a repeat after success answers 200 with the same bundle', async () => {
    await stage(bundles);

    const first = await request(bundles.app, 'POST', bundles.completeUrl(SESSION));
    const second = await request(bundles.app, 'POST', bundles.completeUrl(SESSION));

    expect([first.status, second.status]).toEqual([201, 200]);
    expect(await bundleIdOf(second)).toBe(await bundleIdOf(first));
    expect(fake.rows(schema.customBundles)).toHaveLength(1);
    expect(queue.jobs).toHaveLength(1);
  });

  it('replace: a cancel after the claim answers 409, and the complete swaps the archive', async () => {
    const dir = await stageReplace();
    const cancel = cancelAtTheMove();

    const res = await request(bundles.app, 'POST', replaceUrl);

    expect(cancel.response?.status).toBe(409);
    expect(await errorOf(cancel.response!)).toBe('session is completing');
    expect(res.status).toBe(200);
    expect(rowOf(bundles).status).toBe('complete');
    expect(fake.rows(schema.customBundles).map((r) => r.id)).toEqual([BUNDLE]);
    expect(await readFile(path.join(dir, `source.${SESSION}.zip`), 'utf8')).toBe(CONTENT);
    expect(queue.jobs).toHaveLength(1);
  });

  it('replace: a cancel before the claim leaves the complete answering 409 session cancelled, and the archive alone', async () => {
    const dir = await stageReplace();
    cancelBeforeTheClaim();

    const res = await request(bundles.app, 'POST', replaceUrl);

    expect(res.status).toBe(409);
    expect(await errorOf(res)).toBe('session cancelled');
    expect(rowOf(bundles).status).toBe('cancelled');
    expect(await readFile(path.join(dir, 'source.zip'), 'utf8')).toBe('OLD-ARCHIVE');
    expect(queue.jobs).toHaveLength(0);
  });

  it('replace: a repeat after success returns the same bundle and queues nothing more', async () => {
    const dir = await stageReplace();

    const first = await request(bundles.app, 'POST', replaceUrl);
    const second = await request(bundles.app, 'POST', replaceUrl);

    expect([first.status, second.status]).toEqual([200, 200]);
    expect(((await second.json()) as { bundle: { id: string } }).bundle.id).toBe(BUNDLE);
    expect(await readFile(path.join(dir, `source.${SESSION}.zip`), 'utf8')).toBe(CONTENT);
    expect(fake.rows(schema.customBundles)).toHaveLength(1);
    expect(queue.jobs).toHaveLength(1);
  });
});

describe('A1: a bundle complete that fails before it changes anything gives its session back', () => {
  const bundles = FAMILIES[2]!;
  const replaceUrl = `/${BUNDLE}/replace/${SESSION}/complete`;

  it('create: a size mismatch answers 409 and the session is uploading again', async () => {
    const staged = await stage(bundles);
    await writeFile(staged.partial, `${CONTENT} and a tail`);

    const res = await request(bundles.app, 'POST', bundles.completeUrl(SESSION));

    expect(res.status).toBe(409);
    expect(await errorOf(res)).toBe('archive size mismatch on disk');
    expect(rowOf(bundles)).toMatchObject({ status: 'uploading', archivePath: staged.partial });
    expect(fake.rows(schema.customBundles)).toEqual([]);

    await writeFile(staged.partial, CONTENT);
    expect((await request(bundles.app, 'POST', bundles.completeUrl(SESSION))).status).toBe(201);
    expect(rowOf(bundles).status).toBe('complete');
  });

  it('create: a failed bundle insert answers 500, leaves no bundle and gives the session back', async () => {
    const staged = await stage(bundles);
    fake.hooks.beforeInsert = (table) => {
      if (table !== schema.customBundles) return;
      fake.hooks.beforeInsert = null;
      throw new Error('the insert failed');
    };

    const res = await request(bundles.app, 'POST', bundles.completeUrl(SESSION));

    expect(res.status).toBe(500);
    expect(rowOf(bundles)).toMatchObject({ status: 'uploading', archivePath: staged.partial });
    expect(fake.rows(schema.customBundles)).toEqual([]);
    expect(queue.jobs).toHaveLength(0);
    expect((await request(bundles.app, 'POST', bundles.completeUrl(SESSION))).status).toBe(201);
  });

  it('create: a failure after the bundle exists gives the session back, and a repeat finishes it', async () => {
    const staged = await stage(bundles);
    h.beforeRename = () => {
      h.beforeRename = null;
      throw new Error('the move failed');
    };

    const failed = await request(bundles.app, 'POST', bundles.completeUrl(SESSION));

    expect(failed.status).toBe(500);
    expect(rowOf(bundles).status).toBe('uploading');
    expect(fake.rows(schema.customBundles).map((r) => r.id)).toEqual([SESSION]);
    expect((await request(bundles.app, 'POST', bundles.completeUrl(SESSION))).status).toBe(201);
    expect(rowOf(bundles).status).toBe('complete');
    expect(await readFile(staged.finished, 'utf8')).toBe(CONTENT);
    expect(queue.jobs).toHaveLength(1);
  });

  it('replace: a size mismatch answers 409 and the session is uploading again', async () => {
    const dir = await seedZipBundle();
    const staged = await stage(bundles);
    fake.patch(schema.customBundleUploads, SESSION, { bundleId: BUNDLE });
    await writeFile(staged.partial, `${CONTENT} and a tail`);

    const res = await request(bundles.app, 'POST', replaceUrl);

    expect(res.status).toBe(409);
    expect(await errorOf(res)).toBe('archive size mismatch on disk');
    expect(rowOf(bundles)).toMatchObject({ status: 'uploading', archivePath: staged.partial });
    expect(await readFile(path.join(dir, 'source.zip'), 'utf8')).toBe('OLD-ARCHIVE');
    expect(queue.jobs).toHaveLength(0);
  });

  it('replace: a failed move answers 500 and gives the session back with the archive untouched', async () => {
    const dir = await seedZipBundle();
    const staged = await stage(bundles);
    fake.patch(schema.customBundleUploads, SESSION, { bundleId: BUNDLE });
    h.beforeRename = () => {
      h.beforeRename = null;
      throw new Error('the move failed');
    };

    const res = await request(bundles.app, 'POST', replaceUrl);

    expect(res.status).toBe(500);
    expect(rowOf(bundles)).toMatchObject({ status: 'uploading', archivePath: staged.partial });
    expect(await readFile(path.join(dir, 'source.zip'), 'utf8')).toBe('OLD-ARCHIVE');
    expect(await readFile(staged.partial, 'utf8')).toBe(CONTENT);
    expect((await request(bundles.app, 'POST', replaceUrl)).status).toBe(200);
    expect(await readFile(path.join(dir, `source.${SESSION}.zip`), 'utf8')).toBe(CONTENT);
  });
});

describe('F1: a complete resumes the claim of a request that died, and leaves a live claim alone', () => {
  // What a complete that died after its claim leaves: completing, naming the partial, stamped long ago.
  async function deadClaim(family: Family, at: 'partial' | 'finished'): Promise<Staged> {
    const staged = await stage(family, { status: 'completing', at, idleMs: 11 * MIN });
    fake.patch(family.table, SESSION, { [family.pathKey]: staged.partial });
    return staged;
  }

  it.each(FAMILIES)(
    '$name: a dead claim with its partial present: a repeat complete finishes it, once',
    async (family) => {
      const staged = await deadClaim(family, 'partial');

      const res = await request(family.app, 'POST', family.completeUrl(SESSION));

      expect(res.status).toBe(201);
      expect(rowOf(family)).toMatchObject({
        status: 'complete',
        [family.pathKey]: staged.finished,
      });
      expect(await readFile(staged.finished, 'utf8')).toBe(CONTENT);
      expect(await exists(staged.partial)).toBe(false);
      expect(family.created()).toBe(family.made);
      expect(queue.jobs).toHaveLength(family.jobs);
    },
  );

  it.each(FAMILIES)(
    '$name: a dead claim whose file already moved: a repeat complete finishes it without a move',
    async (family) => {
      const staged = await deadClaim(family, 'finished');
      h.beforeRename = () => {
        throw new Error('no move was due');
      };

      const res = await request(family.app, 'POST', family.completeUrl(SESSION));

      expect(res.status).toBe(201);
      expect(rowOf(family)).toMatchObject({
        status: 'complete',
        [family.pathKey]: staged.finished,
      });
      expect(await readFile(staged.finished, 'utf8')).toBe(CONTENT);
      expect(family.created()).toBe(family.made);
      expect(queue.jobs).toHaveLength(family.jobs);
    },
  );

  it.each(FAMILIES)('$name: a live claim answers 409 and changes nothing', async (family) => {
    const staged = await stage(family, { status: 'completing', at: 'partial', idleMs: 9 * MIN });
    const before = { ...rowOf(family) };

    const res = await request(family.app, 'POST', family.completeUrl(SESSION));

    expect(res.status).toBe(409);
    expect(await errorOf(res)).toBe('a complete of this session is already running');
    expect(rowOf(family)).toEqual(before);
    expect(await readFile(staged.partial, 'utf8')).toBe(CONTENT);
    expect(family.created()).toBe(0);
    expect(queue.jobs).toHaveLength(0);
  });

  it.each(FAMILIES)(
    '$name: a dead claim whose file is gone answers 409 and gives the session back',
    async (family) => {
      const staged = await deadClaim(family, 'partial');
      await rm(staged.partial);

      const res = await request(family.app, 'POST', family.completeUrl(SESSION));

      expect(res.status).toBe(409);
      expect(rowOf(family).status).toBe('uploading');
    },
  );
});

describe('F2: one complete holds a session at a time', () => {
  const bundles = FAMILIES[2]!;
  const replaceUrl = `/${BUNDLE}/replace/${SESSION}/complete`;

  // The row now carries another complete's stamp, as if that complete had taken the session over.
  function takenOverAtWrite(family: Family, writes: number): void {
    let seen = 0;
    fake.hooks.beforeUpdate = (table) => {
      if (table !== family.table || (seen += 1) !== writes) return;
      fake.patch(family.table, SESSION, { updatedAt: new Date(Date.now() + 5_000) });
    };
  }
  const staleAgain = () =>
    fake.patch(schema.customBundleUploads, SESSION, { updatedAt: new Date(Date.now() - 11 * MIN) });

  it.each(FAMILIES)(
    '$name: a second complete while the first holds the claim answers 409 and moves nothing',
    async (family) => {
      const staged = await stage(family);
      const seen = { second: null as Response | null, at: {} as Record<string, unknown> };
      h.beforeRename = async () => {
        h.beforeRename = null;
        seen.second = await request(family.app, 'POST', family.completeUrl(SESSION));
        seen.at = {
          partial: await exists(staged.partial),
          finished: await exists(staged.finished),
          jobs: queue.jobs.length,
        };
      };

      const first = await request(family.app, 'POST', family.completeUrl(SESSION));

      expect(seen.second?.status).toBe(409);
      expect(await errorOf(seen.second!)).toBe('a complete of this session is already running');
      expect(seen.at).toEqual({ partial: true, finished: false, jobs: 0 });
      expect(first.status).toBe(201);
      expect(rowOf(family).status).toBe('complete');
      expect(family.created()).toBe(family.made);
      expect(queue.jobs).toHaveLength(family.jobs);
    },
  );

  it('replace: a second complete while the first holds the claim answers 409 and moves nothing', async () => {
    const dir = await seedZipBundle();
    const staged = await stage(bundles);
    fake.patch(schema.customBundleUploads, SESSION, { bundleId: BUNDLE });
    const seen = { second: null as Response | null, at: {} as Record<string, unknown> };
    h.beforeRename = async () => {
      h.beforeRename = null;
      seen.second = await request(bundles.app, 'POST', replaceUrl);
      seen.at = {
        source: await readFile(path.join(dir, 'source.zip'), 'utf8'),
        partial: await exists(staged.partial),
        jobs: queue.jobs.length,
      };
    };

    const first = await request(bundles.app, 'POST', replaceUrl);

    expect(seen.second?.status).toBe(409);
    expect(await errorOf(seen.second!)).toBe('a complete of this session is already running');
    expect(seen.at).toEqual({ source: 'OLD-ARCHIVE', partial: true, jobs: 0 });
    expect(first.status).toBe(200);
    expect(await readFile(path.join(dir, `source.${SESSION}.zip`), 'utf8')).toBe(CONTENT);
    expect(queue.jobs).toHaveLength(1);
  });

  it('repos: a complete taken over before its final write answers 409, and its repository insert is rolled back', async () => {
    const family = FAMILIES[0]!;
    await stage(family);
    takenOverAtWrite(family, 2);

    const res = await request(family.app, 'POST', family.completeUrl(SESSION));

    expect(res.status).toBe(409);
    expect(family.created()).toBe(0);
    expect(queue.jobs).toHaveLength(0);
    expect(rowOf(family).status).toBe('completing');

    fake.hooks.beforeUpdate = null;
    fake.patch(family.table, SESSION, { updatedAt: new Date(Date.now() - 11 * MIN) });
    expect((await request(family.app, 'POST', family.completeUrl(SESSION))).status).toBe(201);
    expect(family.created()).toBe(1);
    expect(queue.jobs).toHaveLength(1);
  });

  it('db-dumps: a complete taken over before its final write answers 409 and leaves the row to the taker', async () => {
    const family = FAMILIES[1]!;
    const staged = await stage(family);
    takenOverAtWrite(family, 2);

    const res = await request(family.app, 'POST', family.completeUrl(SESSION));

    expect(res.status).toBe(409);
    expect(rowOf(family)).toMatchObject({ status: 'completing', dumpPath: staged.partial });

    fake.hooks.beforeUpdate = null;
    fake.patch(family.table, SESSION, { updatedAt: new Date(Date.now() - 11 * MIN) });
    expect((await request(family.app, 'POST', family.completeUrl(SESSION))).status).toBe(201);
    expect(rowOf(family)).toMatchObject({ status: 'complete', dumpPath: staged.finished });
  });

  it('create: a complete taken over before its link write answers 409 and rolls its bundle insert back', async () => {
    await stage(bundles);
    takenOverAtWrite(bundles, 2);

    const res = await request(bundles.app, 'POST', bundles.completeUrl(SESSION));

    expect(res.status).toBe(409);
    expect(fake.rows(schema.customBundles)).toEqual([]);
    expect(queue.jobs).toHaveLength(0);
    expect(rowOf(bundles).status).toBe('completing');
  });

  it('create: a complete taken over before its final write answers 409, and the takeover leaves one bundle and one job', async () => {
    await stage(bundles);
    takenOverAtWrite(bundles, 3);

    const res = await request(bundles.app, 'POST', bundles.completeUrl(SESSION));

    expect(res.status).toBe(409);
    expect(rowOf(bundles).status).toBe('completing');

    fake.hooks.beforeUpdate = null;
    staleAgain();
    expect((await request(bundles.app, 'POST', bundles.completeUrl(SESSION))).status).toBe(201);
    expect(rowOf(bundles).status).toBe('complete');
    expect(fake.rows(schema.customBundles).map((r) => r.id)).toEqual([SESSION]);
    expect(queue.jobs).toHaveLength(1);
  });

  it('replace: a complete taken over before its final write answers 409, queues nothing and leaves the bundle row alone', async () => {
    const dir = await seedZipBundle();
    await stage(bundles);
    fake.patch(schema.customBundleUploads, SESSION, { bundleId: BUNDLE });
    takenOverAtWrite(bundles, 2);

    const res = await request(bundles.app, 'POST', replaceUrl);

    expect(res.status).toBe(409);
    expect(rowOf(bundles).status).toBe('completing');
    expect(queue.jobs).toHaveLength(0);
    expect(fake.rows(schema.customBundles)[0]).toMatchObject({
      status: 'active',
      archiveFilename: 'kit.zip',
      archivePath: path.join(dir, 'source.zip'),
    });
  });
});

// A complete stops at the move, past its claim, until the test lets it go; with `failure` it then fails.
function holdAtTheMove(failure?: Error): {
  reachedBy: (request: Response | Promise<Response>) => Promise<void>;
  release: () => void;
} {
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  let reach!: () => void;
  const reached = new Promise<void>((resolve) => (reach = resolve));
  h.beforeRename = async () => {
    h.beforeRename = null;
    reach();
    await released;
    if (failure) throw failure;
  };
  return {
    release,
    reachedBy: (request) =>
      Promise.race([
        reached,
        Promise.resolve(request).then((res) => {
          throw new Error(`the complete ended with ${res.status} before it reached the move`);
        }),
      ]),
  };
}

describe('L: a complete holds its claim by renewing it while it works', () => {
  const replaceUrl = `/${BUNDLE}/replace/${SESSION}/complete`;
  const stampOf = (family: Family) => (rowOf(family).updatedAt as Date).getTime();

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('L0: the claim is renewed every minute and goes stale after ten', () => {
    expect([COMPLETE_CLAIM_RENEW_MS, COMPLETE_CLAIM_STALE_MS]).toEqual([MIN, 10 * MIN]);
  });

  it.each(FAMILIES)(
    'L1 $name: a complete that outlives the stale window keeps its claim, and the first one finishes',
    async (family) => {
      const staged = await stage(family);
      const gate = holdAtTheMove();
      const first = request(family.app, 'POST', family.completeUrl(SESSION));
      await gate.reachedBy(first);

      await vi.advanceTimersByTimeAsync(11 * MIN);
      const second = await request(family.app, 'POST', family.completeUrl(SESSION));

      expect(second.status).toBe(409);
      expect(await errorOf(second)).toBe('a complete of this session is already running');
      expect(rowOf(family).status).toBe('completing');
      expect(await exists(staged.partial)).toBe(true);

      gate.release();
      const res = await first;

      expect(res.status).toBe(201);
      expect(rowOf(family)).toMatchObject({
        status: 'complete',
        [family.pathKey]: staged.finished,
      });
      expect(await readFile(staged.finished, 'utf8')).toBe(CONTENT);
      expect(family.created()).toBe(family.made);
      expect(queue.jobs).toHaveLength(family.jobs);
    },
  );

  it('L1 replace: a complete that outlives the stale window keeps its claim, and swaps the archive', async () => {
    const family = FAMILIES[2]!;
    const dir = await seedZipBundle();
    await stage(family);
    fake.patch(schema.customBundleUploads, SESSION, { bundleId: BUNDLE });
    const gate = holdAtTheMove();
    const first = request(family.app, 'POST', replaceUrl);
    await gate.reachedBy(first);

    await vi.advanceTimersByTimeAsync(11 * MIN);
    const second = await request(family.app, 'POST', replaceUrl);

    expect(second.status).toBe(409);
    expect(await errorOf(second)).toBe('a complete of this session is already running');
    expect(rowOf(family).status).toBe('completing');
    expect(await readFile(path.join(dir, 'source.zip'), 'utf8')).toBe('OLD-ARCHIVE');

    gate.release();
    const res = await first;

    expect(res.status).toBe(200);
    expect(rowOf(family).status).toBe('complete');
    expect(await readFile(path.join(dir, `source.${SESSION}.zip`), 'utf8')).toBe(CONTENT);
    expect(queue.jobs).toHaveLength(1);
  });

  it.each(FAMILIES)(
    'L2 $name: a holder that stops renewing loses the claim to a takeover after the stale window',
    async (family) => {
      const staged = await stage(family);
      const gate = holdAtTheMove();
      const first = request(family.app, 'POST', family.completeUrl(SESSION));
      await gate.reachedBy(first);
      const claimed = stampOf(family);

      await vi.advanceTimersByTimeAsync(5 * MIN);
      expect(stampOf(family)).toBeGreaterThan(claimed);

      // The holder dies here: the clock runs on and no tick of its lease fires.
      vi.setSystemTime(Date.now() + 11 * MIN);
      const second = await request(family.app, 'POST', family.completeUrl(SESSION));

      expect(second.status).toBe(201);
      expect(rowOf(family)).toMatchObject({
        status: 'complete',
        [family.pathKey]: staged.finished,
      });

      gate.release();
      expect((await first).status).toBeGreaterThanOrEqual(400);
      expect(rowOf(family)).toMatchObject({
        status: 'complete',
        [family.pathKey]: staged.finished,
      });
      expect(family.created()).toBe(family.made);
      // BullMQ keeps one job per id, which the fake queue does not.
      expect(new Set(queue.jobs.map((job) => job.id)).size).toBe(family.jobs);
    },
  );

  it.each(FAMILIES)('L6 $name: no renewal follows a complete that succeeded', async (family) => {
    await stage(family);
    expect((await request(family.app, 'POST', family.completeUrl(SESSION))).status).toBe(201);
    let writes = 0;
    fake.hooks.beforeUpdate = (table) => {
      if (table === family.table) writes += 1;
    };

    await vi.advanceTimersByTimeAsync(10 * MIN);

    expect(writes).toBe(0);
  });

  it.each(FAMILIES)('L6 $name: no renewal follows a complete that failed', async (family) => {
    await stage(family);
    h.beforeRename = () => {
      throw new Error('the move failed');
    };
    expect((await request(family.app, 'POST', family.completeUrl(SESSION))).status).toBe(500);
    let writes = 0;
    fake.hooks.beforeUpdate = (table) => {
      if (table === family.table) writes += 1;
    };

    await vi.advanceTimersByTimeAsync(10 * MIN);

    expect(writes).toBe(0);
  });

  it('L3 repos: a renewal that finds the claim gone is the last one, and none follows the end of the complete', async () => {
    const family = FAMILIES[0]!;
    await stage(family);
    const gate = holdAtTheMove();
    const first = request(family.app, 'POST', family.completeUrl(SESSION));
    await gate.reachedBy(first);
    let writes = 0;
    fake.hooks.beforeUpdate = (table) => {
      if (table === family.table) writes += 1;
    };
    // Another complete took the session over: the row now carries its stamp.
    fake.patch(family.table, SESSION, { updatedAt: new Date(Date.now() + 5_000) });

    await vi.advanceTimersByTimeAsync(3 * MIN);

    expect(writes).toBe(1);

    gate.release();
    expect((await first).status).toBe(409);
    writes = 0;
    await vi.advanceTimersByTimeAsync(10 * MIN);
    expect(writes).toBe(0);
    expect(rowOf(family).status).toBe('completing');
  });

  it('L7 repos: a renewal that fails is logged and retried by the next tick', async () => {
    const family = FAMILIES[0]!;
    await stage(family);
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const gate = holdAtTheMove();
    const first = request(family.app, 'POST', family.completeUrl(SESSION));
    await gate.reachedBy(first);
    const claimed = stampOf(family);
    let failing = true;
    fake.hooks.beforeUpdate = (table) => {
      if (table === family.table && failing) throw new Error('the database blinked');
    };

    await vi.advanceTimersByTimeAsync(MIN);
    expect(stampOf(family)).toBe(claimed);
    expect(warn).toHaveBeenCalledTimes(1);

    failing = false;
    await vi.advanceTimersByTimeAsync(MIN);
    expect(stampOf(family)).toBeGreaterThan(claimed);

    gate.release();
    expect((await first).status).toBe(201);
    expect(rowOf(family).status).toBe('complete');
  });

  it('L4 repos: a renewal that lands as the final write starts does not fail the write', async () => {
    const family = FAMILIES[0]!;
    const staged = await stage(family);
    let seen = 0;
    let ticking = false;
    // The claim is the first write to the upload row and the final write is the second.
    fake.hooks.beforeUpdate = async (table) => {
      if (table !== family.table || ticking || (seen += 1) !== 2) return;
      ticking = true;
      const before = stampOf(family);
      await vi.advanceTimersByTimeAsync(MIN);
      expect(stampOf(family)).toBeGreaterThan(before);
      ticking = false;
    };

    const res = await request(family.app, 'POST', family.completeUrl(SESSION));

    expect(res.status).toBe(201);
    expect(rowOf(family)).toMatchObject({ status: 'complete', [family.pathKey]: staged.finished });
    expect(family.created()).toBe(1);
  });

  it.each(FAMILIES)(
    'L5 $name: a complete that fails after renewing gives the session back',
    async (family) => {
      const staged = await stage(family);
      const gate = holdAtTheMove(new Error('the move failed'));
      const first = request(family.app, 'POST', family.completeUrl(SESSION));
      await gate.reachedBy(first);
      await vi.advanceTimersByTimeAsync(5 * MIN);

      gate.release();
      const res = await first;

      expect(res.status).toBe(500);
      expect(rowOf(family)).toMatchObject({
        status: 'uploading',
        [family.pathKey]: staged.partial,
      });
      expect(await readFile(staged.partial, 'utf8')).toBe(CONTENT);
    },
  );
});

describe('R2: a cancel leaves the session reaping while a file will not go', () => {
  // A non-empty directory at a name cannot be removed as a file: the removal fails.
  async function blockedAt(file: string): Promise<void> {
    await rm(file, { force: true });
    await mkdir(file);
    await writeFile(path.join(file, 'inner.txt'), 'inner');
  }

  it.each([FAMILIES[0]!, FAMILIES[1]!])(
    '$name: a finished file that cannot be removed leaves the row reaping, the partial gone',
    async (family) => {
      const staged = await stage(family);
      await blockedAt(staged.finished);

      const res = await request(family.app, 'DELETE', family.cancelUrl(SESSION));

      expect(res.status).toBe(200);
      expect(rowOf(family).status).toBe('reaping');
      expect(await exists(staged.partial)).toBe(false);
      expect(await readFile(path.join(staged.finished, 'inner.txt'), 'utf8')).toBe('inner');
    },
  );

  it.each(FAMILIES)(
    '$name: a partial that cannot be removed leaves the row reaping',
    async (family) => {
      const staged = await stage(family);
      await blockedAt(staged.partial);

      const res = await request(family.app, 'DELETE', family.cancelUrl(SESSION));

      expect(res.status).toBe(200);
      expect(rowOf(family).status).toBe('reaping');
      expect(await readFile(path.join(staged.partial, 'inner.txt'), 'utf8')).toBe('inner');
    },
  );

  it.each(FAMILIES)(
    '$name: a row that names a path that is not its own is cancelled and the file is left',
    async (family) => {
      await stage(family);
      const outside = path.join(storage, 'precious.bin');
      await writeFile(outside, 'keep me');
      fake.patch(family.table, SESSION, { [family.pathKey]: outside });

      const res = await request(family.app, 'DELETE', family.cancelUrl(SESSION));

      expect(res.status).toBe(200);
      expect(rowOf(family).status).toBe('cancelled');
      expect(await readFile(outside, 'utf8')).toBe('keep me');
    },
  );

  it.each(FAMILIES)(
    '$name: the row reads reaping while the files go, and cancelled once they are gone',
    async (family) => {
      const staged = await stage(family);
      const seen: unknown[] = [];
      fake.hooks.beforeUpdate = (table) => {
        if (table === family.table) seen.push(rowOf(family).status);
      };

      const res = await request(family.app, 'DELETE', family.cancelUrl(SESSION));

      expect(res.status).toBe(200);
      expect(seen).toEqual(['uploading', 'reaping']);
      expect(rowOf(family).status).toBe('cancelled');
      expect(await exists(staged.partial)).toBe(false);
    },
  );

  it.each(FAMILIES)(
    '$name: a session left reaping refuses a complete and a second cancel',
    async (family) => {
      const staged = await stage(family, { status: 'reaping', at: 'partial' });

      const complete = await request(family.app, 'POST', family.completeUrl(SESSION));
      const cancel = await request(family.app, 'DELETE', family.cancelUrl(SESSION));

      expect(complete.status).toBe(409);
      expect(await errorOf(complete)).toBe('session cancelled');
      expect(cancel.status).toBe(409);
      expect(await errorOf(cancel)).toBe('session is reaping');
      expect(rowOf(family).status).toBe('reaping');
      expect(await readFile(staged.partial, 'utf8')).toBe(CONTENT);
    },
  );
});

describe('I9: a complete on a session that is over', () => {
  interface Case {
    name: string;
    family: Family;
    at: 'partial' | 'finished';
    replace?: boolean;
  }
  const [repos, dumps, bundles] = FAMILIES as [Family, Family, Family];
  const cases: Case[] = [
    { name: 'repos', family: repos, at: 'partial' },
    { name: 'db-dumps (partial)', family: dumps, at: 'partial' },
    { name: 'db-dumps (finished)', family: dumps, at: 'finished' },
    { name: 'bundles create', family: bundles, at: 'partial' },
    { name: 'bundle replace', family: bundles, at: 'partial', replace: true },
  ];

  async function stageCase(c: Case, status: string, bytesReceived: number): Promise<string> {
    if (c.replace) await seedZipBundle();
    await stage(c.family, { status, at: c.at });
    fake.patch(c.family.table, SESSION, { bytesReceived });
    if (c.replace) fake.patch(schema.customBundleUploads, SESSION, { bundleId: BUNDLE });
    return c.replace ? `/${BUNDLE}/replace/${SESSION}/complete` : c.family.completeUrl(SESSION);
  }

  describe.each(['reaping', 'reap_failed'])('a %s session', (over) => {
    it.each(cases)('$name: with short bytes answers 409 session cancelled', async (c) => {
      const url = await stageCase(c, over, 3);
      const before = c.family.created();

      const res = await request(c.family.app, 'POST', url);

      expect(res.status).toBe(409);
      expect(await errorOf(res)).toBe('session cancelled');
      expect(rowOf(c.family).status).toBe(over);
      expect(c.family.created()).toBe(before);
      expect(queue.jobs).toHaveLength(0);
    });

    it.each(cases)('$name: with all bytes answers 409 session cancelled', async (c) => {
      const url = await stageCase(c, over, CONTENT.length);
      const before = c.family.created();

      const res = await request(c.family.app, 'POST', url);

      expect(res.status).toBe(409);
      expect(await errorOf(res)).toBe('session cancelled');
      expect(rowOf(c.family).status).toBe(over);
      expect(c.family.created()).toBe(before);
      expect(queue.jobs).toHaveLength(0);
    });
  });

  it.each(cases)(
    '$name: an uploading session with short bytes still answers incomplete',
    async (c) => {
      const url = await stageCase(c, 'uploading', 3);

      const res = await request(c.family.app, 'POST', url);

      expect(res.status).toBe(409);
      expect(await errorOf(res)).toBe(`incomplete: 3/${CONTENT.length} bytes`);
    },
  );
});

describe('I1: a chunked upload repository takes the session id', () => {
  const repos = FAMILIES[0]!;

  it('names the repository, the response and the finished archive after the session', async () => {
    const staged = await stage(repos);

    const res = await request(repos.app, 'POST', repos.completeUrl(SESSION));

    expect(res.status).toBe(201);
    const [repository] = fake.rows(schema.repositories);
    expect(repository!.id).toBe(SESSION);
    expect(((await res.json()) as { repository: { id: string } }).repository.id).toBe(SESSION);
    expect(await exists(absolute(repos, `_uploads/${USER}/${SESSION}.zip`))).toBe(true);
    expect((queue.jobs[0]!.data as { archivePath: string }).archivePath).toMatch(
      new RegExp(`/${repository!.id}\\.zip$`),
    );
    expect(staged.finished).toBe(absolute(repos, `_uploads/${USER}/${SESSION}.zip`));
  });

  it('leaves the finished archive recorded on the session, once', async () => {
    const staged = await stage(repos);

    await request(repos.app, 'POST', repos.completeUrl(SESSION));

    expect(await exists(staged.partial)).toBe(false);
    expect(rowOf(repos)).toMatchObject({ status: 'complete', archivePath: staged.finished });
    expect(fake.rows(schema.repositories)).toHaveLength(1);
    expect(queue.jobs).toHaveLength(1);
  });

  it('a repeat complete of a dead claim whose file already moved ends with the session id', async () => {
    const staged = await stage(repos, { status: 'completing', at: 'finished', idleMs: 11 * MIN });
    fake.patch(repos.table, SESSION, { archivePath: staged.partial });

    const res = await request(repos.app, 'POST', repos.completeUrl(SESSION));

    expect(res.status).toBe(201);
    expect(fake.rows(schema.repositories).map((r) => r.id)).toEqual([SESSION]);
  });
});

describe('I3a: a duplicate complete of a session another complete finished', () => {
  const [repos, dumps] = FAMILIES as [Family, Family, Family];

  it.each([repos, dumps])(
    '$name: a second complete after a successful first answers 409 session already completed, and creates nothing more',
    async (family) => {
      await stage(family);

      const first = await request(family.app, 'POST', family.completeUrl(SESSION));
      const second = await request(family.app, 'POST', family.completeUrl(SESSION));

      expect(first.status).toBe(201);
      expect(second.status).toBe(409);
      expect(await errorOf(second)).toBe('session already completed');
      expect(family.created()).toBe(family.made);
      expect(queue.jobs).toHaveLength(family.jobs);
    },
  );

  it('db-dumps: a consumed session answers 409 session already completed', async () => {
    await stage(dumps, { status: 'consumed' });

    const res = await request(dumps.app, 'POST', dumps.completeUrl(SESSION));

    expect(res.status).toBe(409);
    expect(await errorOf(res)).toBe('session already completed');
    expect(rowOf(dumps).status).toBe('consumed');
  });
});
