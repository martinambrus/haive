/**
 * Two PUTs of the same chunk range against a database: one writes, the other is refused at once
 * with 409, and a refused or failed second writer never touches the first one's bytes. The first
 * writer is held mid-body on a stream the smoke controls, for each of the three chunked uploads.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import { configService, secretsService, userSecretsService, logger } from '@haive/shared';
import { initDatabase, getDb } from '../src/db.js';
import { initRedis, closeRedis } from '../src/redis.js';
import { createApiApp } from '../src/index.js';
import { signAccessToken } from '../src/auth/jwt.js';
import { ACCESS_COOKIE } from '../src/auth/cookies.js';

const log = logger.child({ module: 'upload-chunk-lock-smoke' });

for (const k of ['DATABASE_URL', 'REDIS_URL', 'CONFIG_ENCRYPTION_KEY'] as const) {
  if (!process.env[k]) {
    console.error(`[smoke] missing env ${k}`);
    process.exit(2);
  }
}

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    log.info({ check: name }, 'ok');
    return;
  }
  failures += 1;
  log.error({ check: name, detail }, 'FAILED');
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const PREVIOUS = Buffer.alloc(16, 0x50);
const LENGTH = 64;
const TOTAL = 1000;
const FIRST = Buffer.alloc(LENGTH / 2, 0x41);
const REST = Buffer.alloc(LENGTH / 2, 0x41);
const WHOLE = Buffer.concat([FIRST, REST]);

/** A body of two pieces, the second held back until `release` is called. */
function heldBody() {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(FIRST));
    },
    async pull(controller) {
      await gate;
      controller.enqueue(new Uint8Array(REST));
      controller.close();
    },
  });
  return { body, release };
}

async function waitForSize(file: string, size: number): Promise<boolean> {
  for (let i = 0; i < 100; i += 1) {
    if ((await stat(file).catch(() => null))?.size === size) return true;
    await sleep(50);
  }
  return false;
}

interface Family {
  name: string;
  url: (id: string) => string;
  file: (root: { repos: string; bundles: string }, userId: string, id: string) => string;
  insert: (id: string, userId: string, file: string, repositoryId: string) => Promise<void>;
  received: (id: string) => Promise<number>;
}

const db = () => getDb();

const FAMILIES: Family[] = [
  {
    name: 'repos',
    url: (id) => `/repos/upload/${id}/chunk`,
    file: (root, userId, id) => path.join(root.repos, '_uploads', userId, `${id}.zip.partial`),
    insert: async (id, userId, file) => {
      await db().insert(schema.repoUploads).values({
        id,
        userId,
        filename: 'a.zip',
        archiveFormat: 'zip',
        totalSize: TOTAL,
        bytesReceived: PREVIOUS.length,
        chunkSize: 64,
        archivePath: file,
        status: 'uploading',
      });
    },
    received: async (id) =>
      Number(
        (await db().query.repoUploads.findFirst({ where: eq(schema.repoUploads.id, id) }))!
          .bytesReceived,
      ),
  },
  {
    name: 'db-dumps',
    url: (id) => `/db-dumps/upload/${id}/chunk`,
    file: (root, userId, id) => path.join(root.repos, '_uploads', userId, `db-${id}.sql.partial`),
    insert: async (id, userId, file) => {
      await db().insert(schema.dbUploads).values({
        id,
        userId,
        filename: 'a.sql',
        dumpFormat: 'sql',
        totalSize: TOTAL,
        bytesReceived: PREVIOUS.length,
        chunkSize: 64,
        dumpPath: file,
        status: 'uploading',
      });
    },
    received: async (id) =>
      Number(
        (await db().query.dbUploads.findFirst({ where: eq(schema.dbUploads.id, id) }))!
          .bytesReceived,
      ),
  },
  {
    name: 'bundles',
    url: (id) => `/bundles/uploads/${id}/chunk`,
    file: (root, userId, id) => path.join(root.bundles, '_uploads', userId, `${id}.zip.partial`),
    insert: async (id, userId, file, repositoryId) => {
      await db()
        .insert(schema.customBundleUploads)
        .values({
          id,
          userId,
          repositoryId,
          name: 'bundle',
          enabledKinds: ['agent', 'skill'],
          filename: 'a.zip',
          archiveFormat: 'zip',
          totalSize: TOTAL,
          bytesReceived: PREVIOUS.length,
          chunkSize: 64,
          archivePath: file,
          status: 'uploading',
        });
    },
    received: async (id) =>
      Number(
        (await db().query.customBundleUploads.findFirst({
          where: eq(schema.customBundleUploads.id, id),
        }))!.bytesReceived,
      ),
  },
];

