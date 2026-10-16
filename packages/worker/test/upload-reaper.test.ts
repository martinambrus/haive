import { randomUUID } from 'node:crypto';
import {
  lstat,
  lutimes,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { schema, type Database } from '@haive/database';
import { createFakeDb, type FakeRow } from '@haive/database/testing';
import { reapAbandonedUploads, startUploadReaper } from '../src/repo/upload-reaper.js';

const guard = vi.hoisted(() => ({ claims: 0 }));
// The fake db evaluates no subquery, so the live-task check of the ended-dump claim is dropped here
// and the pass's own read decides; upload-reaper-db.test.ts runs the statement as written on Postgres.
vi.mock('drizzle-orm', async (original) => ({
  ...(await original<typeof import('drizzle-orm')>()),
  notExists: () => {
    guard.claims += 1;
    return undefined;
  },
}));

const USER = 'aaaaaaaa-1111-4111-8111-111111111111';
const OTHER_USER = 'bbbbbbbb-2222-4222-8222-222222222222';
const REPO = 'cccccccc-3333-4333-8333-333333333333';
const MIN = 60_000;
const HOUR = 60 * MIN;
const TTL = 24 * HOUR;

type UploadTable =
  typeof schema.repoUploads | typeof schema.dbUploads | typeof schema.customBundleUploads;

interface Kind {
  name: string;
  table: UploadTable;
  pathKey: 'archivePath' | 'dumpPath';
  volume: 'repos' | 'bundles';
  partial: (id: string) => string;
  finished: (id: string) => string;
  columns: Record<string, unknown>;
}

const KINDS: Kind[] = [
  {
    name: 'repo_uploads',
    table: schema.repoUploads,
    pathKey: 'archivePath',
    volume: 'repos',
    partial: (id) => `${id}.zip.partial`,
    finished: (id) => `${id}.zip`,
    columns: { filename: 'a.zip', archiveFormat: 'zip' },
  },
  {
    name: 'db_uploads',
    table: schema.dbUploads,
    pathKey: 'dumpPath',
    volume: 'repos',
    partial: (id) => `db-${id}.sql.gz.partial`,
    finished: (id) => `db-${id}.sql.gz`,
    columns: { filename: 'a.sql.gz', dumpFormat: 'sql.gz' },
  },
  {
    name: 'custom_bundle_uploads',
    table: schema.customBundleUploads,
    pathKey: 'archivePath',
    volume: 'bundles',
    partial: (id) => `${id}.tar.gz.partial`,
    finished: (id) => `${id}.tar.gz`,
    columns: {
      repositoryId: REPO,
      name: 'kit',
      enabledKinds: ['agent', 'skill'],
      filename: 'a.tar.gz',
      archiveFormat: 'tar.gz',
    },
  },
];

let storage: string;
let roots: { repos: string; bundles: string };
let fake: ReturnType<typeof makeFake>;
const saved: Record<string, string | undefined> = {};

function makeFake() {
  return createFakeDb({
    repoUploads: schema.repoUploads,
    dbUploads: schema.dbUploads,
    customBundleUploads: schema.customBundleUploads,
    tasks: schema.tasks,
  });
}

const db = () => fake.db as unknown as Database;
const uploadsDir = (volume: 'repos' | 'bundles', user = USER) =>
  path.join(roots[volume], '_uploads', user);

beforeEach(async () => {
  storage = await mkdtemp(path.join(tmpdir(), 'upload-reaper-'));
  roots = { repos: path.join(storage, 'repos'), bundles: path.join(storage, 'bundles') };
  for (const [env, root] of [
    ['REPO_STORAGE_ROOT', roots.repos],
    ['BUNDLE_STORAGE_ROOT', roots.bundles],
  ] as const) {
    saved[env] = process.env[env];
    process.env[env] = root;
  }
  await mkdir(uploadsDir('repos'), { recursive: true });
  await mkdir(uploadsDir('bundles'), { recursive: true });
  fake = makeFake();
  guard.claims = 0;
});

afterEach(async () => {
  vi.useRealTimers();
  for (const env of ['REPO_STORAGE_ROOT', 'BUNDLE_STORAGE_ROOT']) {
    if (saved[env] === undefined) delete process.env[env];
    else process.env[env] = saved[env];
  }
  await rm(storage, { recursive: true, force: true });
});

async function age(file: string, ms: number): Promise<void> {
  const when = new Date(Date.now() - ms);
  await utimes(file, when, when);
}
const exists = async (file: string) => (await lstat(file).catch(() => null)) !== null;
const rowOf = (kind: Kind, id: string): FakeRow => {
  const row = fake.rows(kind.table).find((r) => r.id === id);
  if (!row) throw new Error(`no ${kind.name} row ${id}`);
  return row;
};

interface Session {
  id: string;
  file: string;
}

// A session row and the file it names; the file's mtime defaults to the row's idle time.
async function session(
  kind: Kind,
  opts: {
    idleMs: number;
    fileAgeMs?: number;
    status?: string;
    name?: (id: string) => string;
  },
): Promise<Session> {
  const id = randomUUID();
  const file = path.join(uploadsDir(kind.volume), (opts.name ?? kind.partial)(id));
  await writeFile(file, 'partial bytes');
  await age(file, opts.fileAgeMs ?? opts.idleMs);
  fake.insert(kind.table, {
    id,
    userId: USER,
    totalSize: 100,
    bytesReceived: 13,
    chunkSize: 13,
    status: opts.status ?? 'uploading',
    updatedAt: new Date(Date.now() - opts.idleMs),
    [kind.pathKey]: file,
    ...kind.columns,
  });
  return { id, file };
}

describe('U1: the row pass reaps an upload idle for 24 hours', () => {
  describe.each(KINDS)('$name', (kind) => {
    it('takes a session idle 24 h + 1 min: it is cancelled and its partial is gone', async () => {
      const stale = await session(kind, { idleMs: TTL + MIN });

      await reapAbandonedUploads(db());

      expect(rowOf(kind, stale.id).status).toBe('cancelled');
      expect(await exists(stale.file)).toBe(false);
    });

    it('keeps a session idle 24 h - 1 min with its partial', async () => {
      const fresh = await session(kind, { idleMs: TTL - MIN });

      await reapAbandonedUploads(db());

      expect(rowOf(kind, fresh.id).status).toBe('uploading');
      expect(await readFile(fresh.file, 'utf8')).toBe('partial bytes');
    });

    it('takes only the stale one of two sessions', async () => {
      const stale = await session(kind, { idleMs: TTL + MIN });
      const fresh = await session(kind, { idleMs: MIN });

      await reapAbandonedUploads(db());

      expect(rowOf(kind, stale.id).status).toBe('cancelled');
      expect(rowOf(kind, fresh.id).status).toBe('uploading');
      expect(await exists(stale.file)).toBe(false);
      expect(await exists(fresh.file)).toBe(true);
    });

    it('removes the partial of a row it took whatever the file’s mtime says', async () => {
      const stale = await session(kind, { idleMs: TTL + MIN, fileAgeMs: MIN });

      await reapAbandonedUploads(db());

      expect(rowOf(kind, stale.id).status).toBe('cancelled');
      expect(await exists(stale.file)).toBe(false);
    });

    // A complete dump that no task links is the ended-dump pass's to take once it is old (U5).
    it.each(
      kind.table === schema.dbUploads
        ? ['cancelled', 'consumed']
        : ['complete', 'cancelled', 'consumed'],
    )('leaves a stale %s session and its file alone', async (status) => {
      const done = await session(kind, {
        idleMs: 3 * TTL,
        status,
        name: kind.finished,
      });

      await reapAbandonedUploads(db());

      expect(rowOf(kind, done.id).status).toBe(status);
      expect(await exists(done.file)).toBe(true);
    });

    it('leaves a directory standing at a reaped row’s partial name', async () => {
      const id = randomUUID();
      const dir = path.join(uploadsDir(kind.volume), kind.partial(id));
      await mkdir(dir);
      fake.insert(kind.table, {
        id,
        userId: USER,
        totalSize: 1,
        bytesReceived: 1,
        chunkSize: 1,
        status: 'uploading',
        updatedAt: new Date(Date.now() - TTL - MIN),
        [kind.pathKey]: dir,
        ...kind.columns,
      });

      await reapAbandonedUploads(db());

      expect(rowOf(kind, id).status).toBe('cancelled');
      expect((await stat(dir)).isDirectory()).toBe(true);
    });

    it('leaves a row whose path is not a session file of its owner, and cancels it', async () => {
      const outside = path.join(storage, 'precious.bin');
      await writeFile(outside, 'keep me');
      const id = randomUUID();
      fake.insert(kind.table, {
        id,
        userId: USER,
        totalSize: 1,
        bytesReceived: 1,
        chunkSize: 1,
        status: 'uploading',
        updatedAt: new Date(Date.now() - TTL - MIN),
        [kind.pathKey]: outside,
        ...kind.columns,
      });

      await reapAbandonedUploads(db());

      expect(rowOf(kind, id).status).toBe('cancelled');
      expect(await readFile(outside, 'utf8')).toBe('keep me');
    });

    it('leaves the partial of another user’s directory when the row names that owner', async () => {
      await mkdir(uploadsDir(kind.volume, OTHER_USER), { recursive: true });
      const id = randomUUID();
      const foreign = path.join(uploadsDir(kind.volume, OTHER_USER), kind.partial(id));
      await writeFile(foreign, 'theirs');
      await age(foreign, MIN);
      fake.insert(kind.table, {
        id,
        userId: USER,
        totalSize: 1,
        bytesReceived: 1,
        chunkSize: 1,
        status: 'uploading',
        updatedAt: new Date(Date.now() - TTL - MIN),
        [kind.pathKey]: foreign,
        ...kind.columns,
      });

      await reapAbandonedUploads(db());

      expect(rowOf(kind, id).status).toBe('cancelled');
      expect(await exists(foreign)).toBe(true);
    });
  });
});

describe('U2: the file pass reaps a session partial nothing names', () => {
  const uuid = () => randomUUID();

  async function put(volume: 'repos' | 'bundles', name: string, ageMs: number, user = USER) {
    const file = path.join(uploadsDir(volume, user), name);
    await writeFile(file, 'bytes');
    await age(file, ageMs);
    return file;
  }

  it('removes an orphan partial with an old mtime, and keeps what is not one', async () => {
    const orphan = await put('repos', `${uuid()}.zip.partial`, TTL + MIN);
    const orphanTar = await put('repos', `${uuid()}.tar.gz.partial`, TTL + MIN);
    const orphanDump = await put('repos', `db-${uuid()}.sql.gz.partial`, TTL + MIN);
    const orphanBundle = await put('bundles', `${uuid()}.tar.partial`, TTL + MIN);
    const fresh = await put('repos', `${uuid()}.zip.partial`, TTL - MIN);
    const sound = await put('repos', 'notification-sound.mp3', 3 * TTL);
    const archive = await put('repos', `${uuid()}.zip`, 3 * TTL);
    const dump = await put('repos', `db-${uuid()}.sql`, 3 * TTL);
    const notUuid = await put('repos', 'report.zip.partial', 3 * TTL);
    const wrongExt = await put('repos', `${uuid()}.rar.partial`, 3 * TTL);
    const suffixed = await put('repos', `${uuid()}.zip.partial.bak`, 3 * TTL);
    const upper = await put('repos', `${uuid().toUpperCase()}.zip.partial`, 3 * TTL);
    const longExt = await put('repos', `db-${uuid()}.${'a'.repeat(17)}.partial`, 3 * TTL);

    await reapAbandonedUploads(db());

    for (const gone of [orphan, orphanTar, orphanDump, orphanBundle]) {
      expect(await exists(gone), gone).toBe(false);
    }
    for (const kept of [fresh, sound, archive, dump, notUuid, wrongExt, suffixed, upper, longExt]) {
      expect(await exists(kept), kept).toBe(true);
    }
  });

  it('keeps an old partial that an uploading session names, in any of the three tables', async () => {
    const named = await Promise.all(
      KINDS.map(async (kind) => {
        const id = uuid();
        const file = await put(kind.volume, kind.partial(id), TTL + 5 * MIN);
        fake.insert(kind.table, {
          id,
          userId: USER,
          totalSize: 100,
          bytesReceived: 13,
          chunkSize: 13,
          status: 'uploading',
          updatedAt: new Date(Date.now() - (TTL - MIN)),
          [kind.pathKey]: file,
          ...kind.columns,
        });
        return file;
      }),
    );

    await reapAbandonedUploads(db());

    for (const file of named) expect(await exists(file), file).toBe(true);
  });

  it('keeps a partial that a session of another kind names', async () => {
    const id = uuid();
    const file = await put('repos', `${id}.zip.partial`, TTL + 5 * MIN);
    fake.insert(schema.customBundleUploads, {
      id,
      userId: USER,
      totalSize: 100,
      bytesReceived: 13,
      chunkSize: 13,
      status: 'uploading',
      updatedAt: new Date(Date.now() - (TTL - MIN)),
      archivePath: file,
      ...KINDS[2]!.columns,
    });

    await reapAbandonedUploads(db());

    expect(await exists(file)).toBe(true);
  });

  it('removes a partial that a cancelled or complete session last updated 25 h ago names', async () => {
    const files = await Promise.all(
      ['cancelled', 'complete'].map(async (status) => {
        const id = uuid();
        const file = await put('repos', `${id}.zip.partial`, TTL + MIN);
        fake.insert(schema.repoUploads, {
          id,
          userId: USER,
          totalSize: 100,
          bytesReceived: 13,
          chunkSize: 13,
          status,
          updatedAt: new Date(Date.now() - TTL - HOUR),
          archivePath: file,
          filename: 'a.zip',
          archiveFormat: 'zip',
        });
        return file;
      }),
    );

    await reapAbandonedUploads(db());

    for (const file of files) expect(await exists(file), file).toBe(false);
  });

  // A complete flips its row to the final path before the partial moves, so for that moment no
  // uploading row names the partial; the session's id and its last update still do.
  describe.each(KINDS)('a $name partial whose session a complete has claimed', (kind) => {
    async function partialOf(row: { status: string; updatedAgoMs: number } | null) {
      const id = uuid();
      const partial = await put(kind.volume, kind.partial(id), TTL + 5 * MIN);
      if (row !== null) {
        fake.insert(kind.table, {
          id,
          userId: USER,
          totalSize: 100,
          bytesReceived: 100,
          chunkSize: 13,
          status: row.status,
          updatedAt: new Date(Date.now() - row.updatedAgoMs),
          [kind.pathKey]: partial.replace(/\.partial$/, ''),
          ...kind.columns,
        });
      }
      return partial;
    }

    it.each(['complete', 'cancelled'])(
      'is kept while the %s row was updated just now',
      async (status) => {
        const partial = await partialOf({ status, updatedAgoMs: 0 });

        await reapAbandonedUploads(db());

        expect(await exists(partial)).toBe(true);
      },
    );

    it('is removed once the row was last updated 25 h ago', async () => {
      const partial = await partialOf({ status: 'cancelled', updatedAgoMs: TTL + HOUR });

      await reapAbandonedUploads(db());

      expect(await exists(partial)).toBe(false);
    });

    it('is removed when no row names the session', async () => {
      const partial = await partialOf(null);

      await reapAbandonedUploads(db());

      expect(await exists(partial)).toBe(false);
    });
  });

  it('removes a link named like a partial as a link, and leaves its target intact', async () => {
    const target = path.join(storage, 'target.bin');
    await writeFile(target, 'the target');
    const link = path.join(uploadsDir('repos'), `${uuid()}.zip.partial`);
    await symlink(target, link);
    await lutimes(link, new Date(Date.now() - 3 * TTL), new Date(Date.now() - 3 * TTL));

    await reapAbandonedUploads(db());

    expect(await exists(link)).toBe(false);
    expect(await readFile(target, 'utf8')).toBe('the target');
  });

  it('keeps a link named like a partial while it is fresh', async () => {
    const target = path.join(storage, 'target.bin');
    await writeFile(target, 'the target');
    const link = path.join(uploadsDir('repos'), `${uuid()}.zip.partial`);
    await symlink(target, link);

    await reapAbandonedUploads(db());

    expect(await exists(link)).toBe(true);
    expect(await readFile(target, 'utf8')).toBe('the target');
  });

  it('keeps a directory named like a partial, empty or not', async () => {
    const empty = path.join(uploadsDir('repos'), `${uuid()}.zip.partial`);
    const full = path.join(uploadsDir('repos'), `${uuid()}.tar.gz.partial`);
    await mkdir(empty);
    await mkdir(full);
    await writeFile(path.join(full, 'inner.txt'), 'inner');
    await age(empty, 3 * TTL);
    await age(full, 3 * TTL);

    await reapAbandonedUploads(db());

    expect((await stat(empty)).isDirectory()).toBe(true);
    expect(await readFile(path.join(full, 'inner.txt'), 'utf8')).toBe('inner');
  });

  it('reaches the partials of a user directory no user row owns any more', async () => {
    await mkdir(uploadsDir('repos', OTHER_USER), { recursive: true });
    const orphan = await put('repos', `${uuid()}.zip.partial`, 3 * TTL, OTHER_USER);

    await reapAbandonedUploads(db());

    expect(await exists(orphan)).toBe(false);
    expect((await stat(uploadsDir('repos', OTHER_USER))).isDirectory()).toBe(true);
  });

  it('copes with a storage root that has no _uploads directory and a stray file in it', async () => {
    await rm(path.join(roots.bundles, '_uploads'), { recursive: true });
    await writeFile(path.join(roots.repos, '_uploads', 'stray.txt'), 'stray');

    await expect(reapAbandonedUploads(db())).resolves.toBeDefined();
    expect(await exists(path.join(roots.repos, '_uploads', 'stray.txt'))).toBe(true);
  });

  it('removes an orphan in batches larger than one query', async () => {
    const files: string[] = [];
    for (let i = 0; i < 250; i += 1) {
      files.push(await put('repos', `${uuid()}.zip.partial`, TTL + MIN));
    }
    const namedId = uuid();
    const named = await put('repos', `${namedId}.zip.partial`, TTL + MIN);
    fake.insert(schema.repoUploads, {
      id: namedId,
      userId: USER,
      totalSize: 1,
      bytesReceived: 1,
      chunkSize: 1,
      status: 'uploading',
      updatedAt: new Date(),
      archivePath: named,
      filename: 'a.zip',
      archiveFormat: 'zip',
    });

    await reapAbandonedUploads(db());

    expect(await Promise.all(files.map(exists))).not.toContain(true);
    expect(await exists(named)).toBe(true);
  });
});

describe('U5: a completed dump whose task ended without importing it', () => {
  const dumps = KINDS[1]!;
  const ENDED = ['cancelled', 'failed', 'completed'];
  const LIVE = ['created', 'queued', 'running', 'paused', 'waiting_user', 'waiting_pr'];

  async function dump(
    opts: { status?: string; idleMs?: number; name?: (id: string) => string } = {},
  ) {
    return session(dumps, {
      idleMs: opts.idleMs ?? 5 * TTL,
      status: opts.status ?? 'complete',
      name: opts.name ?? dumps.finished,
    });
  }

  function task(dumpId: string | null, status: string, updatedAgoMs: number): void {
    fake.insert(schema.tasks, {
      id: randomUUID(),
      userId: USER,
      dbUploadId: dumpId,
      status,
      updatedAt: new Date(Date.now() - updatedAgoMs),
    });
  }

  it.each(ENDED)(
    'removes the dump of a %s task that has been idle 24 h + 1 min',
    async (status) => {
      const upload = await dump();
      task(upload.id, status, TTL + MIN);

      await reapAbandonedUploads(db());

      expect(rowOf(dumps, upload.id).status).toBe('cancelled');
      expect(await exists(upload.file)).toBe(false);
    },
  );

  it.each(ENDED)('keeps the dump of a %s task that ended less than 24 h ago', async (status) => {
    const upload = await dump();
    task(upload.id, status, TTL - MIN);

    await reapAbandonedUploads(db());

    expect(rowOf(dumps, upload.id).status).toBe('complete');
    expect(await exists(upload.file)).toBe(true);
  });

  it.each(LIVE)('keeps the dump of a %s task', async (status) => {
    const upload = await dump();
    task(upload.id, status, 5 * TTL);

    await reapAbandonedUploads(db());

    expect(rowOf(dumps, upload.id).status).toBe('complete');
    expect(await exists(upload.file)).toBe(true);
  });

  it('keeps a dump that one ended task and one live task name', async () => {
    const upload = await dump();
    task(upload.id, 'cancelled', 5 * TTL);
    task(upload.id, 'running', 5 * TTL);

    await reapAbandonedUploads(db());

    expect(rowOf(dumps, upload.id).status).toBe('complete');
    expect(await exists(upload.file)).toBe(true);
  });

  it('removes a dump whose tasks have all ended', async () => {
    const upload = await dump();
    task(upload.id, 'cancelled', 5 * TTL);
    task(upload.id, 'failed', 5 * TTL);

    await reapAbandonedUploads(db());

    expect(rowOf(dumps, upload.id).status).toBe('cancelled');
    expect(await exists(upload.file)).toBe(false);
  });

  it('removes a dump no task names once it is idle 24 h + 1 hour', async () => {
    const upload = await dump({ idleMs: TTL + HOUR });
    task(null, 'cancelled', 5 * TTL);

    await reapAbandonedUploads(db());

    expect(rowOf(dumps, upload.id).status).toBe('cancelled');
    expect(await exists(upload.file)).toBe(false);
  });

  it('keeps a dump no task names while it is idle 24 h - 1 hour, since task creation follows the upload', async () => {
    const upload = await dump({ idleMs: TTL - HOUR });

    await reapAbandonedUploads(db());

    expect(rowOf(dumps, upload.id).status).toBe('complete');
    expect(await exists(upload.file)).toBe(true);
  });

  it('claims a dump with the live-task check inside the same statement', async () => {
    const upload = await dump();
    task(upload.id, 'cancelled', 5 * TTL);

    await reapAbandonedUploads(db());

    expect(rowOf(dumps, upload.id).status).toBe('cancelled');
    expect(guard.claims).toBe(1);
  });

  it('leaves a dump the import consumed after the check', async () => {
    const upload = await dump();
    task(upload.id, 'cancelled', 5 * TTL);
    let dumpWrites = 0;
    fake.hooks.beforeUpdate = (table) => {
      // The first write to the dump table is the idle-session pass; the second is this claim.
      if (table === schema.dbUploads && (dumpWrites += 1) === 2) {
        fake.patch(schema.dbUploads, upload.id, { status: 'consumed' });
      }
    };

    await reapAbandonedUploads(db());

    expect(rowOf(dumps, upload.id).status).toBe('consumed');
    expect(await exists(upload.file)).toBe(true);
  });

  it('leaves a consumed dump row as it is', async () => {
    const upload = await dump({ status: 'consumed' });
    task(upload.id, 'completed', 5 * TTL);

    await reapAbandonedUploads(db());

    expect(rowOf(dumps, upload.id).status).toBe('consumed');
  });

  it('leaves a dump whose path is not a dump file of its owner, complete', async () => {
    const outside = path.join(storage, 'precious.sql');
    await writeFile(outside, 'keep me');
    const id = randomUUID();
    fake.insert(schema.dbUploads, {
      id,
      userId: USER,
      totalSize: 1,
      bytesReceived: 1,
      chunkSize: 1,
      status: 'complete',
      updatedAt: new Date(Date.now() - 5 * TTL),
      dumpPath: outside,
      filename: 'a.sql',
      dumpFormat: 'sql',
    });
    task(id, 'cancelled', 5 * TTL);

    await reapAbandonedUploads(db());

    expect(rowOf(dumps, id).status).toBe('complete');
    expect(await readFile(outside, 'utf8')).toBe('keep me');
  });

  it('does not remove the finished archive of a repository upload', async () => {
    const archive = await session(KINDS[0]!, {
      idleMs: 5 * TTL,
      status: 'complete',
      name: KINDS[0]!.finished,
    });

    await reapAbandonedUploads(db());

    expect(await exists(archive.file)).toBe(true);
  });
});

describe('startUploadReaper', () => {
  it('runs a pass at start and every 15 minutes, and stops when asked', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const stale = await session(KINDS[0]!, { idleMs: TTL + MIN });
    let claims = 0;
    fake.hooks.beforeUpdate = (table) => {
      if (table === schema.repoUploads) claims += 1;
    };

    const stop = startUploadReaper(db());
    await vi.waitFor(() => expect(claims).toBe(1), { timeout: 10_000 });
    expect(rowOf(KINDS[0]!, stale.id).status).toBe('cancelled');

    // A tick that lands while the first pass still runs is dropped by the single-flight flag.
    await vi.waitFor(
      async () => {
        await vi.advanceTimersByTimeAsync(15 * MIN);
        expect(claims).toBe(2);
      },
      { timeout: 10_000 },
    );

    stop();
    await vi.advanceTimersByTimeAsync(45 * MIN);
    expect(claims).toBe(2);
  });
});
