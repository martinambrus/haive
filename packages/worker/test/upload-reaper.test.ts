import { randomUUID } from 'node:crypto';
import {
  lstat,
  lutimes,
  mkdir,
  mkdtemp,
  readFile,
  rename,
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
import { placeReplacementArchive, replacementArchiveRel } from '@haive/shared/bundle-replacement';
import { reapAbandonedUploads, startUploadReaper } from '../src/repo/upload-reaper.js';

const guard = vi.hoisted(() => ({
  claims: 0,
  removals: 0,
  removal: null as null | ((rel: string) => boolean),
  errors: [] as unknown[][],
  warnings: [] as unknown[][],
  debugs: [] as unknown[][],
  removalCode: 'EACCES' as string | undefined,
  statFailure: null as string | null,
  ignoreParkedProtection: false,
  replacementRemovalFailure: false,
}));
vi.mock('@haive/shared', async (importOriginal) => {
  const real = await importOriginal<typeof import('@haive/shared')>();
  return {
    ...real,
    logger: {
      ...real.logger,
      child: () => ({
        info: () => undefined,
        warn: (...args: unknown[]) => guard.warnings.push(args),
        debug: (...args: unknown[]) => guard.debugs.push(args),
        error: (...args: unknown[]) => guard.errors.push(args),
      }),
    },
  };
});
vi.mock('@haive/shared/fs-safe', async (importOriginal) => {
  const real = await importOriginal<typeof import('@haive/shared/fs-safe')>();
  return {
    ...real,
    removeFileIfIdentityNoFollow: async (
      ...args: Parameters<typeof real.removeFileIfIdentityNoFollow>
    ) => {
      if (guard.replacementRemovalFailure)
        throw Object.assign(new Error('replacement unlink refused'), { code: 'EACCES' });
      return real.removeFileIfIdentityNoFollow(...args);
    },
    lstatNoFollow: async (...args: Parameters<typeof real.lstatNoFollow>) => {
      if (guard.statFailure && args[1].endsWith('.partial')) {
        const err =
          guard.statFailure === 'containment'
            ? new real.PathContainmentError('link', args[0], args[1], args[1])
            : Object.assign(new Error('the stat failed'), { code: guard.statFailure });
        if (args[2]?.strict) throw err;
        return null;
      }
      return real.lstatNoFollow(...args);
    },
    removeNoFollow: async (...args: Parameters<typeof real.removeNoFollow>) => {
      if (guard.removal?.(args[1])) {
        guard.removals += 1;
        throw Object.assign(new Error('the removal failed'), { code: guard.removalCode });
      }
      return real.removeNoFollow(...args);
    },
  };
});
// The fake db evaluates no subquery, so the live-task check of the ended-dump claim is dropped here
// and the pass's own read decides; upload-reaper-db.test.ts runs the statement as written on Postgres.
vi.mock('drizzle-orm', async (original) => {
  const real = await original<typeof import('drizzle-orm')>();
  return {
    ...real,
    // The fake db supports gt and eq but not gte.
    gte: (...args: Parameters<typeof real.gte>) => real.or(real.gt(...args), real.eq(...args)),
    eq: (...args: Parameters<typeof real.eq>) =>
      guard.ignoreParkedProtection &&
      args[0] === schema.dbUploads.status &&
      args[1] === 'reap_failed'
        ? real.eq(schema.dbUploads.updatedAt, new Date(0))
        : real.eq(...args),
    notExists: () => {
      guard.claims += 1;
      return undefined;
    },
  };
});

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
    customBundles: schema.customBundles,
    tasks: schema.tasks,
    repositories: schema.repositories,
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
  guard.removals = 0;
  guard.errors = [];
  guard.warnings = [];
  guard.debugs = [];
  guard.removalCode = 'EACCES';
  guard.removal = null;
  guard.statFailure = null;
  guard.ignoreParkedProtection = false;
  guard.replacementRemovalFailure = false;
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

function repository(id: string, status: 'cloning' | 'ready' | 'error'): void {
  fake.insert(schema.repositories, {
    id,
    userId: USER,
    name: 'r',
    source: 'upload',
    storagePath: '/x',
    status,
  });
}

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

describe('replacement archive ownership during reaping', () => {
  describe.each(['malformed intent', 'linked intent', 'conditional unlink refusal'])(
    '%s',
    (failure) => {
      it.each([TTL - HOUR, TTL + HOUR])(
        'accounts for cleanup failure at age %s without losing the archive or intent',
        async (idleMs) => {
          const kind = KINDS[2]!;
          const upload = await session(kind, { idleMs, status: 'reaping' });
          const bundleId = randomUUID();
          const partial = `_uploads/${USER}/${path.basename(upload.file)}`;
          const final = replacementArchiveRel(USER, bundleId, upload.id, 'tar.gz');
          await placeReplacementArchive(roots.bundles, partial, final, 13);
          fake.patch(schema.customBundleUploads, upload.id, {
            bundleId,
            totalSize: 13,
            bytesReceived: 13,
          });
          fake.insert(schema.customBundles, {
            id: bundleId,
            userId: USER,
            archivePath: path.join(roots.bundles, USER, bundleId, 'source.zip'),
          });
          const archive = path.join(roots.bundles, final);
          const intent = `${archive}.move.json`;
          if (failure === 'malformed intent') await writeFile(intent, '{invalid JSON');
          else if (failure === 'linked intent') {
            await rename(intent, `${intent}.original`);
            await symlink(`${intent}.original`, intent);
          } else guard.replacementRemovalFailure = true;
          const intentBytes = await readFile(intent);
          // The final archive is unknown/undeletable; its harmless partial can still be removed.
          await writeFile(upload.file, 'partial remains from the interrupted attempt');

          const result = await reapAbandonedUploads(db());

          expect(rowOf(kind, upload.id).status).toBe(idleMs > TTL ? 'reap_failed' : 'reaping');
          expect(result.sessions).toBe(0);
          expect(await readFile(archive, 'utf8')).toBe('partial bytes');
          expect(await readFile(intent)).toEqual(intentBytes);
          expect(await exists(upload.file)).toBe(false);
          expect(guard.errors).toHaveLength(idleMs > TTL ? 1 : 0);
          if (idleMs > TTL) {
            await reapAbandonedUploads(db());
            expect(rowOf(kind, upload.id).status).toBe('reap_failed');
            expect(guard.errors).toHaveLength(1);
          }
        },
      );
    },
  );
  it.each([false, true])(
    'removes an unpromoted replacement and preserves an active source (active=%s)',
    async (active) => {
      const kind = KINDS[2]!;
      const upload = await session(kind, { idleMs: TTL + HOUR });
      const bundleId = randomUUID();
      const partial = `_uploads/${USER}/${path.basename(upload.file)}`;
      const final = replacementArchiveRel(USER, bundleId, upload.id, 'tar.gz');
      await placeReplacementArchive(roots.bundles, partial, final, 13);
      fake.patch(schema.customBundleUploads, upload.id, {
        bundleId,
        totalSize: 13,
        bytesReceived: 13,
      });
      fake.insert(schema.customBundles, {
        id: bundleId,
        userId: USER,
        archivePath: path.join(roots.bundles, active ? final : `${USER}/${bundleId}/source.zip`),
      });

      expect((await reapAbandonedUploads(db())).sessions).toBe(1);

      expect(rowOf(kind, upload.id).status).toBe('cancelled');
      expect(await exists(path.join(roots.bundles, final))).toBe(active);
      expect(await exists(`${path.join(roots.bundles, final)}.move.json`)).toBe(active);
    },
  );
});

describe('T323: unreadable reaping files', () => {
  describe.each(KINDS)('$name', (kind) => {
    it.each(['EACCES', 'containment'])(
      'keeps an unreadable file reaping after a stat refusal: %s',
      async (reason) => {
        const stuck = await session(kind, { idleMs: TTL - HOUR, status: 'reaping' });
        guard.statFailure = reason;

        const result = await reapAbandonedUploads(db());

        expect(rowOf(kind, stuck.id).status).toBe('reaping');
        expect(await exists(stuck.file)).toBe(true);
        expect(result.sessions).toBe(0);
        expect(guard.errors).toHaveLength(0);

        guard.statFailure = null;
        expect((await reapAbandonedUploads(db())).sessions).toBe(1);
        expect(rowOf(kind, stuck.id).status).toBe('cancelled');
        expect(await exists(stuck.file)).toBe(false);
      },
    );

    it.each(['EACCES', 'containment'])(
      'parks a file still unreadable after 24 hours: %s',
      async (reason) => {
        const stuck = await session(kind, { idleMs: TTL + HOUR, status: 'reaping' });
        guard.statFailure = reason;

        const result = await reapAbandonedUploads(db());

        expect(rowOf(kind, stuck.id).status).toBe('reap_failed');
        expect(await exists(stuck.file)).toBe(true);
        expect(result.sessions).toBe(0);
        expect(guard.errors).toHaveLength(1);

        await reapAbandonedUploads(db());
        expect(rowOf(kind, stuck.id).status).toBe('reap_failed');
        expect(guard.errors).toHaveLength(1);
      },
    );
  });
});

describe('T323: invalid completed dump paths', () => {
  it('bounds invalid-path warning history by row id without evicting remembered rows', async () => {
    const reap = reapAbandonedUploads;
    for (let i = 0; i < 1001; i += 1) {
      fake.insert(schema.dbUploads, {
        id: randomUUID(),
        userId: USER,
        totalSize: 1,
        bytesReceived: 1,
        chunkSize: 1,
        status: 'complete',
        updatedAt: new Date(Date.now() - 5 * TTL),
        dumpPath: path.join(storage, 'not-owned.sql'),
        filename: 'a.sql',
        dumpFormat: 'sql',
      });
    }

    await reap(db());
    expect(guard.warnings).toHaveLength(1001);
    await reap(db());
    expect(guard.warnings).toHaveLength(1002);
    expect(guard.debugs).toHaveLength(1000);
    await reap(db());
    expect(guard.warnings).toHaveLength(1003);
    expect(guard.debugs).toHaveLength(2000);
    expect(new Set(guard.warnings.map(([data]) => (data as { dumpId: string }).dumpId)).size).toBe(
      1001,
    );
    expect(fake.rows(schema.dbUploads).every((row) => row.status === 'complete')).toBe(true);
  });
});

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
    it.each(kind.table === schema.dbUploads ? ['consumed'] : ['complete', 'consumed'])(
      'leaves a stale %s session and its file alone',
      async (status) => {
        const done = await session(kind, {
          idleMs: 3 * TTL,
          status,
          name: kind.finished,
        });
        if (kind.table === schema.repoUploads) repository(done.id, 'cloning');

        await reapAbandonedUploads(db());

        expect(rowOf(kind, done.id).status).toBe(status);
        expect(await exists(done.file)).toBe(true);
      },
    );

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

// A complete parks its session in completing, naming the partial; one that died there is reaped.
describe('A2: the row pass reaps a session left in completing', () => {
  describe.each(KINDS)('$name', (kind) => {
    it('takes a session idle 24 h + 1 min: it is cancelled and its partial is gone', async () => {
      const stale = await session(kind, { idleMs: TTL + MIN, status: 'completing' });

      await reapAbandonedUploads(db());

      expect(rowOf(kind, stale.id).status).toBe('cancelled');
      expect(await exists(stale.file)).toBe(false);
    });

    it('keeps a session idle 23 h with its partial', async () => {
      const fresh = await session(kind, { idleMs: 23 * HOUR, status: 'completing' });

      await reapAbandonedUploads(db());

      expect(rowOf(kind, fresh.id).status).toBe('completing');
      expect(await readFile(fresh.file, 'utf8')).toBe('partial bytes');
    });
  });
});

// A complete that failed after its move: the row names the partial, only the final file exists.
async function movedFinal(kind: Kind, opts: { idleMs: number; status: string }): Promise<Session> {
  const stale = await session(kind, opts);
  const finished = stale.file.replace(/\.partial$/, '');
  await rename(stale.file, finished);
  return { id: stale.id, file: finished };
}

describe('A3: the row pass takes the finished file a complete left behind', () => {
  const repos = KINDS[0]!;
  const dumps = KINDS[1]!;
  const bundles = KINDS[2]!;

  describe.each([repos, dumps])('$name', (kind) => {
    it.each(['uploading', 'completing'])(
      'cancels a stale %s session whose only file is the final one, and removes it',
      async (status) => {
        const stale = await movedFinal(kind, { idleMs: TTL + MIN, status });

        await reapAbandonedUploads(db());

        expect(rowOf(kind, stale.id).status).toBe('cancelled');
        expect(await exists(stale.file)).toBe(false);
      },
    );

    it('keeps the final file of a session idle 23 h, whose complete may still be running', async () => {
      const fresh = await movedFinal(kind, { idleMs: 23 * HOUR, status: 'completing' });

      await reapAbandonedUploads(db());

      expect(rowOf(kind, fresh.id).status).toBe('completing');
      expect(await exists(fresh.file)).toBe(true);
    });
  });

  it('removes a link at the final name as a link, and leaves its target', async () => {
    const stale = await session(repos, { idleMs: TTL + MIN });
    await rm(stale.file);
    const finished = stale.file.replace(/\.partial$/, '');
    const target = path.join(storage, 'target.bin');
    await writeFile(target, 'the target');
    await symlink(target, finished);

    await reapAbandonedUploads(db());

    expect(await exists(finished)).toBe(false);
    expect(await readFile(target, 'utf8')).toBe('the target');
  });

  it('leaves a directory standing at the final name, and still cancels the session', async () => {
    const stale = await session(repos, { idleMs: TTL + MIN });
    await rm(stale.file);
    const finished = stale.file.replace(/\.partial$/, '');
    await mkdir(finished);

    await reapAbandonedUploads(db());

    expect(rowOf(repos, stale.id).status).toBe('cancelled');
    expect((await stat(finished)).isDirectory()).toBe(true);
  });

  it('keeps a final-named file of a stale bundle session, whose final path belongs to the bundle', async () => {
    const stale = await movedFinal(bundles, { idleMs: TTL + MIN, status: 'uploading' });

    await reapAbandonedUploads(db());

    expect(rowOf(bundles, stale.id).status).toBe('cancelled');
    expect(await exists(stale.file)).toBe(true);
  });

  it('keeps the final file of a complete repository session beside the stale one it removes', async () => {
    const stale = await movedFinal(repos, { idleMs: TTL + MIN, status: 'uploading' });
    const done = await session(repos, {
      idleMs: 3 * TTL,
      status: 'complete',
      name: repos.finished,
    });
    repository(done.id, 'cloning');

    await reapAbandonedUploads(db());

    expect(await exists(stale.file)).toBe(false);
    expect(rowOf(repos, done.id).status).toBe('complete');
    expect(await exists(done.file)).toBe(true);
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

    for (const gone of [orphan, orphanTar, orphanDump, orphanBundle, archive, dump]) {
      expect(await exists(gone), gone).toBe(false);
    }
    for (const kept of [fresh, sound, notUuid, wrongExt, suffixed, upper, longExt]) {
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

  describe('a claimed dump stays reaping until its file is gone', () => {
    const dumpFilesFail = () => {
      guard.removal = (rel) => rel.endsWith('.sql.gz');
    };

    it('leaves the row reaping with its file when the removal fails, and the next pass finishes it', async () => {
      const upload = await dump();
      task(upload.id, 'cancelled', 5 * TTL);
      dumpFilesFail();

      const failed = await reapAbandonedUploads(db());

      expect(rowOf(dumps, upload.id).status).toBe('reaping');
      expect(await exists(upload.file)).toBe(true);
      expect(failed.dumps).toBe(0);

      guard.removal = null;
      const finished = await reapAbandonedUploads(db());

      expect(rowOf(dumps, upload.id).status).toBe('cancelled');
      expect(await exists(upload.file)).toBe(false);
      expect(finished.dumps).toBe(1);
    });

    it.each([
      ['just now, beside an ended task', 0, 'cancelled'],
      ['5 days ago, beside a live task', 5 * TTL, 'running'],
      ['5 days ago, beside no task', 5 * TTL, null],
    ] as const)(
      'finishes a row a dead worker left reaping, updated %s',
      async (_name, idleMs, taskStatus) => {
        const upload = await dump({ status: 'reaping', idleMs });
        if (taskStatus !== null) task(upload.id, taskStatus, 5 * TTL);

        const result = await reapAbandonedUploads(db());

        expect(rowOf(dumps, upload.id).status).toBe('cancelled');
        expect(await exists(upload.file)).toBe(false);
        expect(result.dumps).toBe(1);
      },
    );

    it('finishes a reaping row whose file is already gone', async () => {
      const upload = await dump({ status: 'reaping', idleMs: 0 });
      await rm(upload.file);

      const result = await reapAbandonedUploads(db());

      expect(rowOf(dumps, upload.id).status).toBe('cancelled');
      expect(result.dumps).toBe(1);
    });

    it('is left alone by the session and file passes, which still take what is theirs', async () => {
      const upload = await dump({ status: 'reaping', idleMs: HOUR });
      dumpFilesFail();
      const idle = await session(dumps, { idleMs: TTL + MIN });
      const orphan = path.join(uploadsDir('repos'), `${randomUUID()}.zip.partial`);
      await writeFile(orphan, 'orphan bytes');
      await age(orphan, TTL + MIN);

      const result = await reapAbandonedUploads(db());

      expect(result).toMatchObject({ sessions: 1, dumps: 0, orphans: 1 });
      expect(rowOf(dumps, idle.id).status).toBe('cancelled');
      expect(await exists(idle.file)).toBe(false);
      expect(await exists(orphan)).toBe(false);
      expect(rowOf(dumps, upload.id).status).toBe('reaping');
      expect(await exists(upload.file)).toBe(true);
    });
  });
});

describe('the finished-archive pass', () => {
  const EXTS = ['zip', 'tar', 'tar.gz'];

  async function archive(opts: {
    ext?: string;
    ageMs?: number;
    repo?: 'error' | 'cloning' | 'ready' | null;
    volume?: 'repos' | 'bundles';
    name?: (id: string) => string;
  }) {
    const id = randomUUID();
    const file = path.join(
      uploadsDir(opts.volume ?? 'repos'),
      (opts.name ?? ((i) => `${i}.${opts.ext ?? 'zip'}`))(id),
    );
    await writeFile(file, 'finished bytes');
    await age(file, opts.ageMs ?? TTL + HOUR);
    const status = opts.repo === undefined ? null : opts.repo;
    if (status !== null) {
      fake.insert(schema.repositories, {
        id,
        userId: USER,
        name: 'r',
        source: 'upload',
        storagePath: '/x',
        status,
      });
    }
    return { id, file };
  }

  it.each(EXTS)('removes a .%s older than 24 h whose repository row is gone', async (ext) => {
    const a = await archive({ ext, repo: null });
    const result = await reapAbandonedUploads(db());
    expect(await exists(a.file)).toBe(false);
    expect(result.orphans).toBe(1);
  });

  it.each(EXTS)('removes a .%s whose repository is in error', async (ext) => {
    const a = await archive({ ext, repo: 'error' });
    await reapAbandonedUploads(db());
    expect(await exists(a.file)).toBe(false);
  });

  it('keeps the finished archive of a complete session 5 days idle while its repository is cloning', async () => {
    const archive = await session(KINDS[0]!, {
      idleMs: 5 * TTL,
      status: 'complete',
      name: KINDS[0]!.finished,
    });
    repository(archive.id, 'cloning');

    await reapAbandonedUploads(db());

    expect(await exists(archive.file)).toBe(true);
  });

  it.each([
    ['cloning', false],
    ['ready', true],
    ['error', true],
  ] as const)('T323: with repository %s its old archive is removed: %s', async (repo, removed) => {
    const a = await archive({ repo });
    await reapAbandonedUploads(db());
    expect(await exists(a.file)).toBe(!removed);
  });

  it('keeps a legacy archive named by its session id while its owner has a cloning repository', async () => {
    const a = await archive({ repo: null });
    repository(randomUUID(), 'cloning');
    await reapAbandonedUploads(db());
    expect(await exists(a.file)).toBe(true);
  });

  it('removes a legacy archive whose owner has no cloning repository', async () => {
    const a = await archive({ repo: null });
    repository(randomUUID(), 'ready');
    await reapAbandonedUploads(db());
    expect(await exists(a.file)).toBe(false);
  });

  it('removes the archive of an errored repository although its owner has a cloning one', async () => {
    const a = await archive({ repo: 'error' });
    repository(randomUUID(), 'cloning');
    await reapAbandonedUploads(db());
    expect(await exists(a.file)).toBe(false);
  });

  it('keeps an archive younger than 24 h even with no repository row', async () => {
    const a = await archive({ repo: null, ageMs: 23 * HOUR });
    await reapAbandonedUploads(db());
    expect(await exists(a.file)).toBe(true);
  });

  it('keeps an archive whose id a session row touched within 24 h', async () => {
    const a = await archive({ repo: null });
    fake.insert(schema.repoUploads, {
      id: a.id,
      userId: USER,
      totalSize: 1,
      bytesReceived: 1,
      chunkSize: 1,
      status: 'complete',
      updatedAt: new Date(Date.now() - HOUR),
      archivePath: a.file,
      ...KINDS[0]!.columns,
    });
    await reapAbandonedUploads(db());
    expect(await exists(a.file)).toBe(true);
  });

  it.each([
    ['a name that is no id', () => 'x.zip'],
    ['a notification sound', () => 'notification-sound.mp3'],
  ])('does not touch %s', async (_label, name) => {
    const a = await archive({ name, repo: null });
    await reapAbandonedUploads(db());
    expect(await exists(a.file)).toBe(true);
  });

  it('does not take a directory of the archive shape', async () => {
    const a = await archive({ repo: null });
    await rm(a.file);
    await mkdir(a.file);
    await age(a.file, TTL + HOUR);
    await reapAbandonedUploads(db());
    expect(await exists(a.file)).toBe(true);
  });

  it('keeps the same name in the bundle root', async () => {
    const a = await archive({ repo: null, volume: 'bundles' });
    await reapAbandonedUploads(db());
    expect(await exists(a.file)).toBe(true);
  });

  it('removes a link named like an archive as a link and leaves its target', async () => {
    const target = path.join(storage, 'target.bin');
    await writeFile(target, 'target bytes');
    const id = randomUUID();
    const link = path.join(uploadsDir('repos'), `${id}.zip`);
    await symlink(target, link);
    const when = new Date(Date.now() - TTL - HOUR);
    await lutimes(link, when, when);
    await reapAbandonedUploads(db());
    expect(await exists(link)).toBe(false);
    expect(await readFile(target, 'utf8')).toBe('target bytes');
  });

  it('goes on after one removal fails', async () => {
    const bad = await archive({ repo: null });
    const good = await archive({ repo: 'error' });
    guard.removal = (rel) => rel.endsWith(path.basename(bad.file));
    const result = await reapAbandonedUploads(db());
    expect(await exists(bad.file)).toBe(true);
    expect(await exists(good.file)).toBe(false);
    expect(result.orphans).toBe(1);
  });
});

describe('T323: repeated orphan removal failures', () => {
  async function orphan(volume: 'repos' | 'bundles' = 'repos', id = randomUUID()) {
    const file = path.join(uploadsDir(volume), `${id}.zip.partial`);
    await writeFile(file, 'orphan');
    await age(file, TTL + HOUR);
    return file;
  }

  it('logs every removed orphan with its relative path and pass at debug level', async () => {
    const files: [string, string][] = [
      [await orphan(), 'repository'],
      [await orphan('bundles'), 'bundle'],
    ];
    for (const [name, pass] of [
      [`${randomUUID()}.zip`, 'finished archive'],
      [`db-${randomUUID()}.sql`, 'finished dump'],
    ] as const) {
      const file = path.join(uploadsDir('repos'), name);
      await writeFile(file, 'orphan');
      await age(file, TTL + HOUR);
      files.push([file, pass]);
    }

    const result = await reapAbandonedUploads(db());

    expect(result.orphans).toBe(4);
    expect(guard.warnings).toHaveLength(0);
    expect(guard.debugs).toHaveLength(4);
    for (const [file, pass] of files) {
      const root = pass === 'bundle' ? roots.bundles : roots.repos;
      expect(guard.debugs).toContainEqual([
        { rel: path.relative(root, file), pass },
        'orphan upload file removed',
      ]);
    }
  });

  it('warns once across several passes, and again when the error code changes', async () => {
    const file = await orphan();
    guard.removal = () => true;

    for (let i = 0; i < 3; i += 1) await reapAbandonedUploads(db());

    expect(await exists(file)).toBe(true);
    expect(guard.removals).toBe(3);
    expect(guard.warnings).toHaveLength(1);
    expect(guard.debugs).toHaveLength(2);

    guard.removalCode = 'EPERM';
    await reapAbandonedUploads(db());
    await reapAbandonedUploads(db());

    expect(guard.warnings).toHaveLength(2);
    expect(guard.debugs).toHaveLength(3);
  });

  it('warns once for an error without a code', async () => {
    await orphan();
    guard.removal = () => true;
    guard.removalCode = undefined;

    await reapAbandonedUploads(db());
    await reapAbandonedUploads(db());

    expect(guard.warnings).toHaveLength(1);
    expect(guard.debugs).toHaveLength(1);
  });

  it.each(['EACCES', 'containment'])(
    'remembers a failure while stat refuses it: %s',
    async (reason) => {
      const file = await orphan();
      guard.removal = () => true;
      await reapAbandonedUploads(db());

      guard.statFailure = reason;
      await reapAbandonedUploads(db());
      guard.statFailure = null;
      await reapAbandonedUploads(db());

      expect(await exists(file)).toBe(true);
      expect(guard.warnings).toHaveLength(1);
      expect(guard.debugs).toHaveLength(1);
    },
  );

  it('forgets a failure after removal succeeds', async () => {
    const id = randomUUID();
    const file = await orphan('repos', id);
    guard.removal = () => true;
    await reapAbandonedUploads(db());

    guard.removal = null;
    await reapAbandonedUploads(db());
    expect(await exists(file)).toBe(false);

    await orphan('repos', id);
    guard.removal = () => true;
    await reapAbandonedUploads(db());

    expect(guard.warnings).toHaveLength(2);
  });

  it('forgets a failed file removed by someone else between passes', async () => {
    const id = randomUUID();
    const file = await orphan('repos', id);
    guard.removal = () => true;
    await reapAbandonedUploads(db());

    await rm(file);
    await reapAbandonedUploads(db());
    await orphan('repos', id);
    await reapAbandonedUploads(db());

    expect(guard.warnings).toHaveLength(2);
    expect(guard.debugs).toHaveLength(0);
  });

  it('keeps remembered failures at capacity across repeated passes', async () => {
    for (let i = 0; i < 1001; i += 1) await orphan();
    guard.removal = () => true;
    await reapAbandonedUploads(db());
    expect(guard.warnings).toHaveLength(1001);

    await reapAbandonedUploads(db());
    expect(guard.warnings).toHaveLength(1002);
    expect(guard.debugs).toHaveLength(1000);

    await reapAbandonedUploads(db());
    expect(guard.warnings).toHaveLength(1003);
    expect(guard.debugs).toHaveLength(2000);

    guard.removalCode = 'EPERM';
    await reapAbandonedUploads(db());
    expect(guard.warnings).toHaveLength(2004);
    await reapAbandonedUploads(db());
    expect(guard.warnings).toHaveLength(2005);
    expect(guard.debugs).toHaveLength(3000);
  });

  it('warns separately for the same relative path in different storage roots', async () => {
    const id = randomUUID();
    await orphan('repos', id);
    await orphan('bundles', id);
    guard.removal = () => true;

    await reapAbandonedUploads(db());
    await reapAbandonedUploads(db());

    expect(guard.warnings).toHaveLength(2);
    expect(guard.debugs).toHaveLength(2);
  });
});

describe('T323: one cutoff throughout an upload reaper pass', () => {
  describe.each(KINDS)('$name', (kind) => {
    it.each(['uploading', 'completing'])(
      'protects a %s session stamped exactly at the cutoff',
      async (status) => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(Date.now());
        const boundary = await session(kind, { idleMs: TTL, fileAgeMs: TTL + HOUR, status });

        const protectedPass = await reapAbandonedUploads(db());

        expect(rowOf(kind, boundary.id).status).toBe(status);
        expect(await exists(boundary.file)).toBe(true);
        expect(protectedPass).toEqual({ sessions: 0, dumps: 0, orphans: 0 });

        vi.setSystemTime(Date.now() + 1);
        expect((await reapAbandonedUploads(db())).sessions).toBe(1);
        expect(rowOf(kind, boundary.id).status).toBe('cancelled');
        expect(await exists(boundary.file)).toBe(false);
      },
    );
  });

  it.each([
    ['repos', (id: string) => `${id}.zip.partial`],
    ['repos', (id: string) => `db-${id}.sql.partial`],
    ['repos', (id: string) => `${id}.zip`],
    ['repos', (id: string) => `db-${id}.sql`],
    ['bundles', (id: string) => `${id}.zip.partial`],
  ] as const)(
    'keeps a session crossing the cutoff during the %s pass (%#)',
    async (volume, name) => {
      const now = Date.now();
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(now);
      const keeper = await session(KINDS[2]!, {
        idleMs: TTL - MIN,
        fileAgeMs: HOUR,
        status: 'complete',
      });
      const file = path.join(uploadsDir(volume), name(keeper.id));
      await writeFile(file, 'orphan');
      await age(file, 5 * TTL);
      fake.hooks.beforeUpdate = (table) => {
        if (table === schema.customBundleUploads) vi.setSystemTime(now + 2 * MIN);
      };

      expect((await reapAbandonedUploads(db())).orphans).toBe(0);
      expect(await exists(file)).toBe(true);
      expect(rowOf(KINDS[2]!, keeper.id).updatedAt).toEqual(new Date(now - TTL + MIN));

      expect((await reapAbandonedUploads(db())).orphans).toBe(1);
      expect(await exists(file)).toBe(false);
    },
  );
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
    await vi.waitFor(() => expect(rowOf(KINDS[0]!, stale.id).status).toBe('cancelled'), {
      timeout: 10_000,
    });
    // The pass wrote the stale row twice: the claim into reaping, then the finish.
    expect(claims).toBe(2);

    // A tick that lands while the first pass still runs is dropped by the single-flight flag.
    await vi.waitFor(
      async () => {
        await vi.advanceTimersByTimeAsync(15 * MIN);
        expect(claims).toBe(3);
      },
      { timeout: 10_000 },
    );

    stop();
    await vi.advanceTimersByTimeAsync(45 * MIN);
    expect(claims).toBe(3);
  });
});

// A claim parks a session in reaping until every file it owns is gone, and every pass finishes those
// rows, whatever their age.
describe('R1: a reaped session stays reaping until its files are gone', () => {
  const repos = KINDS[0]!;
  const dumps = KINDS[1]!;
  const bundles = KINDS[2]!;
  const finalOf = (file: string) => file.replace(/\.partial$/, '');

  // A session whose partial and finished file are both on disk.
  async function withBoth(kind: Kind, opts: { idleMs: number; status?: string }) {
    const stale = await session(kind, opts);
    const finished = finalOf(stale.file);
    await writeFile(finished, 'finished bytes');
    return { id: stale.id, partial: stale.file, finished };
  }

  describe.each([repos, dumps])('$name', (kind) => {
    it('a stale session whose finished file cannot be removed stays reaping, and the next pass removes both files and cancels it', async () => {
      const stale = await withBoth(kind, { idleMs: TTL + MIN });
      guard.removal = (rel) => !rel.endsWith('.partial');

      const failed = await reapAbandonedUploads(db());

      expect(rowOf(kind, stale.id).status).toBe('reaping');
      expect(await exists(stale.finished)).toBe(true);
      expect(await exists(stale.partial)).toBe(false);
      expect(failed.sessions).toBe(0);

      guard.removal = null;
      const finished = await reapAbandonedUploads(db());

      expect(rowOf(kind, stale.id).status).toBe('cancelled');
      expect(await exists(stale.finished)).toBe(false);
      expect(await exists(stale.partial)).toBe(false);
      expect(finished.sessions).toBe(1);
    });

    it('a stale session whose partial cannot be removed stays reaping, and its finished file still goes', async () => {
      const stale = await withBoth(kind, { idleMs: TTL + MIN });
      guard.removal = (rel) => rel.endsWith('.partial');

      await reapAbandonedUploads(db());

      expect(rowOf(kind, stale.id).status).toBe('reaping');
      expect(await exists(stale.partial)).toBe(true);
      expect(await exists(stale.finished)).toBe(false);

      guard.removal = null;
      await reapAbandonedUploads(db());

      expect(rowOf(kind, stale.id).status).toBe('cancelled');
      expect(await exists(stale.partial)).toBe(false);
    });

    it.each([
      ['just now', 0],
      ['five days ago', 5 * TTL],
    ])(
      'finishes a row a dead worker left reaping with both its files, updated %s',
      async (_when, idleMs) => {
        const dead = await withBoth(kind, { idleMs, status: 'reaping' });

        const result = await reapAbandonedUploads(db());

        expect(rowOf(kind, dead.id).status).toBe('cancelled');
        expect(await exists(dead.partial)).toBe(false);
        expect(await exists(dead.finished)).toBe(false);
        expect(result.sessions).toBe(1);
      },
    );

    it('finishes a reaping row that names no session file of its owner, and leaves that file', async () => {
      const outside = path.join(storage, 'precious.bin');
      await writeFile(outside, 'keep me');
      const id = randomUUID();
      fake.insert(kind.table, {
        id,
        userId: USER,
        totalSize: 1,
        bytesReceived: 1,
        chunkSize: 1,
        status: 'reaping',
        updatedAt: new Date(),
        [kind.pathKey]: outside,
        ...kind.columns,
      });

      await reapAbandonedUploads(db());

      expect(rowOf(kind, id).status).toBe('cancelled');
      expect(await readFile(outside, 'utf8')).toBe('keep me');
    });
  });

  describe('a bundle session', () => {
    it('keeps its bundle’s final path while its partial cannot be removed, and after the next pass cancels it', async () => {
      const stale = await withBoth(bundles, { idleMs: TTL + MIN });
      guard.removal = (rel) => rel.endsWith('.partial');

      await reapAbandonedUploads(db());

      expect(rowOf(bundles, stale.id).status).toBe('reaping');
      expect(await exists(stale.finished)).toBe(true);

      guard.removal = null;
      await reapAbandonedUploads(db());

      expect(rowOf(bundles, stale.id).status).toBe('cancelled');
      expect(await exists(stale.partial)).toBe(false);
      expect(await exists(stale.finished)).toBe(true);
    });

    it('keeps its bundle’s final path when a dead worker left the row reaping', async () => {
      const dead = await withBoth(bundles, { idleMs: MIN, status: 'reaping' });

      await reapAbandonedUploads(db());

      expect(rowOf(bundles, dead.id).status).toBe('cancelled');
      expect(await exists(dead.partial)).toBe(false);
      expect(await exists(dead.finished)).toBe(true);
    });
  });

  it('removes an ended dump whose own extension is partial, since the name is not a session partial', async () => {
    const dump = await session(dumps, {
      idleMs: 5 * TTL,
      status: 'complete',
      name: (id) => `db-${id}.partial`,
    });
    fake.insert(schema.tasks, {
      id: randomUUID(),
      userId: USER,
      dbUploadId: dump.id,
      status: 'cancelled',
      updatedAt: new Date(Date.now() - 5 * TTL),
    });

    const result = await reapAbandonedUploads(db());

    expect(rowOf(dumps, dump.id).status).toBe('cancelled');
    expect(await exists(dump.file)).toBe(false);
    expect(result.dumps).toBe(1);
  });

  it('leaves the completed dump a task links alone while a stale dump session stays reaping beside it', async () => {
    const linked = await session(dumps, {
      idleMs: 5 * TTL,
      status: 'complete',
      name: dumps.finished,
    });
    fake.insert(schema.tasks, {
      id: randomUUID(),
      userId: USER,
      dbUploadId: linked.id,
      status: 'running',
      updatedAt: new Date(Date.now() - 5 * TTL),
    });
    const stale = await session(dumps, { idleMs: TTL + MIN });
    guard.removal = (rel) => rel.endsWith('.partial');

    await reapAbandonedUploads(db());

    expect(rowOf(dumps, stale.id).status).toBe('reaping');
    expect(rowOf(dumps, linked.id).status).toBe('complete');
    expect(await exists(linked.file)).toBe(true);

    guard.removal = null;
    await reapAbandonedUploads(db());

    expect(rowOf(dumps, stale.id).status).toBe('cancelled');
    expect(rowOf(dumps, linked.id).status).toBe('complete');
    expect(await exists(linked.file)).toBe(true);
  });
});

describe('I3b: the row pass deletes a cancelled session a day after it was cancelled', () => {
  const dumps = KINDS[1]!;

  describe.each(KINDS)('$name', (kind) => {
    const cancelled = (idleMs: number) =>
      session(kind, { idleMs, status: 'cancelled', name: kind.finished });

    it('deletes a cancelled row last updated 25 h ago', async () => {
      const old = await cancelled(TTL + HOUR);

      await reapAbandonedUploads(db());

      expect(fake.rows(kind.table).some((r) => r.id === old.id)).toBe(false);
    });

    it('keeps a cancelled row last updated 23 h ago', async () => {
      const recent = await cancelled(TTL - HOUR);

      await reapAbandonedUploads(db());

      expect(rowOf(kind, recent.id).status).toBe('cancelled');
    });

    it.each(['complete', 'uploading', 'completing', 'reaping', 'consumed'])(
      'keeps a %s row 25 h old',
      async (status) => {
        const other = await session(kind, {
          idleMs: TTL + HOUR,
          status,
          name: kind.finished,
        });
        if (kind.table === schema.repoUploads) repository(other.id, 'cloning');
        if (kind.table === schema.dbUploads && status === 'complete') {
          fake.insert(schema.tasks, {
            id: randomUUID(),
            userId: USER,
            dbUploadId: other.id,
            status: 'running',
            updatedAt: new Date(),
          });
        }

        await reapAbandonedUploads(db());

        expect(fake.rows(kind.table).some((r) => r.id === other.id)).toBe(true);
      },
    );

    it('keeps the row this very pass cancels', async () => {
      const stale = await session(kind, { idleMs: TTL + MIN });

      await reapAbandonedUploads(db());

      expect(rowOf(kind, stale.id).status).toBe('cancelled');
    });
  });

  describe.each(['completed', 'failed', 'running'])('a dump a %s task names', (taskStatus) => {
    it('stays, with the task link, while an unlinked cancelled dump is deleted', async () => {
      const linked = await session(dumps, {
        idleMs: TTL + HOUR,
        status: 'cancelled',
        name: dumps.finished,
      });
      const free = await session(dumps, {
        idleMs: TTL + HOUR,
        status: 'cancelled',
        name: dumps.finished,
      });
      const taskId = randomUUID();
      fake.insert(schema.tasks, {
        id: taskId,
        userId: USER,
        dbUploadId: linked.id,
        status: taskStatus,
        updatedAt: new Date(Date.now() - 5 * TTL),
      });

      await reapAbandonedUploads(db());

      expect(rowOf(dumps, linked.id).status).toBe('cancelled');
      expect(fake.rows(dumps.table).some((r) => r.id === free.id)).toBe(false);
    });
  });
});

describe('I3b: the file pass removes an owner directory left empty for a day', () => {
  describe.each(['repos', 'bundles'] as const)('in the %s root', (volume) => {
    const dir = () => uploadsDir(volume);

    it('removes an empty directory whose mtime is 25 h old', async () => {
      await age(dir(), TTL + HOUR);

      await reapAbandonedUploads(db());

      expect(await exists(dir())).toBe(false);
      expect(await exists(path.dirname(dir()))).toBe(true);
    });

    it('keeps an empty directory 23 h old', async () => {
      await age(dir(), TTL - HOUR);

      await reapAbandonedUploads(db());

      expect(await exists(dir())).toBe(true);
    });

    it('keeps an old directory that holds a fresh file', async () => {
      const file = path.join(dir(), 'something.txt');
      await writeFile(file, 'x');
      await age(dir(), TTL + HOUR);

      await reapAbandonedUploads(db());

      expect(await exists(file)).toBe(true);
    });

    it('keeps an old directory that holds notification-sound.mp3', async () => {
      const file = path.join(dir(), 'notification-sound.mp3');
      await writeFile(file, 'x');
      await age(file, 5 * TTL);
      await age(dir(), 5 * TTL);

      await reapAbandonedUploads(db());

      expect(await exists(file)).toBe(true);
    });

    it('leaves a link named like an owner directory and its target alone', async () => {
      const target = path.join(storage, `target-${volume}`);
      await mkdir(target);
      await age(target, TTL + HOUR);
      const link = path.join(roots[volume], '_uploads', OTHER_USER);
      await symlink(target, link);

      await reapAbandonedUploads(db());

      expect(await exists(target)).toBe(true);
      expect((await lstat(link)).isSymbolicLink()).toBe(true);
    });

    it('keeps a directory this very pass emptied', async () => {
      const kind = volume === 'repos' ? KINDS[0]! : KINDS[2]!;
      const stale = await session(kind, { idleMs: TTL + HOUR });
      await age(dir(), TTL + HOUR);

      await reapAbandonedUploads(db());

      expect(await exists(stale.file)).toBe(false);
      expect(await exists(dir())).toBe(true);
    });
  });
});

describe('a removal that fails for 24 h parks its row as reap_failed', () => {
  describe.each(KINDS)('$name', (kind) => {
    it('parks a row claimed 25 h ago whose file cannot be removed, logs one error, and leaves it alone on the next pass', async () => {
      const stuck = await session(kind, { idleMs: TTL + HOUR, status: 'reaping' });
      guard.removal = () => true;

      await reapAbandonedUploads(db());

      expect(rowOf(kind, stuck.id).status).toBe('reap_failed');
      expect(await exists(stuck.file)).toBe(true);
      expect(guard.errors).toHaveLength(1);
      const removals = guard.removals;

      await reapAbandonedUploads(db());

      expect(guard.removals).toBe(removals);
      expect(guard.errors).toHaveLength(1);
      expect(rowOf(kind, stuck.id).status).toBe('reap_failed');
    });

    it('keeps a failing row claimed 23 h ago reaping without an error log', async () => {
      const stuck = await session(kind, { idleMs: TTL - HOUR, status: 'reaping' });
      guard.removal = () => true;

      await reapAbandonedUploads(db());

      expect(rowOf(kind, stuck.id).status).toBe('reaping');
      expect(guard.errors).toHaveLength(0);
    });

    it('cancels, never parks, a row claimed 25 h ago whose removal succeeds', async () => {
      const old = await session(kind, { idleMs: TTL + HOUR, status: 'reaping' });

      await reapAbandonedUploads(db());

      expect(rowOf(kind, old.id).status).toBe('cancelled');
      expect(await exists(old.file)).toBe(false);
      expect(guard.errors).toHaveLength(0);
    });

    it('leaves the old partial of a parked session to the orphan pass', async () => {
      const parked = await session(kind, { idleMs: 3 * TTL, status: 'reap_failed' });

      await reapAbandonedUploads(db());

      expect(await exists(parked.file)).toBe(true);
      expect(rowOf(kind, parked.id).status).toBe('reap_failed');
    });

    it('does not delete a parked row with the cancelled-row cleanup', async () => {
      const parked = await session(kind, {
        idleMs: 3 * TTL,
        status: 'reap_failed',
        name: kind.finished,
      });

      await reapAbandonedUploads(db());

      expect(rowOf(kind, parked.id).status).toBe('reap_failed');
      expect(await exists(parked.file)).toBe(true);
    });
  });
});

describe('T323: the orphan finished-dump pass', () => {
  const dumps = KINDS[1]!;

  it.each(['sql', 'sql.gz', 'dump', 'backup', 'zip', 'partial'])(
    'removes an old rowless .%s dump',
    async (ext) => {
      const file = path.join(uploadsDir('repos'), `db-${randomUUID()}.${ext}`);
      await writeFile(file, 'dump');
      await age(file, TTL + HOUR);

      const result = await reapAbandonedUploads(db());

      expect(await exists(file)).toBe(false);
      expect(result.orphans).toBe(1);
    },
  );

  it.each([
    'uploading',
    'completing',
    'complete',
    'cancelled',
    'consumed',
    'reaping',
    'reap_failed',
  ])('keeps an old file whose %s row is still owned by the row passes', async (status) => {
    const upload = await session(dumps, {
      idleMs: 5 * TTL,
      fileAgeMs: 5 * TTL,
      status,
      name: dumps.finished,
    });
    // Hold the row passes back without renewing the row's timestamp. The keep-set must own
    // every status, even without recentSessions' separate protection for reap_failed.
    fake.hooks.beforeUpdate = fake.hooks.beforeDelete = (table) => {
      if (table === schema.dbUploads) throw new Error('the row pass is unavailable');
    };
    guard.ignoreParkedProtection = true;
    if (status === 'reaping') guard.removal = () => true;

    await reapAbandonedUploads(db());

    expect(await exists(upload.file)).toBe(true);
    expect(rowOf(dumps, upload.id).status).toBe(status);
    expect(guard.removals).toBe(status === 'reaping' ? 1 : 0);
    expect(
      guard.warnings.filter(
        ([, message]) => message === 'upload reaper skipped the finished dump pass',
      ),
    ).toHaveLength(0);
  });

  it('keeps an old complete dump with an old row while a running task needs it', async () => {
    const upload = await session(dumps, {
      idleMs: 5 * TTL,
      status: 'complete',
      name: dumps.finished,
    });
    fake.insert(schema.tasks, {
      id: randomUUID(),
      userId: USER,
      dbUploadId: upload.id,
      status: 'running',
      updatedAt: new Date(Date.now() - 5 * TTL),
    });

    await reapAbandonedUploads(db());

    expect(await exists(upload.file)).toBe(true);
    expect(rowOf(dumps, upload.id).status).toBe('complete');
  });

  it('keeps a young finished dump without a row', async () => {
    const file = path.join(uploadsDir('repos'), `db-${randomUUID()}.sql`);
    await writeFile(file, 'dump');
    await age(file, TTL - HOUR);

    await reapAbandonedUploads(db());

    expect(await exists(file)).toBe(true);
  });

  it('keeps an old rowless dump while another session with that id was touched recently', async () => {
    const upload = await session(KINDS[0]!, { idleMs: HOUR });
    const file = path.join(uploadsDir('repos'), `db-${upload.id}.sql`);
    await writeFile(file, 'dump');
    await age(file, 5 * TTL);

    await reapAbandonedUploads(db());

    expect(await exists(file)).toBe(true);
  });

  it('removes an old finished dump symlink without touching its target', async () => {
    const target = path.join(storage, 'dump-target.sql');
    await writeFile(target, 'keep');
    const file = path.join(uploadsDir('repos'), `db-${randomUUID()}.sql`);
    await symlink(target, file);
    const old = new Date(Date.now() - 5 * TTL);
    await lutimes(file, old, old);

    await reapAbandonedUploads(db());

    expect(await exists(file)).toBe(false);
    expect(await readFile(target, 'utf8')).toBe('keep');
  });
});
