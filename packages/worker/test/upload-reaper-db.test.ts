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
      const upload = await dump(5 * 24 * HOUR, 'reaping');
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
});
