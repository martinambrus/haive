import { readdirSync, readlinkSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const USER = vi.hoisted(() => '00000000-0000-4000-8000-0000000000a1');
const h = vi.hoisted(() => ({ db: undefined as unknown }));

vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/middleware/auth.js', () => ({
  requireAuth: async (c: { set: (key: string, value: string) => void }, next: () => unknown) => {
    c.set('userId', USER);
    await next();
  },
}));

import { Hono } from 'hono';
import type { PgTable } from 'drizzle-orm/pg-core';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { logger } from '@haive/shared';
import { repoRoutes } from '../src/routes/repos.js';
import { dbDumpRoutes } from '../src/routes/db-dumps.js';
import { bundleRoutes } from '../src/routes/bundles.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';

// A chunk is capped at its declared length and rolled back on the file it wrote into, never on
// what stands at the session's name. Writes are failed at FileHandle.prototype.write, by bytes.

const SESSION = '00000000-0000-4000-8000-0000000000b1';
const REPO = '00000000-0000-4000-8000-0000000000f1';
const TOTAL = 1000;

// CHUNK is a part of neither PREVIOUS nor OTHER, so a write is matched on its own bytes.
const PREVIOUS = Buffer.from('previous chunk bytes');
const CHUNK = Buffer.from('this chunk is half written and then fails\n');
const SHORT = CHUNK.subarray(0, 20);
const LONG = Buffer.concat([CHUNK, Buffer.from('and a surplus the range never declared')]);
// Longer than PREVIOUS, so a truncation shows in its size and in its bytes.
const OTHER = Buffer.from('a file somebody else saved at the name; it is longer than PREVIOUS');

const mount = (routes: Hono<AppEnv>): Hono<AppEnv> => {
  const app = new Hono<AppEnv>();
  app.route('/', routes);
  app.onError(errorHandler);
  return app;
};

interface Family {
  name: string;
  app: Hono<AppEnv>;
  chunkUrl: (id: string) => string;
  table: PgTable;
  volume: 'repos' | 'bundles';
  pathColumn: string;
  fileName: (id: string) => string;
  columns: Record<string, unknown>;
}

const FAMILIES: Family[] = [
  {
    name: 'repos',
    app: mount(repoRoutes),
    chunkUrl: (id) => `/upload/${id}/chunk`,
    table: schema.repoUploads,
    volume: 'repos',
    pathColumn: 'archivePath',
    fileName: (id) => `${id}.zip.partial`,
    columns: { filename: 'a.zip', archiveFormat: 'zip' },
  },
  {
    name: 'db-dumps',
    app: mount(dbDumpRoutes),
    chunkUrl: (id) => `/upload/${id}/chunk`,
    table: schema.dbUploads,
    volume: 'repos',
    pathColumn: 'dumpPath',
    fileName: (id) => `db-${id}.sql.partial`,
    columns: { filename: 'a.sql', dumpFormat: 'sql' },
  },
  {
    name: 'bundles',
    app: mount(bundleRoutes),
    chunkUrl: (id) => `/uploads/${id}/chunk`,
    table: schema.customBundleUploads,
    volume: 'bundles',
    pathColumn: 'archivePath',
    fileName: (id) => `${id}.zip.partial`,
    columns: {
      repositoryId: REPO,
      name: 'bundle',
      enabledKinds: ['agent', 'skill'],
      filename: 'a.zip',
      archiveFormat: 'zip',
    },
  },
];

type Write = (this: FileHandle, ...args: unknown[]) => Promise<unknown>;

let proto: { write: unknown };
let realWrite: Write;

beforeAll(async () => {
  const probe = await open(fileURLToPath(import.meta.url), 'r');
  proto = Object.getPrototypeOf(probe) as { write: unknown };
  realWrite = proto.write as Write;
  await probe.close();
});

afterEach(() => {
  proto.write = realWrite;
});

// Reads write(buffer, offset, length, position) and write(buffer, { offset, length, position });
// any other call shape throws, so a write it cannot match never passes unseen.
function bytesOf(args: unknown[]): { chunk: Buffer; position: unknown } {
  const [data, a, b, c] = args;
  if (!ArrayBuffer.isView(data)) {
    throw new Error('fault injection reads only write(buffer, offset, length, position)');
  }
  const opts =
    typeof a === 'object' && a !== null
      ? (a as { offset?: number; length?: number; position?: unknown })
      : { offset: a as number | undefined, length: b as number | undefined, position: c };
  const bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  const offset = opts.offset ?? 0;
  const length = opts.length ?? bytes.length - offset;
  return { chunk: bytes.subarray(offset, offset + length), position: opts.position };
}

