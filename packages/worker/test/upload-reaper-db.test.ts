import { randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabase, schema, type Database } from '@haive/database';

const faults = vi.hoisted(() => ({
  removal: null as null | ((rel: string) => boolean | Promise<boolean>),
}));
vi.mock('@haive/shared/fs-safe', async (importOriginal) => {
  const real = await importOriginal<typeof import('@haive/shared/fs-safe')>();
  return {
    ...real,
    removeNoFollow: async (...args: Parameters<typeof real.removeNoFollow>) => {
      if (await faults.removal?.(args[1])) throw new Error('EACCES: the removal failed');
      return real.removeNoFollow(...args);
    },
  };
});

import { reapAbandonedUploads } from '../src/repo/upload-reaper.js';

const url = process.env.UPLOAD_REAPER_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/upload_reaper_test')) {
  throw new Error('Use a dedicated upload_reaper_test database for the upload reaper test');
}

const HOUR = 60 * 60 * 1000;
const LIVE = ['created', 'queued', 'running', 'paused', 'waiting_user', 'waiting_pr'] as const;
const ENDED = ['completed', 'failed', 'cancelled'] as const;

describe.skipIf(!url)('the upload reaper against Postgres', () => {
  let db: Database;
  let racer: Database;
  let root: string;
  let userId: string;
  let repoId: string;
  const saved: Record<string, string | undefined> = {};

  beforeAll(async () => {
    db = createDatabase(url!);
    racer = createDatabase(url!);
    root = await mkdtemp(path.join(tmpdir(), 'upload-reaper-db-'));
    for (const [env, dir] of [
      ['REPO_STORAGE_ROOT', 'repos'],
      ['BUNDLE_STORAGE_ROOT', 'bundles'],
    ] as const) {
      saved[env] = process.env[env];
      process.env[env] = path.join(root, dir);
    }
  });
  beforeEach(async () => {
    userId = randomUUID();
    repoId = randomUUID();
    await db.insert(schema.users).values({
      id: userId,
      emailEncrypted: 'test',
      emailBlindIndex: userId,
      passwordHash: 'test',
    });
    await db.insert(schema.repositories).values({
      id: repoId,
      userId,
      name: 'upload-reaper-test',
      source: 'blank',
      storagePath: path.join(root, userId, repoId),
    });
    for (const dir of ['repos', 'bundles']) {
      await mkdir(path.join(root, dir, '_uploads', userId), { recursive: true });
    }
  });
  afterEach(async () => {
    faults.removal = null;
    await db.delete(schema.users).where(eq(schema.users.id, userId));
  });
  afterAll(async () => {
    for (const [env, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[env];
      else process.env[env] = value;
    }
    await rm(root, { recursive: true, force: true });
    await db.$client.end({ timeout: 5 });
    await racer.$client.end({ timeout: 5 });
  });

  const exists = async (file: string) => (await lstat(file).catch(() => null)) !== null;

  async function dump(idleMs: number, status: 'complete' | 'reaping' = 'complete') {
    const id = randomUUID();
    const file = path.join(root, 'repos', '_uploads', userId, `db-${id}.sql`);
    await writeFile(file, 'dump bytes');
    await db.insert(schema.dbUploads).values({
      id,
      userId,
      filename: 'a.sql',
      dumpFormat: 'sql',
      totalSize: 10,
      bytesReceived: 10,
      chunkSize: 10,
      dumpPath: file,
      status,
      updatedAt: new Date(Date.now() - idleMs),
    });
    return { id, file };
  }

  const link = (
    dumpId: string | null,
    status: (typeof LIVE)[number] | (typeof ENDED)[number],
    updatedAgoMs: number,
  ) =>
    db.insert(schema.tasks).values({
      userId,
      dbUploadId: dumpId,
      type: 'workflow',
      title: 'task',
      status,
      updatedAt: new Date(Date.now() - updatedAgoMs),
    });

  const statusOf = async (id: string) =>
    (await db.query.dbUploads.findFirst({ where: eq(schema.dbUploads.id, id) }))!.status;

  // Runs `inject` once the pass has read the tasks and before it claims: a task linked in that gap.
  function afterTasksRead(real: Database, inject: () => Promise<unknown>): Database {
    let first = true;
    return new Proxy(real, {
      get(target, prop) {
        const value = Reflect.get(target, prop, target);
        if (prop !== 'select') return typeof value === 'function' ? value.bind(target) : value;
        return (fields: never) => ({
          from: (table: never) => {
            const read = target.select(fields).from(table);
            if (table !== schema.tasks || !first) return read;
            first = false;
            return {
              where: async (cond: never) => {
                const rows = await read.where(cond);
                await inject();
                return rows;
              },
            };
          },
        });
      },
    });
  }

  type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
  const BLOCKED_WITHIN_MS = 10_000;

  const settle = <T>(run: Promise<T>) =>
    run.then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );

  const backendPid = async (tx: Tx) => {
    const [row] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
    return row!.pid;
  };

  // Returns once a statement waits on a lock the backend `holderPid` holds, and throws when `ended`
  // turns true first, as a statement that did not wait would.
  async function untilBlockedBy(holderPid: number, ended: () => boolean) {
    const deadline = Date.now() + BLOCKED_WITHIN_MS;
    for (;;) {
      if (ended()) throw new Error('the statement ended without waiting for the lock');
      const [row] = await db.execute<{ blocked: number }>(sql`
        select count(*)::int as blocked from pg_stat_activity
        where wait_event_type = 'Lock' and ${holderPid}::int = any (pg_blocking_pids(pid))`);
      if (row!.blocked > 0) return;
      if (Date.now() > deadline) {
        throw new Error(`nothing waited on pid ${holderPid} within ${BLOCKED_WITHIN_MS} ms`);
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  describe('the claim of a completed dump', () => {
    // Its only task ended long ago, so the pass's read lets it through to the claim.
    async function endedLongAgo() {
      const upload = await dump(5 * 24 * HOUR);
      await link(upload.id, 'cancelled', 5 * 24 * HOUR);
      return upload;
    }

    it('keeps a dump a live task was linked to after the pass read the tasks', async () => {
      const upload = await endedLongAgo();

      await reapAbandonedUploads(afterTasksRead(db, () => link(upload.id, 'running', 0)));

      expect(await statusOf(upload.id)).toBe('complete');
      expect(await exists(upload.file)).toBe(true);
    });

    it.each(LIVE)('keeps the dump of a %s task linked after the read', async (status) => {
      const upload = await endedLongAgo();

      await reapAbandonedUploads(afterTasksRead(db, () => link(upload.id, status, 5 * 24 * HOUR)));

      expect(await statusOf(upload.id)).toBe('complete');
    });

    it.each(ENDED)(
      'keeps the dump of a %s task linked after the read that ended 23 h ago',
      async (status) => {
        const upload = await endedLongAgo();

        await reapAbandonedUploads(afterTasksRead(db, () => link(upload.id, status, 23 * HOUR)));

        expect(await statusOf(upload.id)).toBe('complete');
      },
    );

    it.each(ENDED)(
      'takes the dump of a %s task linked after the read that ended 25 h ago',
      async (status) => {
        const upload = await endedLongAgo();

        await reapAbandonedUploads(afterTasksRead(db, () => link(upload.id, status, 25 * HOUR)));

        expect(await statusOf(upload.id)).toBe('cancelled');
        expect(await exists(upload.file)).toBe(false);
      },
    );

    it('is not held by a live task linked to another dump', async () => {
      const upload = await endedLongAgo();
      const other = await endedLongAgo();

      await reapAbandonedUploads(afterTasksRead(db, () => link(other.id, 'running', 0)));

      expect(await statusOf(upload.id)).toBe('cancelled');
      expect(await statusOf(other.id)).toBe('complete');
    });

    it('takes a dump no task names once it is 25 h idle, and keeps one that is 23 h idle', async () => {
      const old = await dump(25 * HOUR);
      const fresh = await dump(23 * HOUR);

      await reapAbandonedUploads(db);

      expect(await statusOf(old.id)).toBe('cancelled');
      expect(await exists(old.file)).toBe(false);
      expect(await statusOf(fresh.id)).toBe('complete');
      expect(await exists(fresh.file)).toBe(true);
    });
  });

  describe('a claimed dump stays reaping until its file is gone', () => {
    async function endedLongAgo() {
      const upload = await dump(5 * 24 * HOUR);
      await link(upload.id, 'cancelled', 5 * 24 * HOUR);
      return upload;
    }
    const dumpFilesFail = () => {
      faults.removal = (rel) => rel.endsWith('.sql');
    };

    it('leaves the row reaping with its file when the removal fails, and the next pass finishes it', async () => {
      const upload = await endedLongAgo();
      dumpFilesFail();

      const failed = await reapAbandonedUploads(db);

      expect(await statusOf(upload.id)).toBe('reaping');
      expect(await exists(upload.file)).toBe(true);
      expect(failed.dumps).toBe(0);

      faults.removal = null;
      const finished = await reapAbandonedUploads(db);

      expect(await statusOf(upload.id)).toBe('cancelled');
      expect(await exists(upload.file)).toBe(false);
      expect(finished.dumps).toBe(1);
    });

    it('parks a dump claimed 25 h ago whose removal keeps failing, and the next pass leaves it', async () => {
      const upload = await dump(25 * HOUR, 'reaping');
      dumpFilesFail();

      await reapAbandonedUploads(db);

      expect(await statusOf(upload.id)).toBe('reap_failed');
      expect(await exists(upload.file)).toBe(true);

      await reapAbandonedUploads(db);

      expect(await statusOf(upload.id)).toBe('reap_failed');
    });

    it.each([
      ['just now, beside an ended task', 0, 'cancelled'],
      ['5 days ago, beside a live task', 5 * 24 * HOUR, 'running'],
      ['5 days ago, beside no task', 5 * 24 * HOUR, null],
    ] as const)(
      'finishes a row a dead worker left reaping, updated %s',
      async (_name, idleMs, taskStatus) => {
        const upload = await dump(idleMs, 'reaping');
        if (taskStatus !== null) await link(upload.id, taskStatus, 5 * 24 * HOUR);

        const result = await reapAbandonedUploads(db);

        expect(await statusOf(upload.id)).toBe('cancelled');
        expect(await exists(upload.file)).toBe(false);
        expect(result.dumps).toBe(1);
      },
    );

    it('finishes a reaping row whose file is already gone', async () => {
      const upload = await dump(0, 'reaping');
      await rm(upload.file);

      const result = await reapAbandonedUploads(db);

      expect(await statusOf(upload.id)).toBe('cancelled');
      expect(result.dumps).toBe(1);
    });

    it('counts a file that is already gone when it claims a dump as removed', async () => {
      const upload = await endedLongAgo();
      await rm(upload.file);

      const result = await reapAbandonedUploads(db);

      expect(await statusOf(upload.id)).toBe('cancelled');
      expect(result.dumps).toBe(1);
    });

    it('is left alone by the session and file passes, which still take what is theirs', async () => {
      const upload = await dump(HOUR, 'reaping');
      dumpFilesFail();
      const idleId = randomUUID();
      const idle = path.join(root, 'repos', '_uploads', userId, `db-${idleId}.sql.partial`);
      await writeFile(idle, 'partial bytes');
      await db.insert(schema.dbUploads).values({
        id: idleId,
        userId,
        filename: 'a.sql',
        dumpFormat: 'sql',
        totalSize: 10,
        bytesReceived: 3,
        chunkSize: 10,
        dumpPath: idle,
        status: 'uploading',
        updatedAt: new Date(Date.now() - 25 * HOUR),
      });
      const orphan = path.join(root, 'repos', '_uploads', userId, `${randomUUID()}.zip.partial`);
      await writeFile(orphan, 'orphan bytes');
      await utimes(orphan, new Date(Date.now() - 25 * HOUR), new Date(Date.now() - 25 * HOUR));

      const result = await reapAbandonedUploads(db);

      expect(result.dumps).toBe(0);
      expect(await statusOf(idleId)).toBe('cancelled');
      expect(await exists(idle)).toBe(false);
      expect(await exists(orphan)).toBe(false);
      expect(await statusOf(upload.id)).toBe('reaping');
      expect(await exists(upload.file)).toBe(true);
    });
  });

  describe('the claim of a completed dump beside a transaction that has not committed', () => {
    async function endedLongAgo() {
      const upload = await dump(5 * 24 * HOUR);
      await link(upload.id, 'cancelled', 5 * 24 * HOUR);
      return upload;
    }

    // The task route's transaction up to its commit: the dump read FOR SHARE, then a task naming it.
    function holdTaskTransaction(dumpId: string, end: 'commit' | 'rollback') {
      let proceed!: () => void;
      const proceeding = new Promise<void>((resolve) => (proceed = resolve));
      let inserted!: (pid: number) => void;
      const insertedPid = new Promise<number>((resolve) => (inserted = resolve));
      const done = settle(
        racer.transaction(async (tx) => {
          const pid = await backendPid(tx);
          await tx
            .select({ id: schema.dbUploads.id })
            .from(schema.dbUploads)
            .where(eq(schema.dbUploads.id, dumpId))
            .for('share');
          await tx.insert(schema.tasks).values({
            userId,
            dbUploadId: dumpId,
            type: 'workflow',
            title: 'task',
            status: 'created',
          });
          inserted(pid);
          await proceeding;
          if (end === 'rollback') throw new Error('the task transaction rolled back');
        }),
      );
      const pid = () =>
        Promise.race([
          insertedPid,
          done.then(() => {
            throw new Error('the task transaction ended before it held the dump');
          }),
        ]);
      return { pid, proceed, done };
    }

    // The pass's database, with its claim transaction held open and uncommitted once the claim ran.
    function holdingTheClaim(real: Database) {
      let proceed!: () => void;
      const proceeding = new Promise<void>((resolve) => (proceed = resolve));
      let claimed!: (pid: number) => void;
      const claimedPid = new Promise<number>((resolve) => (claimed = resolve));
      const held = new Proxy(real, {
        get(target, prop) {
          const value = Reflect.get(target, prop, target);
          if (prop !== 'transaction')
            return typeof value === 'function' ? value.bind(target) : value;
          return (fn: (tx: Tx) => Promise<unknown>) =>
            target.transaction(async (tx) => {
              const result = await fn(tx);
              claimed(await backendPid(tx));
              await proceeding;
              return result;
            });
        },
      });
      return { db: held, claimedPid, proceed };
    }

    function runPass(on: Database) {
      const state = { ended: false };
      const outcome = settle(reapAbandonedUploads(on));
      void outcome.then(() => (state.ended = true));
      return { state, outcome };
    }

    it('waits for a task transaction that inserted a task naming the dump, then keeps the dump', async () => {
      const upload = await endedLongAgo();
      const held = holdTaskTransaction(upload.id, 'commit');
      const taskPid = await held.pid();
      const pass = runPass(db);
      try {
        await untilBlockedBy(taskPid, () => pass.state.ended);
        expect(await statusOf(upload.id)).toBe('complete');
        expect(await exists(upload.file)).toBe(true);
      } finally {
        held.proceed();
        await held.done;
        await pass.outcome;
      }

      expect((await held.done).ok).toBe(true);
      expect(await pass.outcome).toMatchObject({ ok: true, value: { dumps: 0 } });
      expect(await statusOf(upload.id)).toBe('complete');
      expect(await exists(upload.file)).toBe(true);
    }, 30_000);

    it('takes the dump once that task transaction rolls back instead', async () => {
      const upload = await endedLongAgo();
      const held = holdTaskTransaction(upload.id, 'rollback');
      const taskPid = await held.pid();
      const pass = runPass(db);
      try {
        await untilBlockedBy(taskPid, () => pass.state.ended);
      } finally {
        held.proceed();
        await held.done;
        await pass.outcome;
      }

      expect((await held.done).ok).toBe(false);
      expect(await pass.outcome).toMatchObject({ ok: true, value: { dumps: 1 } });
      expect(await statusOf(upload.id)).toBe('cancelled');
      expect(await exists(upload.file)).toBe(false);
    }, 30_000);

    it('removes the file only after its claim commits, and a reader of the row waits for that claim', async () => {
      const upload = await endedLongAgo();
      const holding = holdingTheClaim(db);
      const pass = runPass(holding.db);
      let reader: Promise<unknown> = Promise.resolve();
      // Holds the removal, and so the finishing update after it, until the reader has its answer.
      faults.removal = async () => {
        await reader;
        return false;
      };
      try {
        const reaperPid = await Promise.race([
          holding.claimedPid,
          pass.outcome.then(() => {
            throw new Error('the pass ended without holding its claim open');
          }),
        ]);
        expect(await exists(upload.file)).toBe(true);
        expect(await statusOf(upload.id)).toBe('complete');

        let readerEnded = false;
        reader = settle(
          racer.transaction((tx) =>
            tx
              .select({ status: schema.dbUploads.status })
              .from(schema.dbUploads)
              .where(eq(schema.dbUploads.id, upload.id))
              .for('share'),
          ),
        );
        void reader.then(() => (readerEnded = true));
        await untilBlockedBy(reaperPid, () => readerEnded);
      } finally {
        holding.proceed();
        await pass.outcome;
        await reader;
      }

      expect(await reader).toEqual({ ok: true, value: [{ status: 'reaping' }] });
      expect(await statusOf(upload.id)).toBe('cancelled');
      expect(await exists(upload.file)).toBe(false);
    }, 30_000);
  });

  // A complete that failed after its move: the row names the partial, only the final file exists.
  describe('the session pass and the finished file a complete left behind', () => {
    const sessionRow = () => ({ userId, totalSize: 10, bytesReceived: 10, chunkSize: 10 });
    const kinds = [
      {
        name: 'repo_uploads',
        table: schema.repoUploads,
        volume: 'repos',
        partial: (id: string) => `${id}.zip.partial`,
        insert: (id: string, stored: string, status: string, updatedAt: Date) =>
          db.insert(schema.repoUploads).values({
            ...sessionRow(),
            id,
            filename: 'a.zip',
            archiveFormat: 'zip',
            archivePath: stored,
            status,
            updatedAt,
          }),
      },
      {
        name: 'db_uploads',
        table: schema.dbUploads,
        volume: 'repos',
        partial: (id: string) => `db-${id}.sql.partial`,
        insert: (id: string, stored: string, status: string, updatedAt: Date) =>
          db.insert(schema.dbUploads).values({
            ...sessionRow(),
            id,
            filename: 'a.sql',
            dumpFormat: 'sql',
            dumpPath: stored,
            status,
            updatedAt,
          }),
      },
      {
        name: 'custom_bundle_uploads',
        table: schema.customBundleUploads,
        volume: 'bundles',
        partial: (id: string) => `${id}.tar.gz.partial`,
        insert: (id: string, stored: string, status: string, updatedAt: Date) =>
          db.insert(schema.customBundleUploads).values({
            ...sessionRow(),
            id,
            repositoryId: repoId,
            name: 'kit',
            filename: 'a.tar.gz',
            archiveFormat: 'tar.gz',
            archivePath: stored,
            status,
            updatedAt,
          }),
      },
    ];
    type Kind = (typeof kinds)[number];
    const repos = kinds[0]!;
    const dumps = kinds[1]!;
    const bundles = kinds[2]!;

    async function movedFinal(kind: Kind, status: string) {
      const id = randomUUID();
      const partial = path.join(root, kind.volume, '_uploads', userId, kind.partial(id));
      const finished = partial.replace(/\.partial$/, '');
      await writeFile(finished, 'finished bytes');
      await kind.insert(id, partial, status, new Date(Date.now() - 25 * HOUR));
      return { id, finished };
    }

    const statusOfRow = async (kind: Kind, id: string) => {
      const [row] = await db
        .select({ status: kind.table.status })
        .from(kind.table)
        .where(eq(kind.table.id, id));
      return row!.status;
    };

    describe.each([repos, dumps])('$name', (kind) => {
      it.each(['uploading', 'completing'])(
        'cancels a stale %s session whose only file is the final one, and removes it',
        async (status) => {
          const stale = await movedFinal(kind, status);

          await reapAbandonedUploads(db);

          expect(await statusOfRow(kind, stale.id)).toBe('cancelled');
          expect(await exists(stale.finished)).toBe(false);
        },
      );
    });

    it('keeps a final-named file of a stale bundle session, whose final path belongs to the bundle', async () => {
      const stale = await movedFinal(bundles, 'uploading');

      await reapAbandonedUploads(db);

      expect(await statusOfRow(bundles, stale.id)).toBe('cancelled');
      expect(await exists(stale.finished)).toBe(true);
    });

    it('keeps the final file of a complete repository session beside the stale one it removes', async () => {
      const stale = await movedFinal(repos, 'uploading');
      const doneId = randomUUID();
      const done = path.join(root, 'repos', '_uploads', userId, `${doneId}.zip`);
      await writeFile(done, 'archive bytes');
      const old = new Date(Date.now() - 72 * HOUR);
      await utimes(done, old, old);
      await repos.insert(doneId, done, 'complete', old);
      await db.insert(schema.repositories).values({
        id: doneId,
        userId,
        name: 'archive-test',
        source: 'upload',
        storagePath: path.join(root, userId, doneId),
        status: 'cloning',
      });

      await reapAbandonedUploads(db);

      expect(await exists(stale.finished)).toBe(false);
      expect(await statusOfRow(repos, doneId)).toBe('complete');
      expect(await exists(done)).toBe(true);
    });

    // A claim parks a session in reaping until every file it owns is gone, and every pass finishes
    // those rows, whatever their age.
    describe('a reaped session stays reaping until its files are gone', () => {
      // A session row naming its partial, with the partial and the finished file beside it both on disk.
      async function withBoth(kind: Kind, status: string, idleMs: number) {
        const id = randomUUID();
        const partial = path.join(root, kind.volume, '_uploads', userId, kind.partial(id));
        const finished = partial.replace(/\.partial$/, '');
        await writeFile(partial, 'partial bytes');
        await writeFile(finished, 'finished bytes');
        await kind.insert(id, partial, status, new Date(Date.now() - idleMs));
        return { id, partial, finished };
      }

      describe.each([repos, dumps])('$name', (kind) => {
        it('a stale session whose finished file cannot be removed stays reaping, and the next pass removes both files and cancels it', async () => {
          const stale = await withBoth(kind, 'uploading', 25 * HOUR);
          faults.removal = (rel) => !rel.endsWith('.partial');

          const failed = await reapAbandonedUploads(db);

          expect(await statusOfRow(kind, stale.id)).toBe('reaping');
          expect(await exists(stale.finished)).toBe(true);
          expect(await exists(stale.partial)).toBe(false);
          expect(failed.sessions).toBe(0);

          faults.removal = null;
          const finished = await reapAbandonedUploads(db);

          expect(await statusOfRow(kind, stale.id)).toBe('cancelled');
          expect(await exists(stale.finished)).toBe(false);
          expect(finished.sessions).toBe(1);
        });

        it('a stale session whose partial cannot be removed stays reaping, and its finished file still goes', async () => {
          const stale = await withBoth(kind, 'completing', 25 * HOUR);
          faults.removal = (rel) => rel.endsWith('.partial');

          await reapAbandonedUploads(db);

          expect(await statusOfRow(kind, stale.id)).toBe('reaping');
          expect(await exists(stale.partial)).toBe(true);
          expect(await exists(stale.finished)).toBe(false);

          faults.removal = null;
          await reapAbandonedUploads(db);

          expect(await statusOfRow(kind, stale.id)).toBe('cancelled');
          expect(await exists(stale.partial)).toBe(false);
        });

        it.each([
          ['just now', 0],
          ['five days ago', 120 * HOUR],
        ])(
          'finishes a row a dead worker left reaping with both its files, updated %s',
          async (_when, idleMs) => {
            const dead = await withBoth(kind, 'reaping', idleMs);

            const result = await reapAbandonedUploads(db);

            expect(await statusOfRow(kind, dead.id)).toBe('cancelled');
            expect(await exists(dead.partial)).toBe(false);
            expect(await exists(dead.finished)).toBe(false);
            expect(result.sessions).toBe(1);
          },
        );
      });

      describe('a bundle session', () => {
        it('keeps its bundle’s final path while its partial cannot be removed, and after the next pass cancels it', async () => {
          const stale = await withBoth(bundles, 'uploading', 25 * HOUR);
          faults.removal = (rel) => rel.endsWith('.partial');

          await reapAbandonedUploads(db);

          expect(await statusOfRow(bundles, stale.id)).toBe('reaping');
          expect(await exists(stale.finished)).toBe(true);

          faults.removal = null;
          await reapAbandonedUploads(db);

          expect(await statusOfRow(bundles, stale.id)).toBe('cancelled');
          expect(await exists(stale.partial)).toBe(false);
          expect(await exists(stale.finished)).toBe(true);
        });

        it('keeps its bundle’s final path when a dead worker left the row reaping', async () => {
          const dead = await withBoth(bundles, 'reaping', 0);

          await reapAbandonedUploads(db);

          expect(await statusOfRow(bundles, dead.id)).toBe('cancelled');
          expect(await exists(dead.partial)).toBe(false);
          expect(await exists(dead.finished)).toBe(true);
        });
      });

      it('leaves the completed dump a task links alone while a stale dump session stays reaping beside it', async () => {
        const linked = await dump(5 * 24 * HOUR);
        await link(linked.id, 'running', 5 * 24 * HOUR);
        const stale = await withBoth(dumps, 'uploading', 25 * HOUR);
        faults.removal = (rel) => rel.endsWith('.partial');

        await reapAbandonedUploads(db);

        expect(await statusOfRow(dumps, stale.id)).toBe('reaping');
        expect(await statusOf(linked.id)).toBe('complete');
        expect(await exists(linked.file)).toBe(true);

        faults.removal = null;
        await reapAbandonedUploads(db);

        expect(await statusOfRow(dumps, stale.id)).toBe('cancelled');
        expect(await statusOf(linked.id)).toBe('complete');
        expect(await exists(linked.file)).toBe(true);
      });
    });
  });

  describe('the file pass', () => {
    const kinds = [
      {
        name: 'repo_uploads',
        volume: 'repos',
        partial: (id: string) => `${id}.zip.partial`,
        insert: (id: string, file: string, status: string, updatedAt: Date) =>
          db.insert(schema.repoUploads).values({
            id,
            userId,
            filename: 'a.zip',
            archiveFormat: 'zip',
            totalSize: 10,
            bytesReceived: 10,
            chunkSize: 10,
            archivePath: file.replace(/\.partial$/, ''),
            status,
            updatedAt,
          }),
      },
      {
        name: 'db_uploads',
        volume: 'repos',
        partial: (id: string) => `db-${id}.sql.partial`,
        insert: (id: string, file: string, status: string, updatedAt: Date) =>
          db.insert(schema.dbUploads).values({
            id,
            userId,
            filename: 'a.sql',
            dumpFormat: 'sql',
            totalSize: 10,
            bytesReceived: 10,
            chunkSize: 10,
            dumpPath: file.replace(/\.partial$/, ''),
            status,
            updatedAt,
          }),
      },
      {
        name: 'custom_bundle_uploads',
        volume: 'bundles',
        partial: (id: string) => `${id}.tar.gz.partial`,
        insert: (id: string, file: string, status: string, updatedAt: Date) =>
          db.insert(schema.customBundleUploads).values({
            id,
            userId,
            repositoryId: repoId,
            name: 'kit',
            filename: 'a.tar.gz',
            archiveFormat: 'tar.gz',
            totalSize: 10,
            bytesReceived: 10,
            chunkSize: 10,
            archivePath: file.replace(/\.partial$/, ''),
            status,
            updatedAt,
          }),
      },
    ];

    async function oldPartial(volume: string, name: string) {
      const file = path.join(root, volume, '_uploads', userId, name);
      await writeFile(file, 'partial bytes');
      const old = new Date(Date.now() - 25 * HOUR);
      await utimes(file, old, old);
      return file;
    }

    describe.each(kinds)('$name', (kind) => {
      it('keeps an old partial whose session a complete has just claimed', async () => {
        const id = randomUUID();
        const file = await oldPartial(kind.volume, kind.partial(id));
        await kind.insert(id, file, 'complete', new Date());

        await reapAbandonedUploads(db);

        expect(await exists(file)).toBe(true);
      });

      it('removes it once the row was last updated 25 h ago', async () => {
        const id = randomUUID();
        const file = await oldPartial(kind.volume, kind.partial(id));
        await kind.insert(id, file, 'cancelled', new Date(Date.now() - 25 * HOUR));

        await reapAbandonedUploads(db);

        expect(await exists(file)).toBe(false);
      });
    });
  });

  describe('a cancelled dump row a day after it was cancelled', () => {
    async function cancelledDump() {
      const id = randomUUID();
      await db.insert(schema.dbUploads).values({
        id,
        userId,
        filename: 'a.sql',
        dumpFormat: 'sql',
        totalSize: 10,
        bytesReceived: 10,
        chunkSize: 10,
        dumpPath: path.join(root, 'repos', '_uploads', userId, `db-${id}.sql`),
        status: 'cancelled',
        updatedAt: new Date(Date.now() - 25 * HOUR),
      });
      return id;
    }
    const rowCount = async (id: string) =>
      (
        await db
          .select({ id: schema.dbUploads.id })
          .from(schema.dbUploads)
          .where(eq(schema.dbUploads.id, id))
      ).length;

    it.each(['completed', 'failed', 'running'] as const)(
      'stays with the link of a %s task while an unlinked one is deleted',
      async (taskStatus) => {
        const linked = await cancelledDump();
        const free = await cancelledDump();
        await link(linked, taskStatus, 5 * 24 * HOUR);

        await reapAbandonedUploads(db);

        expect(await rowCount(linked)).toBe(1);
        expect(await rowCount(free)).toBe(0);
        const task = await db.query.tasks.findFirst({ where: eq(schema.tasks.userId, userId) });
        expect(task!.dbUploadId).toBe(linked);
      },
    );
  });
});

describe.skipIf(!url)('the finished repository archive pass against Postgres', () => {
  let db: Database;
  let root: string;
  let userId: string;
  const saved: Record<string, string | undefined> = {};

  beforeAll(async () => {
    db = createDatabase(url!);
    root = await mkdtemp(path.join(tmpdir(), 'upload-reaper-archive-'));
    for (const [env, dir] of [
      ['REPO_STORAGE_ROOT', 'repos'],
      ['BUNDLE_STORAGE_ROOT', 'bundles'],
    ] as const) {
      saved[env] = process.env[env];
      process.env[env] = path.join(root, dir);
    }
  });
  beforeEach(async () => {
    userId = randomUUID();
    await db.insert(schema.users).values({
      id: userId,
      emailEncrypted: 'test',
      emailBlindIndex: userId,
      passwordHash: 'test',
    });
    await mkdir(path.join(root, 'repos', '_uploads', userId), { recursive: true });
  });
  afterEach(async () => {
    await db.delete(schema.users).where(eq(schema.users.id, userId));
  });
  afterAll(async () => {
    for (const [env, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[env];
      else process.env[env] = value;
    }
    await rm(root, { recursive: true, force: true });
    await db.$client.end({ timeout: 5 });
  });

  const exists = async (file: string) => (await lstat(file).catch(() => null)) !== null;

  async function archive(status: 'error' | 'cloning' | 'ready' | null) {
    const id = randomUUID();
    if (status !== null) {
      await db.insert(schema.repositories).values({
        id,
        userId,
        name: 'archive-test',
        source: 'upload',
        storagePath: path.join(root, userId, id),
        status,
      });
    }
    const file = path.join(root, 'repos', '_uploads', userId, `${id}.zip`);
    await writeFile(file, 'finished bytes');
    const old = new Date(Date.now() - 25 * HOUR);
    await utimes(file, old, old);
    return file;
  }

  it.each([
    ['error', true],
    [null, true],
    ['cloning', false],
    ['ready', false],
  ] as const)('with repository %s the archive is removed: %s', async (status, removed) => {
    const file = await archive(status);

    await reapAbandonedUploads(db);

    expect(await exists(file)).toBe(!removed);
  });

  it('keeps a legacy archive whose owner has a cloning repository and removes it once none is', async () => {
    const file = await archive(null);
    const cloningId = randomUUID();
    await db.insert(schema.repositories).values({
      id: cloningId,
      userId,
      name: 'archive-test',
      source: 'upload',
      storagePath: path.join(root, userId, cloningId),
      status: 'cloning',
    });

    await reapAbandonedUploads(db);
    expect(await exists(file)).toBe(true);

    await db
      .update(schema.repositories)
      .set({ status: 'ready' })
      .where(eq(schema.repositories.id, cloningId));
    await reapAbandonedUploads(db);
    expect(await exists(file)).toBe(false);
  });
});

describe.skipIf(!url)('the tasks.db_upload_id index', () => {
  let db: Database;
  beforeAll(() => {
    db = createDatabase(url!);
  });
  afterAll(async () => {
    await db.$client.end({ timeout: 5 });
  });

  it('exists on tasks (db_upload_id)', async () => {
    const rows = await db.execute(
      sql`SELECT indexdef FROM pg_indexes WHERE tablename = 'tasks' AND indexname = 'tasks_db_upload_id_idx'`,
    );
    expect(rows).toHaveLength(1);
    expect(String(rows[0]!.indexdef)).toContain('(db_upload_id)');
  });

  it('serves the keyed lookup the reaper issues', async () => {
    const plan = await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL enable_seqscan = off`);
      return tx.execute(
        sql.raw(
          `EXPLAIN (FORMAT JSON) SELECT id FROM tasks WHERE db_upload_id IN ('${randomUUID()}', '${randomUUID()}')`,
        ),
      );
    });
    expect(JSON.stringify(plan)).toContain('tasks_db_upload_id_idx');
  });
});
