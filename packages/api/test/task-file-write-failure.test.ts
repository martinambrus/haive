import { createHash } from 'node:crypto';
import type { Stats } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rm,
  writeFile,
  type FileHandle,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { state } = vi.hoisted(() => ({
  state: {
    task: {} as Record<string, unknown>,
    repo: null as Record<string, unknown> | null,
  },
}));

vi.mock('../src/db.js', () => ({
  getDb: () => ({
    query: {
      tasks: { findFirst: async () => state.task },
      repositories: { findFirst: async () => state.repo },
      taskSteps: { findFirst: async () => undefined },
    },
  }),
}));

import { Hono } from 'hono';
import { logger } from '@haive/shared';
import { KB_DIR } from '@haive/shared/knowledge-paths';
import { fileRoutes } from '../src/routes/tasks/files.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';

const TASK = 'task-1';
const USER = 'user-1';
const SETTLES_MS = 5_000;

// The knowledge editor truncates the file and then writes the body, so a write that fails part-way
// while the process lives (ENOSPC, EIO) must leave the file's original bytes on its inode and answer
// a failure. A crash mid-write is not covered.
//
// The failure is injected at `FileHandle.prototype.write`, chosen by the BYTES written and in both
// shapes the route could use, `write(string, position, encoding)` and `write(buffer, offset, length,
// position)`. `fh.writeFile`, `fh.writev` and path-based calls never reach it.

const app = new Hono<AppEnv>();
app.use('*', async (c, next) => {
  c.set('userId', USER);
  await next();
});
app.route('/', fileRoutes);
app.onError(errorHandler);

const put = async (body: Record<string, unknown>): Promise<Response> =>
  await app.request(`/${TASK}/files/content`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

// The route hashes the DECODED text, so a file with a byte that is not UTF-8 is hashed with U+FFFD
// in its place, and that is the sha a client holds.
const routeSha = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

// The 0xff is not UTF-8: a put-back made from the text the route decoded would not be these bytes.
const ORIGINAL = Buffer.from('# knowledge\n\xff must survive a failed save\n', 'latin1');
const ORIGINAL_SHA = routeSha(ORIGINAL.toString('utf8'));
// Half of it is longer than ORIGINAL, so a put-back that forgets to truncate leaves a tail behind.
const NEXT = `# edited\n${'a line the failed save never finishes\n'.repeat(8)}`;

interface Fault {
  content: Buffer;
  error: Error;
  fired: number;
}

const enospcError = (text: string): Error =>
  Object.assign(new Error(`ENOSPC: ${text}, write`), {
    code: 'ENOSPC',
    errno: -28,
    syscall: 'write',
  });

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

/** The bytes a `write(string, position, encoding)` or `write(buffer, offset, length, position)`
 *  call asks for, and where. Any other call shape throws, since a write the harness cannot read is
 *  one it cannot match. */
function bytesOf(args: unknown[]): { chunk: Buffer; position: number | null } {
  const [data, a, b, c] = args;
  if (typeof data === 'string') {
    const encoding = typeof b === 'string' ? (b as BufferEncoding) : 'utf8';
    return { chunk: Buffer.from(data, encoding), position: typeof a === 'number' ? a : null };
  }
  if (ArrayBuffer.isView(data) && (a === undefined || typeof a === 'number')) {
    const bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    const offset = typeof a === 'number' ? a : 0;
    const length = typeof b === 'number' ? b : bytes.length - offset;
    return {
      chunk: bytes.subarray(offset, offset + length),
      position: typeof c === 'number' ? c : null,
    };
  }
  throw new Error('fault injection reads only write(string, ...) and write(buffer, offset, ...)');
}

const carries = (content: Buffer, chunk: Buffer, position: number | null): boolean =>
  chunk.length > 0 &&
  (position === null
    ? content.includes(chunk)
    : content.subarray(position, position + chunk.length).equals(chunk));

/** A write of a fault's `content` lands its first half and then throws; every other write goes
 *  through untouched. */
function arm(...faults: Fault[]): void {
  proto.write = async function (this: FileHandle, ...args: unknown[]) {
    const { chunk, position } = bytesOf(args);
    const fault = faults.find((f) => carries(f.content, chunk, position));
    if (fault === undefined) return realWrite.apply(this, args);
    fault.fired += 1;
    await realWrite.call(this, chunk, 0, Math.max(1, Math.floor(chunk.length / 2)), position);
    throw fault.error;
  };
}

describe('PUT /files/content when the write fails part-way', () => {
  let storage: string;
  let dir: string;
  let file: string;
  let before: Stats;

  beforeEach(async () => {
    vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    storage = await mkdtemp(path.join(tmpdir(), 'files-wf-'));
    const repo = path.join(storage, USER, 'repo-1');
    const worktree = path.join(repo, '.haive', 'worktrees', 'wt');
    dir = path.join(worktree, KB_DIR);
    file = path.join(dir, 'a.md');
    await mkdir(dir, { recursive: true });
    await writeFile(file, ORIGINAL);
    await chmod(file, 0o640);
    before = await lstat(file);

    state.task = {
      id: TASK,
      userId: USER,
      repositoryId: 'repo-1',
      worktreePath: worktree,
      type: 'workflow',
      metadata: {},
    };
    state.repo = { storagePath: repo, localPath: null, source: 'clone', writable: true };
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(storage, { recursive: true, force: true });
  });

  async function expectOnItsInode(bytes: Buffer, which: 'original' | 'new'): Promise<void> {
    const after = await lstat(file);
    expect(after.isFile(), 'the file is at its name').toBe(true);
    const found = await readFile(file, 'latin1');
    expect(
      found,
      `the file holds its ${which} bytes (${found.length} found, ${bytes.length} expected)`,
    ).toBe(bytes.toString('latin1'));
    expect(after.ino, 'the file is the same inode').toBe(before.ino);
    expect(await readdir(dir), 'nothing else is left beside it').toEqual(['a.md']);
  }

  it(
    'C6 answers a failure and leaves the original bytes on the same inode',
    { timeout: SETTLES_MS },
    async () => {
      const enospc: Fault = {
        content: Buffer.from(NEXT, 'utf8'),
        error: enospcError('no space left on device'),
        fired: 0,
      };
      arm(enospc);

      const res = await put({ path: file, content: NEXT, expectedSha: ORIGINAL_SHA });

      expect(
        enospc.fired,
        'the new bytes reached FileHandle.prototype.write and failed',
      ).toBeGreaterThan(0);
      expect(res.status, 'the response is a failure, not a 2xx').toBeGreaterThanOrEqual(500);
      await expectOnItsInode(ORIGINAL, 'original');
    },
  );

  it('C6 pin: a normal PUT still writes the new bytes on the same inode', async () => {
    arm({
      content: Buffer.from('bytes no write carries', 'utf8'),
      error: enospcError('unused'),
      fired: 0,
    });

    const res = await put({ path: file, content: NEXT, expectedSha: ORIGINAL_SHA });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      sha: routeSha(NEXT),
      size: Buffer.byteLength(NEXT, 'utf8'),
    });
    await expectOnItsInode(Buffer.from(NEXT, 'utf8'), 'new');
  });

  it('C6 pin: a stale expectedSha still answers 409 and leaves the file untouched', async () => {
    const res = await put({ path: file, content: NEXT, expectedSha: routeSha('another version') });

    expect(res.status).toBe(409);
    await expectOnItsInode(ORIGINAL, 'original');
  });
});