async function main(): Promise<void> {
  let userId: string | undefined;
  let repoId: string | undefined;
  let storage: string | undefined;
  let exitCode = 0;
  const savedEnv = {
    REPO_STORAGE_ROOT: process.env.REPO_STORAGE_ROOT,
    BUNDLE_STORAGE_ROOT: process.env.BUNDLE_STORAGE_ROOT,
  };
  try {
    initRedis(process.env.REDIS_URL!);
    await configService.initialize(process.env.REDIS_URL!);
    const database = initDatabase(process.env.DATABASE_URL!);
    await secretsService.initialize(database);
    await userSecretsService.initialize(database, await secretsService.getMasterKek());

    storage = await mkdtemp(path.join(tmpdir(), 'upload-chunk-lock-'));
    const root = { repos: path.join(storage, 'repos'), bundles: path.join(storage, 'bundles') };
    process.env.REPO_STORAGE_ROOT = root.repos;
    process.env.BUNDLE_STORAGE_ROOT = root.bundles;

    const app = createApiApp('http://localhost:3000');
    userId = randomUUID();
    const now = new Date();
    await database.insert(schema.users).values({
      id: userId,
      emailEncrypted: 'upload-chunk-lock-smoke@test.local',
      emailBlindIndex: `upload-chunk-lock-${randomBytes(4).toString('hex')}`,
      passwordHash: 'smoke-not-real',
      role: 'user',
      status: 'active',
      tokenVersion: 0,
      createdAt: now,
      updatedAt: now,
    });
    const [repo] = await database
      .insert(schema.repositories)
      .values({
        userId,
        name: `upload-lock-${randomBytes(3).toString('hex')}`,
        source: 'local_path',
        localPath: '/tmp/fake',
        storagePath: '/tmp/fake',
        status: 'ready',
      })
      .returning();
    repoId = repo!.id;
    const cookie = `${ACCESS_COOKIE}=${await signAccessToken({ sub: userId, role: 'user', tv: 0 })}`;

    const put = (
      family: Family,
      id: string,
      body: Buffer | ReadableStream<Uint8Array>,
      len = LENGTH,
    ) =>
      app.request(family.url(id), {
        method: 'PUT',
        headers: {
          cookie,
          'content-range': `bytes ${PREVIOUS.length}-${PREVIOUS.length + len - 1}/${TOTAL}`,
        },
        body: body instanceof ReadableStream ? body : new Uint8Array(body),
        duplex: 'half',
      } as RequestInit);

    for (const family of FAMILIES) {
      for (const scenario of ['same range, complete body', 'same range, short body'] as const) {
        const id = randomUUID();
        const file = family.file(root, userId, id);
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, PREVIOUS, { mode: 0o644 });
        await family.insert(id, userId, file, repoId);
        const label = `${family.name}, ${scenario}`;

        const held = heldBody();
        const first = put(family, id, held.body);
        const landed = await waitForSize(file, PREVIOUS.length + FIRST.length);
        check(`${label}: the first writer's half reached the file`, landed);

        let secondStatus = 0;
        let secondText = '';
        try {
          const second =
            scenario === 'same range, complete body'
              ? await put(family, id, Buffer.alloc(LENGTH, 0x42))
              : await put(family, id, Buffer.alloc(LENGTH / 4, 0x43));
          secondStatus = second.status;
          secondText = await second.text();
        } finally {
          held.release();
        }
        const firstRes = await first;
        const firstStatus = firstRes.status;
        await firstRes.text();

        const onDisk = await readFile(file);
        check(`${label}: the second writer is refused with 409`, secondStatus === 409, {
          secondStatus,
          secondText,
        });
        check(
          `${label}: the refusal names the race`,
          secondText.includes('chunk races another writer'),
          secondText,
        );
        check(`${label}: the first writer answers 200`, firstStatus === 200, firstStatus);
        check(
          `${label}: the file holds the previous bytes and the first writer's chunk only`,
          onDisk.equals(Buffer.concat([PREVIOUS, WHOLE])),
          { length: onDisk.length, head: onDisk.subarray(PREVIOUS.length).toString('latin1') },
        );
        const received = await family.received(id);
        check(
          `${label}: bytes_received advanced once`,
          received === PREVIOUS.length + LENGTH,
          received,
        );
      }
    }
  } catch (err) {
    exitCode = 1;
    log.error({ err }, 'smoke crashed');
  } finally {
    try {
      if (repoId) await database_delete(schema.repositories, repoId);
      if (userId) await database_delete(schema.users, userId);
    } catch (cleanupErr) {
      log.warn({ err: cleanupErr }, 'cleanup failed');
    }
    if (storage) await rm(storage, { recursive: true, force: true }).catch(() => {});
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await closeRedis().catch(() => {});
    const ok = exitCode === 0 && failures === 0;
    log.info({ failures }, ok ? 'upload chunk lock smoke passed' : 'FAILED');
    process.exit(ok ? 0 : 1);
  }
}

async function database_delete(
  table: typeof schema.repositories | typeof schema.users,
  id: string,
): Promise<void> {
  await getDb().delete(table).where(eq(table.id, id));
}

void main();
