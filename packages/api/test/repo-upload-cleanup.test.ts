import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const USER = vi.hoisted(() => '00000000-0000-4000-8000-0000000000a1');
const h = vi.hoisted(() => ({
  db: undefined as unknown,
  add: vi.fn(async (..._args: unknown[]) => undefined),
}));

vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/middleware/auth.js', () => ({
  requireAuth: async (c: { set: (key: string, value: string) => void }, next: () => unknown) => {
    c.set('userId', USER);
    await next();
  },
}));
vi.mock('../src/queues.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/queues.js')>()),
  getRepoQueue: () => ({ add: h.add }),
}));

import { Hono } from 'hono';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { logger } from '@haive/shared';
import { repoRoutes } from '../src/routes/repos.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';

// POST /upload creates the archive's name exclusively and streams the upload into that descriptor.
// A stream that fails takes the archive back, and what it takes back is the file it created: a file
// somebody put at that name meanwhile is not its to remove, whatever it holds.
//
// The failure is injected at `FileHandle.prototype.write`, which the write stream the route pipes
// into reaches (`write(buffer, 0, length, null)`), chosen by the BYTES written as in
// task-file-write-failure.test.ts. The route is driven as repo-refresh-tree.test.ts drives its own.

const app = new Hono<AppEnv>();
app.route('/', repoRoutes);
app.onError(errorHandler);

// One chunk, so the stream writes it in a single call.
const ARCHIVE = Buffer.from(`PK\n${'a line of an archive\n'.repeat(12)}`, 'utf8');

type Write = (this: FileHandle, ...args: unknown[]) => Promise<unknown>;

type Stat = (this: FileHandle, opts?: { bigint?: boolean }) => Promise<unknown>;

let proto: { write: unknown; stat: unknown };
let realWrite: Write;
let realStat: Stat;

beforeAll(async () => {
  const probe = await open(fileURLToPath(import.meta.url), 'r');
  proto = Object.getPrototypeOf(probe) as { write: unknown; stat: unknown };
  realWrite = proto.write as Write;
  realStat = proto.stat as Stat;
  await probe.close();
});

afterEach(() => {
  proto.write = realWrite;
  proto.stat = realStat;
});

/** The first write of `content` lands its first half, runs `beforeThrow` and then fails; every
 *  other write goes through. Any call shape the harness cannot read throws. */
function failTheWriteOf(
  content: Buffer,
  error: Error,
  beforeThrow?: () => Promise<void>,
): { fired: number } {
  const fault = { fired: 0 };
  proto.write = async function (this: FileHandle, ...args: unknown[]) {
    const [data, offset, length, position] = args;
    if (!ArrayBuffer.isView(data) || typeof offset !== 'number' || typeof length !== 'number') {
      throw new Error('fault injection reads only write(buffer, offset, length, position)');
    }
    const chunk = Buffer.from(data.buffer, data.byteOffset, data.byteLength).subarray(
      offset,
      offset + length,
    );
    if (chunk.length === 0 || !content.includes(chunk)) return realWrite.apply(this, args);
    fault.fired += 1;
    await realWrite.call(this, chunk, 0, Math.max(1, Math.floor(chunk.length / 2)), position);
    await beforeThrow?.();
    throw error;
  };
  return fault;
}