// With an `error` the write lands its first half and fails; without one it lands whole and returns.
// `during` runs once in between, on the descriptor written through.
function interceptWriteOf(
  content: Buffer,
  fault: { error?: Error; during?: (fh: FileHandle) => Promise<void> },
): { fired: number } {
  const seen = { fired: 0 };
  proto.write = async function (this: FileHandle, ...args: unknown[]) {
    const { chunk, position } = bytesOf(args);
    if (chunk.length === 0 || !content.includes(chunk)) return realWrite.apply(this, args);
    seen.fired += 1;
    if (fault.error === undefined) {
      const done = await realWrite.call(this, chunk, 0, chunk.length, position);
      if (seen.fired === 1) await fault.during?.(this);
      return done;
    }
    await realWrite.call(this, chunk, 0, Math.max(1, Math.floor(chunk.length / 2)), position);
    await fault.during?.(this);
    throw fault.error;
  };
  return seen;
}

// Counts the bytes every write asks for, and lets `release` go the moment the first one is seen.
function countWrites(release: () => void): { bytes: number } {
  const seen = { bytes: 0 };
  proto.write = async function (this: FileHandle, ...args: unknown[]) {
    release();
    seen.bytes += bytesOf(args).chunk.length;
    return realWrite.apply(this, args);
  };
  return seen;
}

// A body of two pieces, the second held back until the first has reached a write (or 250 ms have
// passed), so the route cannot be handed both in one read.
function inTwoPieces(first: Buffer, second: Buffer) {
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  setTimeout(release, 250).unref();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(first));
    },
    async pull(controller) {
      await released;
      try {
        controller.enqueue(new Uint8Array(second));
        controller.close();
      } catch {
        // the route stopped reading before the second piece was released
      }
    },
  });
  return { body, release };
}

// A handle the route did not close is still listed here once it has answered.
const openUnder = (dir: string): string[] =>
  readdirSync('/proc/self/fd')
    .map((fd) => {
      try {
        return readlinkSync(`/proc/self/fd/${fd}`);
      } catch {
        return '';
      }
    })
    .filter((target) => target.startsWith(dir));

const enospc = (): Error =>
  Object.assign(new Error('ENOSPC: no space left on device, write'), {
    code: 'ENOSPC',
    errno: -28,
    syscall: 'write',
  });

