import { createHash } from 'node:crypto';
import type { Stats } from 'node:fs';
import {
  appendFile,
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
import { KB_DIR } from '@haive/shared/knowledge-paths';
import { fileRoutes } from '../src/routes/tasks/files.js';
import { MAX_FILE_CONTENT_BYTES } from '../src/routes/tasks/_helpers.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';

const TASK = 'task-1';
const USER = 'user-1';
const TOO_LARGE = 'File is too large to edit here';

// The knowledge editor caps what it takes in (the body) and what it hands out (GET serves the first
// MAX_FILE_CONTENT_BYTES of a file), so a file over that cap is one the editor can only show cut
// short. Saving it has to be refused before the file is read, not after: the route reads the whole
// existing file (to compare its sha and to keep a copy to put back), and nothing else bounds that.
//
// "Not read" is measured at `FileHandle.prototype.readFile` and `.read`, the two ways the route or
// a bounded replacement could pull a file's bytes through the descriptor it holds. Path-based reads
// never reach them. A file the editor can still see as small can grow past the cap before the
// read (an agent in the sandbox writes this tree), so measuring it first is not enough and the read
// itself has to stop at the cap: `read` is summed, and a file grown after the measure is the C5b case.

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

// The route hashes the DECODED text, which is what the editor holds a sha of.
const routeSha = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/** `size` bytes of markdown-looking text, ending in a newline. */
const fileOf = (size: number): Buffer => Buffer.from(`${'x'.repeat(size - 1)}\n`, 'utf8');

const SMALL = '# a small edit\n';

type Method = (this: FileHandle, ...args: unknown[]) => Promise<unknown>;
type ReadMethod = 'readFile' | 'read';
const READ_METHODS: ReadMethod[] = ['readFile', 'read'];

let proto: Record<ReadMethod, unknown>;
let real: Record<ReadMethod, Method>;

beforeAll(async () => {
  const probe = await open(fileURLToPath(import.meta.url), 'r');
  proto = Object.getPrototypeOf(probe) as Record<ReadMethod, unknown>;
  real = {
    readFile: proto.readFile as Method,
    read: proto.read as Method,
  };
  await probe.close();
});

function unspy(): void {
  for (const name of READ_METHODS) proto[name] = real[name];
}

afterEach(unspy);

interface Reads {
  /** Every call through a file handle that pulls bytes out of it, by name, in order. */
  calls: ReadMethod[];
  /** What the `read` calls returned, summed. */
  bytes: number;
}

/** `beforeFirst` runs once, ahead of the first call: after the route has measured the file and
 *  before it reads it, which is where a file can still grow. */
function spyReads(beforeFirst?: () => Promise<void>): Reads {
  const reads: Reads = { calls: [], bytes: 0 };
  let hook = beforeFirst;
  for (const name of READ_METHODS) {
    proto[name] = async function (this: FileHandle, ...args: unknown[]) {
      reads.calls.push(name);
      const run = hook;
      hook = undefined;
      await run?.();
      const result = await real[name].apply(this, args);
      if (name === 'read') reads.bytes += (result as { bytesRead: number }).bytesRead;
      return result;
    };
  }
  return reads;
}

describe('PUT /files/content and the edit size cap', () => {
  let storage: string;
  let dir: string;
  let file: string;

  beforeEach(async () => {
    storage = await mkdtemp(path.join(tmpdir(), 'files-cap-'));
    const repo = path.join(storage, USER, 'repo-1');
    const worktree = path.join(repo, '.haive', 'worktrees', 'wt');
    dir = path.join(worktree, KB_DIR);
    file = path.join(dir, 'a.md');
    await mkdir(dir, { recursive: true });

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
    await rm(storage, { recursive: true, force: true });
  });

  /** Writes the file the editor is about to save over and remembers what it was. */
  async function seed(original: Buffer): Promise<{ original: Buffer; before: Stats }> {
    await writeFile(file, original);
    await chmod(file, 0o640);
    return { original, before: await lstat(file) };
  }

  async function expectUntouched(original: Buffer, before: Stats): Promise<void> {
    const after = await lstat(file);
    expect(after.isFile(), 'the file is at its name').toBe(true);
    expect(
      after.size,
      `the file keeps its size (${after.size} found, ${original.length} expected)`,
    ).toBe(original.length);
    expect((await readFile(file)).equals(original), 'the file holds its original bytes').toBe(true);
    expect(after.ino, 'the file is the same inode').toBe(before.ino);
    expect(after.mode & 0o777, 'the file keeps its mode').toBe(before.mode & 0o777);
    expect(await readdir(dir), 'nothing else is left beside it').toEqual(['a.md']);
  }

  // What the editor sends back is the sha of the capped view it loaded, so the first case is the
  // one a person reaches; the other two are a client that knows the whole file and one that sends
  // no sha at all (the editor sends none from a non-secure-context origin).
  const SHAS = [
    {
      name: 'the sha of the capped view',
      sha: (bytes: Buffer): string | undefined =>
        routeSha(bytes.subarray(0, MAX_FILE_CONTENT_BYTES).toString('utf8')),
    },
    {
      name: 'the sha of the whole file',
      sha: (bytes: Buffer): string | undefined => routeSha(bytes.toString('utf8')),
    },
    { name: 'no sha', sha: (): string | undefined => undefined },
  ];

  it.each(SHAS)(
    'C5 answers 413 for a file a byte over the cap ($name) and reads and writes nothing',
    async (s) => {
      const { original, before } = await seed(fileOf(MAX_FILE_CONTENT_BYTES + 1));
      const sha = s.sha(original);
      const reads = spyReads();

      const res = await put({ path: file, content: SMALL, ...(sha ? { expectedSha: sha } : {}) });
      const text = await res.text();
      unspy();

      expect(res.status, `the answer is 413 (it was ${res.status}: ${text.slice(0, 100)})`).toBe(
        413,
      );
      expect(JSON.parse(text), 'the answer is the one an over-long body gets').toMatchObject({
        error: TOO_LARGE,
      });
      expect(
        reads.calls,
        'no byte of the existing file was read through the held descriptor',
      ).toEqual([]);
      await expectUntouched(original, before);
    },
  );

  // The editor loaded a small file and saves over it, and by the time the route reads it the file
  // has grown to twice the cap. Neither sha can say so: the route has to stop reading at the cap.
  const LOADED = '# the version the editor loaded\n';
  const RACES = [
    { name: 'the sha of the version loaded', sha: routeSha(LOADED) },
    { name: 'no sha', sha: undefined },
  ];

  it.each(RACES)(
    'C5b answers 413 for a file that grows past the cap after it was measured ($name) and reads at most cap + 1 bytes',
    async (r) => {
      const { before } = await seed(Buffer.from(LOADED, 'utf8'));
      let grown = Buffer.alloc(0);
      let grownStat = before;
      const reads = spyReads(async () => {
        await appendFile(file, 'y'.repeat(2 * MAX_FILE_CONTENT_BYTES));
        grown = await readFile(file);
        grownStat = await lstat(file);
      });

      const res = await put({
        path: file,
        content: SMALL,
        ...(r.sha ? { expectedSha: r.sha } : {}),
      });
      const text = await res.text();
      unspy();

      expect(
        grown.length,
        'the file was grown past the cap just ahead of the route’s read (through FileHandle.prototype.read or .readFile)',
      ).toBeGreaterThan(MAX_FILE_CONTENT_BYTES);
      expect(res.status, `the answer is 413 (it was ${res.status}: ${text.slice(0, 100)})`).toBe(
        413,
      );
      expect(JSON.parse(text), 'the answer is the one an over-long body gets').toMatchObject({
        error: TOO_LARGE,
      });
      expect(reads.calls, 'the file was not read whole through readFile').not.toContain('readFile');
      expect(
        reads.bytes,
        `at most cap + 1 (${MAX_FILE_CONTENT_BYTES + 1}) bytes were read (read ${reads.bytes})`,
      ).toBeLessThanOrEqual(MAX_FILE_CONTENT_BYTES + 1);
      await expectUntouched(grown, grownStat);
    },
  );

  it('C6 still saves a file of exactly the cap', async () => {
    const { original, before } = await seed(fileOf(MAX_FILE_CONTENT_BYTES));

    const res = await put({
      path: file,
      content: SMALL,
      expectedSha: routeSha(original.toString('utf8')),
    });

    expect(res.status, `the answer is 200 (it was ${res.status})`).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      sha: routeSha(SMALL),
      size: Buffer.byteLength(SMALL, 'utf8'),
    });
    const after = await lstat(file);
    expect(await readFile(file, 'utf8'), 'the file holds the new bytes').toBe(SMALL);
    expect(after.ino, 'the file is the same inode').toBe(before.ino);
    expect(await readdir(dir)).toEqual(['a.md']);
  });

  it('C6 still answers 413 for a body over the cap, and leaves a small file alone', async () => {
    const { original, before } = await seed(Buffer.from('# small\n', 'utf8'));

    const res = await put({ path: file, content: 'x'.repeat(MAX_FILE_CONTENT_BYTES + 1) });

    expect(res.status).toBe(413);
    await expect(res.json()).resolves.toMatchObject({ error: TOO_LARGE });
    await expectUntouched(original, before);
  });
});