describe('POST /upload when the archive stream fails', () => {
  let storage: string;
  let uploads: string;
  let fake: ReturnType<typeof createRepoDb>;
  let storedRoot: string | undefined;

  const createRepoDb = () => createFakeDb({ repositories: schema.repositories });

  beforeEach(async () => {
    vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    storage = await mkdtemp(path.join(tmpdir(), 'repo-upload-'));
    const root = path.join(storage, 'repos');
    await mkdir(root);
    uploads = path.join(root, '_uploads', USER);
    storedRoot = process.env.REPO_STORAGE_ROOT;
    process.env.REPO_STORAGE_ROOT = root;
    fake = createRepoDb();
    h.db = fake.db;
    h.add.mockReset();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (storedRoot === undefined) delete process.env.REPO_STORAGE_ROOT;
    else process.env.REPO_STORAGE_ROOT = storedRoot;
    await rm(storage, { recursive: true, force: true });
  });

  const upload = async (bytes: Buffer): Promise<{ status: number; error: unknown }> => {
    const form = new FormData();
    form.set('archive', new File([new Uint8Array(bytes)], 'a.zip'));
    const res = await app.request('/upload', { method: 'POST', body: form });
    const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
    return { status: res.status, error: body?.error };
  };

  const enospc = (): Error =>
    Object.assign(new Error('ENOSPC: no space left on device, write'), {
      code: 'ENOSPC',
      errno: -28,
      syscall: 'write',
    });

  /** Whatever the failed upload left in the user's staging dir, by entry name. */
  const staged = async (): Promise<string[]> => (await readdir(uploads)).sort();

  it('D3 keeps a different file put at the archive’s name when the upload fails', async () => {
    const other = path.join(storage, 'other.zip');
    // The very bytes that reach the archive before the write fails, so nothing but the inode tells it apart.
    const landed = ARCHIVE.subarray(0, Math.floor(ARCHIVE.length / 2));
    await writeFile(other, landed, { mode: 0o600 });
    const before = await lstat(other);
    const fault = failTheWriteOf(ARCHIVE, enospc(), async () => {
      const [archive] = await readdir(uploads);
      await rename(other, path.join(uploads, archive!));
    });

    const res = await upload(ARCHIVE);

    expect(fault.fired, 'the archive’s bytes reached FileHandle.prototype.write and failed').toBe(
      1,
    );
    expect(res.status, `the upload fails (${String(res.error)})`).toBe(500);
    expect(fake.rows(schema.repositories), 'the repository row is taken back').toEqual([]);
    const names = await staged();
    expect(names, 'the other file is still at the archive’s name (it was removed)').toHaveLength(1);
    const stands = path.join(uploads, names[0]!);
    expect(await readFile(stands), 'it holds the other file’s bytes').toEqual(landed);
    expect((await lstat(stands)).ino, 'it is the other file’s inode').toBe(before.ino);
  });

  /** What the staging dir held the first time the descriptor whose identity the route read was
   *  closed: a removal judged on the inode is only pinned while that descriptor is open. The
   *  handle is caught where its identity is read (the one `stat({ bigint: true })`), and `close`
   *  is wrapped on it, since a FileHandle carries `close` as its own property. */
  const watchFirstClose = (): { caught: boolean; held: string[] | null } => {
    const seen = { caught: false, held: null as string[] | null };
    proto.stat = async function (this: FileHandle, opts?: { bigint?: boolean }) {
      if (opts?.bigint === true && !seen.caught) {
        seen.caught = true;
        const close = this.close;
        this.close = async () => {
          seen.held ??= readdirSync(uploads).sort();
          return close.call(this);
        };
      }
      return realStat.call(this, opts);
    };
    return seen;
  };

  it('removes the partial archive while the descriptor it wrote through is still open', async () => {
    failTheWriteOf(ARCHIVE, enospc());
    const seen = watchFirstClose();

    const res = await upload(ARCHIVE);

    expect(res.status, `the upload fails (${String(res.error)})`).toBe(500);
    expect(seen.caught, 'the route read the identity of the file it created').toBe(true);
    expect(seen.held, 'the archive was gone before its descriptor first closed').toEqual([]);
  });

  it('D3 pin: removes the partial archive when the upload fails', async () => {
    const fault = failTheWriteOf(ARCHIVE, enospc());

    const res = await upload(ARCHIVE);

    expect(fault.fired, 'the archive’s bytes reached FileHandle.prototype.write and failed').toBe(
      1,
    );
    expect(res.status, `the upload fails (${String(res.error)})`).toBe(500);
    expect(fake.rows(schema.repositories), 'the repository row is taken back').toEqual([]);
    expect(await staged(), 'the partial archive is removed').toEqual([]);
  });
});
