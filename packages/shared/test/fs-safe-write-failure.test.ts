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
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { rewriteFileIfNoFollow, updateFileNoFollow, writeFileNoFollow } from '../src/fs-safe.js';

// Three primitives rewrite a file on its own inode: truncate, then write. A write that fails
// part-way while the process lives (ENOSPC, EIO) has to leave the file's original bytes on that
// inode and rethrow. A crash mid-write is the documented trade for keeping the inode, not covered.
//
// The failure is injected at `FileHandle.prototype.write`, which `writeAll` reaches from all three,
// and chosen by the BYTES written: `updateFileNoFollow` builds its own Buffer, so identity cannot
// match. `fh.writeFile`, `fh.writev` and path-based calls never reach it.

const REL = 'src/a.txt';
const SETTLES_MS = 5_000;
// The 0xff is not UTF-8, so a put-back made from decoded text instead of the bytes read would not
// match. `updateFileNoFollow` refuses such a file before writing, so its original is UTF-8.
const ORIGINAL = Buffer.from(
  '# original\n\xff these bytes must survive a failed write\n',
  'latin1',
);
const ORIGINAL_UTF8 = Buffer.from(
  '# original\n\u00fe these bytes must survive a failed write\n',
  'utf8',
);
// Half of it is longer than ORIGINAL, so a put-back that forgets to truncate leaves a tail behind.
const NEXT = `# replaced\n${'a line the failed write never finishes\n'.repeat(8)}`;

interface Fault {
  content: Buffer;
  error: Error;
}

interface Primitive {
  control: 'C1' | 'C2' | 'C3';
  name: string;
  ok: string;
  original: Buffer;
  write: (root: string, rel: string, next: string) => Promise<string>;
}

const PRIMITIVES: Primitive[] = [
  {
    control: 'C1',
    name: 'rewriteFileIfNoFollow',
    ok: 'rewritten',
    original: ORIGINAL,
    write: (root, rel, next) => rewriteFileIfNoFollow(root, rel, () => Buffer.from(next, 'utf8')),
  },
  {
    control: 'C2',
    name: 'updateFileNoFollow',
    ok: 'updated',
    original: ORIGINAL_UTF8,
    write: (root, rel, next) => updateFileNoFollow(root, rel, () => next),
  },
  {
    control: 'C3',
    name: 'writeFileNoFollow overwrite-in-place',
    ok: 'overwritten',
    original: ORIGINAL,
    write: (root, rel, next) => writeFileNoFollow(root, rel, next, { mode: 'overwrite-in-place' }),
  },
];

const fsError = (code: 'ENOSPC' | 'EIO', text: string): Error =>
  Object.assign(new Error(`${code}: ${text}, write`), {
    code,
    errno: code === 'ENOSPC' ? -28 : -5,
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

/** The bytes a `write(buffer, offset, length, position)` call asks for, and where. Any other call
 *  shape throws, since a write the harness cannot read is one it cannot match. */
function bytesOf(args: unknown[]): { chunk: Buffer; position: number | null } {
  const [data, offset, length, position] = args;
  if (!ArrayBuffer.isView(data) || typeof offset !== 'number' || typeof length !== 'number') {
    throw new Error('fault injection reads only write(buffer, offset, length, position)');
  }
  const bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  return {
    chunk: bytes.subarray(offset, offset + length),
    position: typeof position === 'number' ? position : null,
  };
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
    await realWrite.call(this, chunk, 0, Math.max(1, Math.floor(chunk.length / 2)), position);
    throw fault.error;
  };
}

async function rejection(call: Promise<unknown>): Promise<unknown> {
  try {
    await call;
  } catch (err) {
    return err;
  }
  throw new Error('expected the write to reject, and it resolved');
}

const label = (e: unknown): string =>
  e instanceof Error ? `${e.name}${'code' in e ? ` ${String(e.code)}` : ''}` : String(e);

/** Every error reachable from `err` through `cause` and `errors`. */
function failuresIn(err: unknown): unknown[] {
  const seen = new Set<unknown>();
  const walk = (e: unknown): void => {
    if (seen.has(e)) return;
    seen.add(e);
    if (typeof e !== 'object' || e === null) return;
    const { cause, errors } = e as { cause?: unknown; errors?: unknown };
    if (cause !== undefined) walk(cause);
    if (Array.isArray(errors)) errors.forEach(walk);
  };
  walk(err);
  return [...seen];
}

describe('a write that fails part-way', () => {
  let root: string;
  let file: string;
  let before: Stats;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'fs-safe-wf-'));
    await mkdir(path.join(root, 'src'));
    file = path.join(root, REL);
    await writeFile(file, ORIGINAL);
    await chmod(file, 0o640);
    before = await lstat(file);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const seed = (p: Primitive) => writeFile(file, p.original);

  async function expectOnItsInode(bytes: Buffer, which: 'original' | 'new'): Promise<void> {
    const after = await lstat(file);
    expect(after.isFile(), 'the file is at its name').toBe(true);
    const found = await readFile(file, 'latin1');
    expect(
      found,
      `the file holds its ${which} bytes (${found.length} found, ${bytes.length} expected)`,
    ).toBe(bytes.toString('latin1'));
    expect(after.ino, 'the file is the same inode').toBe(before.ino);
    expect(after.mode & 0o777, 'the file keeps its mode').toBe(before.mode & 0o777);
    expect(
      await readdir(path.dirname(file)),
      'nothing is left beside it (no .haive-park- or temp entry)',
    ).toEqual(['a.txt']);
  }

  it.each(PRIMITIVES)(
    '$control $name puts the original bytes back on the same inode',
    async (p) => {
      await seed(p);
      const enospc = fsError('ENOSPC', 'no space left on device');
      arm({ content: Buffer.from(NEXT, 'utf8'), error: enospc });

      const err = await rejection(p.write(root, REL, NEXT));

      expect(err, 'the call rejects with the failed write’s own error').toBe(enospc);
      await expectOnItsInode(p.original, 'original');
    },
  );

  it.each(PRIMITIVES)(
    'C4 $name reads both failures when putting the bytes back fails too',
    { timeout: SETTLES_MS },
    async (p) => {
      await seed(p);
      const enospc = fsError('ENOSPC', 'no space left on device');
      const eio = fsError('EIO', 'input/output error');
      arm(
        { content: Buffer.from(NEXT, 'utf8'), error: enospc },
        { content: p.original, error: eio },
      );

      const found = failuresIn(await rejection(p.write(root, REL, NEXT)));
      const readable = `readable from the rejection: ${found.map(label).join(', ')}`;

      expect(found, `the failed write (ENOSPC) is ${readable}`).toContain(enospc);
      expect(found, `the failed put-back (EIO) is ${readable}`).toContain(eio);
    },
  );

  it.each(PRIMITIVES)('C5 $name still writes the new bytes on the same inode', async (p) => {
    await seed(p);
    arm({
      content: Buffer.from('bytes no write carries', 'utf8'),
      error: fsError('EIO', 'unused'),
    });

    expect(await p.write(root, REL, NEXT)).toBe(p.ok);

    await expectOnItsInode(Buffer.from(NEXT, 'utf8'), 'new');
  });
});
