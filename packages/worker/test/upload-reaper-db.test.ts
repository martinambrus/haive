import { randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, schema, type Database } from '@haive/database';
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
  let root: string;
  let userId: string;
  let repoId: string;
  const saved: Record<string, string | undefined> = {};

  beforeAll(async () => {
    db = createDatabase(url!);
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

  async function dump(idleMs: number) {
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
      status: 'complete',
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