describe('a chunk of a chunked upload that is rolled back', () => {
  let storage: string;
  let volumes: { repos: string; bundles: string };
  let fake: ReturnType<typeof createUploadDb>;
  const saved: Record<string, string | undefined> = {};

  const createUploadDb = () =>
    createFakeDb({
      repoUploads: schema.repoUploads,
      dbUploads: schema.dbUploads,
      customBundleUploads: schema.customBundleUploads,
    });

  beforeEach(async () => {
    vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    storage = await mkdtemp(path.join(tmpdir(), 'upload-chunk-'));
    volumes = { repos: path.join(storage, 'repos'), bundles: path.join(storage, 'bundles') };
    for (const [env, root] of [
      ['REPO_STORAGE_ROOT', volumes.repos],
      ['BUNDLE_STORAGE_ROOT', volumes.bundles],
    ] as const) {
      saved[env] = process.env[env];
      process.env[env] = root;
      await mkdir(path.join(root, '_uploads', USER), { recursive: true });
    }
    fake = createUploadDb();
    h.db = fake.db;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const env of ['REPO_STORAGE_ROOT', 'BUNDLE_STORAGE_ROOT']) {
      if (saved[env] === undefined) delete process.env[env];
      else process.env[env] = saved[env];
    }
    await rm(storage, { recursive: true, force: true });
  });

  interface Session {
    file: string;
    aside: string;
    own?: bigint;
  }

  async function seed(
    family: Family,
    held: Buffer = PREVIOUS,
    onDisk: Buffer = held,
  ): Promise<Session> {
    const file = path.join(volumes[family.volume], '_uploads', USER, family.fileName(SESSION));
    await writeFile(file, onDisk, { mode: 0o644 });
    fake.insert(family.table, {
      id: SESSION,
      userId: USER,
      totalSize: TOTAL,
      bytesReceived: held.length,
      chunkSize: 64,
      status: 'uploading',
      [family.pathColumn]: file,
      ...family.columns,
    });
    return { file, aside: path.join(storage, 'session-own-file') };
  }

  const received = (family: Family): number =>
    Number(fake.rows(family.table).find((r) => r.id === SESSION)!.bytesReceived);

  const put = async (
    family: Family,
    body: Buffer | ReadableStream<Uint8Array>,
    range: { start: number; length: number } = {
      start: PREVIOUS.length,
      length: (body as Buffer).length,
    },
  ): Promise<{
    status: number;
    body: { session?: { bytesReceived?: number } } | null;
    open: string[];
  }> => {
    const res = await family.app.request(family.chunkUrl(SESSION), {
      method: 'PUT',
      headers: {
        'content-range': `bytes ${range.start}-${range.start + range.length - 1}/${TOTAL}`,
      },
      body: body instanceof ReadableStream ? body : new Uint8Array(body),
      duplex: 'half',
    } as RequestInit);
    return {
      status: res.status,
      body: (await res.json().catch(() => null)) as { session?: { bytesReceived?: number } } | null,
      open: openUnder(storage),
    };
  };

  async function otherFile() {
    const other = path.join(storage, 'other.bin');
    await writeFile(other, OTHER, { mode: 0o600 });
    return { other, before: await lstat(other) };
  }

  // The other file takes the session's name; the session's own file, still held by the write in
  // flight, is moved aside.
  const putOtherAtTheName =
    (session: Session, other: string) =>
    async (fh: FileHandle): Promise<void> => {
      session.own = (await fh.stat({ bigint: true })).ino;
      await rename(session.file, session.aside);
      await rename(other, session.file);
    };

  async function expectOtherFileKept(session: Session, before: { ino: number }): Promise<void> {
    const stands = await lstat(session.file).catch(() => null);
    expect(
      stands?.isFile() ?? false,
      'the other file is still at the session’s name (it was removed)',
    ).toBe(true);
    const found = await readFile(session.file, 'latin1');
    expect(
      found,
      `the other file holds its own bytes (${found.length} found, ${OTHER.length} expected: the rollback truncated it)`,
    ).toBe(OTHER.toString('latin1'));
    expect(stands?.ino, 'it is the other file’s inode').toBe(before.ino);
  }

  async function expectOwnFileRolledBack(session: Session): Promise<void> {
    const own = await lstat(session.aside, { bigint: true });
    expect(own.ino, 'the file moved aside is the one the failing write went through').toBe(
      session.own,
    );
    const found = await readFile(session.aside, 'latin1');
    expect(
      found,
      `the session’s own file holds exactly its previous bytes (${found.length} found, ${PREVIOUS.length} expected)`,
    ).toBe(PREVIOUS.toString('latin1'));
  }

  describe.each(FAMILIES)('PUT chunk of the $name upload', (family) => {
    it('E1 keeps a different file put at the session’s name when a chunk write fails part-way', async () => {
      const session = await seed(family);
      const { other, before } = await otherFile();
      const fault = interceptWriteOf(CHUNK, {
        error: enospc(),
        during: putOtherAtTheName(session, other),
      });

      const res = await put(family, CHUNK);

      expect(fault.fired, 'the chunk’s bytes reached FileHandle.prototype.write and failed').toBe(
        1,
      );
      expect(res.status, 'the chunk is refused').toBe(500);
      expect(received(family), 'the session’s byte count is not advanced').toBe(PREVIOUS.length);
      await expectOtherFileKept(session, before);
      await expectOwnFileRolledBack(session);
    });

    it('E1b keeps a different file put at the session’s name when a wrong-length chunk is rolled back', async () => {
      const session = await seed(family);
      const { other, before } = await otherFile();
      const fault = interceptWriteOf(SHORT, { during: putOtherAtTheName(session, other) });

      const res = await put(family, SHORT, { start: PREVIOUS.length, length: CHUNK.length });

      expect(fault.fired, 'the chunk’s bytes reached FileHandle.prototype.write').toBe(1);
      expect(res.status, 'the chunk is refused as shorter than declared').toBe(400);
      expect(received(family), 'the session’s byte count is not advanced').toBe(PREVIOUS.length);
      await expectOtherFileKept(session, before);
      await expectOwnFileRolledBack(session);
    });

    it('E7 writes no more than the declared length of a chunk that exceeds it, and refuses it', async () => {
      const session = await seed(family);
      const first = CHUNK.subarray(0, 20);
      const surplus = Buffer.alloc(CHUNK.length - first.length + 5 * 1024 * 1024, 0x61);
      const pieces = inTwoPieces(first, surplus);
      const written = countWrites(pieces.release);

      const res = await put(family, pieces.body, { start: PREVIOUS.length, length: CHUNK.length });

      expect(res.status, 'the chunk is refused').toBe(400);
      expect(
        written.bytes,
        `${written.bytes} bytes reached FileHandle.prototype.write for a ${CHUNK.length}-byte chunk`,
      ).toBeLessThanOrEqual(CHUNK.length);
      expect(res.open.join(', '), 'no descriptor of the upload is left open').toBe('');
      expect(received(family), 'the session’s byte count is not advanced').toBe(PREVIOUS.length);
      expect(await readFile(session.file, 'latin1'), 'the session file is rolled back').toBe(
        PREVIOUS.toString('latin1'),
      );
    });

    it('E2 pin: a chunk whose write fails leaves the session file at its previous length', async () => {
      const session = await seed(family);
      const fault = interceptWriteOf(CHUNK, { error: enospc() });

      const res = await put(family, CHUNK);

      expect(fault.fired, 'the chunk’s bytes reached FileHandle.prototype.write and failed').toBe(
        1,
      );
      expect(res.status, 'the chunk is refused').toBe(500);
      expect(res.open.join(', '), 'no descriptor of the upload is left open').toBe('');
      expect(received(family), 'the session’s byte count is not advanced').toBe(PREVIOUS.length);
      expect(await readFile(session.file, 'latin1'), 'the session file is rolled back').toBe(
        PREVIOUS.toString('latin1'),
      );
    });

    it('E2 pin: refuses a chunk shorter than declared and leaves the file at its previous length', async () => {
      const session = await seed(family);

      const res = await put(family, SHORT, { start: PREVIOUS.length, length: CHUNK.length });

      expect(res.status, 'the chunk is refused').toBe(400);
      expect(res.open.join(', '), 'no descriptor of the upload is left open').toBe('');
      expect(received(family), 'the session’s byte count is not advanced').toBe(PREVIOUS.length);
      expect(await readFile(session.file, 'latin1'), 'the session file is rolled back').toBe(
        PREVIOUS.toString('latin1'),
      );
    });

    it('E2 pin: refuses a chunk longer than declared and leaves the file at its previous length', async () => {
      const session = await seed(family);

      const res = await put(family, LONG, { start: PREVIOUS.length, length: CHUNK.length });

      expect(res.status, 'the chunk is refused').toBe(400);
      expect(res.open.join(', '), 'no descriptor of the upload is left open').toBe('');
      expect(received(family), 'the session’s byte count is not advanced').toBe(PREVIOUS.length);
      expect(await readFile(session.file, 'latin1'), 'the session file is rolled back').toBe(
        PREVIOUS.toString('latin1'),
      );
    });

    it('E2 pin: a good chunk lands at the session’s offset and advances its byte count', async () => {
      const session = await seed(family);

      const res = await put(family, CHUNK);

      expect(res.status, 'the chunk is accepted').toBe(200);
      expect(res.open.join(', '), 'no descriptor of the upload is left open').toBe('');
      expect(res.body?.session?.bytesReceived, 'the response carries the new byte count').toBe(
        PREVIOUS.length + CHUNK.length,
      );
      expect(received(family), 'the session’s byte count is advanced').toBe(
        PREVIOUS.length + CHUNK.length,
      );
      expect(await readFile(session.file, 'latin1'), 'the chunk follows the previous bytes').toBe(
        Buffer.concat([PREVIOUS, CHUNK]).toString('latin1'),
      );
    });

    it('E2 pin: a good chunk lands at the session’s offset, not at the end of a longer file', async () => {
      // The file is longer than its row says, so writing at the offset and appending differ.
      const session = await seed(family, PREVIOUS, Buffer.concat([PREVIOUS, Buffer.from('tail')]));

      const res = await put(family, CHUNK);

      expect(res.status, 'the chunk is accepted').toBe(200);
      expect(res.open.join(', '), 'no descriptor of the upload is left open').toBe('');
      expect(await readFile(session.file, 'latin1'), 'the chunk replaces the tail').toBe(
        Buffer.concat([PREVIOUS, CHUNK]).toString('latin1'),
      );
    });
  });
});
