import type { Stats } from 'node:fs';
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
  type FileHandle,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { openFileNoFollow, updateFileNoFollow, writeFileNoFollow } from '../src/fs-safe.js';

// Two primitives write into a file they have just created: `writeFileNoFollow` in create-exclusive
// mode and `updateFileNoFollow` with `create: true`. A write that fails part-way while the process
// lives (ENOSPC, EIO) must not leave the half-written file at its name, where a later
// create-exclusive refuses it (EEXIST) and a later update reads it as the file's content and
// appends to it. Taking it back is judged on the bytes removed, so a file put at the name
// meanwhile is kept. The same holds for every other step that fails once the file exists: the
// fsync of a durable write, and the `chmod` that finishes creating it.
//
// The failure is injected at `FileHandle.prototype.write`, chosen by the BYTES written, as in
// fs-safe-write-failure.test.ts; the later steps at `FileHandle.prototype.sync` and `.chmod`. A
// removal that fails too is injected at `FileHandle.prototype.read`, which judging the bytes of
// the parked file reaches. `fh.writeFile`, `fh.writev` and path-based calls never reach any of them.

const REL = 'src/new.txt';
const NAME = 'new.txt';
const SETTLES_MS = 5_000;
// The mode the caller asks for, so a file that comes back with the default 0644 is a different file.
const FILE_MODE = 0o640;
// Half of it lands before the failure: a prefix of what the call was writing, which is what makes
// removing it legitimate.
const NEXT = `# created\n${'a line the failed write never finishes\n'.repeat(8)}`;
// Not a prefix of NEXT and shorter than the half of it that lands, so a judge on length alone would
// take it for the call's own leftover.
const PERSON = 'someone else saved this\n';

interface Creator {
  name: string;
  create: (root: string, rel: string, text: string) => Promise<string>;
}

// The update appends to what it finds, as the AGENTS.md and KB callers do, so a leftover shows.
const CREATORS: Creator[] = [
  {
    name: 'writeFileNoFollow create-exclusive',
    create: (root, rel, text) =>
      writeFileNoFollow(root, rel, text, { mode: 'create-exclusive', fileMode: FILE_MODE }),
  },
  {
    name: 'updateFileNoFollow create:true',
    create: (root, rel, text) =>
      updateFileNoFollow(root, rel, (current) => `${current ?? ''}${text}`, {
        create: true,
        fileMode: FILE_MODE,
      }),
  },
];

// Every way in to the one function that creates the file: both writers above and the plain open the
// api routes stream their uploads through.
const ENTRIES: Creator[] = [
  ...CREATORS,
  {
    name: 'openFileNoFollow create-exclusive',
    create: async (root, rel) => {
      const fh = await openFileNoFollow(root, rel, 'create-exclusive', { fileMode: FILE_MODE });
      await fh.close();
      return 'created';
    },
  },
];

interface WriteFault {
  content: Buffer;
  error: Error;
  /** Runs once the first half has landed and before the error is thrown. */
  beforeThrow?: () => Promise<void>;
  fired: number;
}

interface ReadFault {
  /** Thrown by every read, once `beforeRead` has run. Without it reads go through. */
  error?: Error;
  /** Runs once, before the first read. */
  beforeRead?: () => Promise<void>;
  fired: number;
}

interface StepFault {
  error: Error;
  /** Runs before the error is thrown. */
  beforeThrow?: () => Promise<void>;
  fired: number;
}

const fsError = (code: 'ENOSPC' | 'EIO', text: string, syscall = 'write'): Error =>
  Object.assign(new Error(`${code}: ${text}, ${syscall}`), {
    code,
    errno: code === 'ENOSPC' ? -28 : -5,
    syscall,
  });

const writeFault = (error: Error, beforeThrow?: () => Promise<void>): WriteFault => ({
  content: Buffer.from(NEXT, 'utf8'),
  error,
  beforeThrow,
  fired: 0,
});

type Method = (this: FileHandle, ...args: unknown[]) => Promise<unknown>;
type Patched = 'write' | 'read' | 'chmod' | 'sync';
const PATCHED: Patched[] = ['write', 'read', 'chmod', 'sync'];

let proto: Record<Patched, unknown>;
let real: Record<Patched, Method>;

beforeAll(async () => {
  const probe = await open(fileURLToPath(import.meta.url), 'r');
  proto = Object.getPrototypeOf(probe) as Record<Patched, unknown>;
  real = {
    write: proto.write as Method,
    read: proto.read as Method,
    chmod: proto.chmod as Method,
    sync: proto.sync as Method,
  };
  await probe.close();
});

function disarm(): void {
  for (const name of PATCHED) proto[name] = real[name];
}

afterEach(disarm);

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

/** A write of a fault's `content` lands its first half, runs the fault's hook and then throws;
 *  every other write goes through untouched. */
function armWrite(...faults: WriteFault[]): void {
  proto.write = async function (this: FileHandle, ...args: unknown[]) {
    const { chunk, position } = bytesOf(args);
    const fault = faults.find((f) => carries(f.content, chunk, position));
    if (fault === undefined) return real.write.apply(this, args);
    fault.fired += 1;
    await real.write.call(this, chunk, 0, Math.max(1, Math.floor(chunk.length / 2)), position);
    await fault.beforeThrow?.();
    throw fault.error;
  };
}

/** The step that finishes creating the file (`chmod`) or makes a durable write durable (`sync`)
 *  fails, after the file exists and, for `sync`, after every byte is written. */
function armStep(name: 'chmod' | 'sync', fault: StepFault): void {
  proto[name] = async function () {
    fault.fired += 1;
    await fault.beforeThrow?.();
    throw fault.error;
  };
}

/** Reads through a file handle are what judging the bytes of a parked file does first. */
function armRead(fault: ReadFault): void {
  proto.read = async function (this: FileHandle, ...args: unknown[]) {
    fault.fired += 1;
    const hook = fault.beforeRead;
    fault.beforeRead = undefined;
    await hook?.();
    if (fault.error !== undefined) throw fault.error;
    return real.read.apply(this, args);
  };
}

async function rejection(call: Promise<unknown>): Promise<unknown> {
  try {
    await call;
  } catch (err) {
    return err;
  }
  throw new Error('expected the call to reject, and it resolved');
}

const label = (e: unknown): string =>
  e instanceof Error ? `${e.name}${'code' in e ? ` ${String(e.code)}` : ''}` : String(e);

/** Every error reachable from `err`, wherever it is attached: `cause`, an AggregateError's `errors`
 *  or any other own property holding an Error or a list of them. */
function failuresIn(err: unknown): unknown[] {
  const seen = new Set<unknown>();
  const walk = (e: unknown): void => {
    if (seen.has(e) || typeof e !== 'object' || e === null) return;
    seen.add(e);
    for (const key of Reflect.ownKeys(e)) {
      const value = (e as Record<PropertyKey, unknown>)[key];
      if (value instanceof Error) walk(value);
      else if (Array.isArray(value)) value.filter((v) => v instanceof Error).forEach(walk);
    }
  };
  walk(err);
  return [...seen];
}

describe('a create that fails part-way', () => {
  let root: string;
  let dir: string;
  let file: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'fs-safe-cf-'));
    dir = path.join(root, 'src');
    file = path.join(root, REL);
    await mkdir(dir);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function whatIsIn(where: string): Promise<string> {
    const names = await readdir(where);
    const found = await Promise.all(
      names.map(async (n) => `${n} (${(await lstat(path.join(where, n))).size} bytes)`),
    );
    return found.length === 0 ? 'nothing' : found.join(', ');
  }

  /** The file another party put at the name is still there, byte for byte and inode for inode. */
  async function expectOtherFileStands(before: Stats): Promise<void> {
    const after = await lstat(file).catch(() => null);
    expect(after?.isFile(), 'the other file is still at the name (it was removed)').toBe(true);
    expect(await readFile(file, 'utf8'), 'it holds the other file’s bytes').toBe(PERSON);
    expect(after?.ino, 'it is the other file’s inode').toBe(before.ino);
    expect((after?.mode ?? 0) & 0o777, 'it keeps the other file’s mode').toBe(before.mode & 0o777);
    expect(await readdir(dir), `nothing else is beside it (found: ${await whatIsIn(dir)})`).toEqual(
      [NAME],
    );
  }

  it.each(CREATORS)(
    'C1 $name leaves nothing at the name when the write fails part-way',
    async (c) => {
      const enospc = fsError('ENOSPC', 'no space left on device');
      const fault = writeFault(enospc);
      armWrite(fault);

      const err = await rejection(c.create(root, REL, NEXT));

      expect(
        fault.fired,
        'the new bytes reached FileHandle.prototype.write and failed',
      ).toBeGreaterThan(0);
      expect(err, 'the call rejects with the failed write’s own error').toBe(enospc);
      expect(
        await readdir(dir),
        `nothing is left at the name or beside it (found: ${await whatIsIn(dir)})`,
      ).toEqual([]);
    },
  );

  it.each(CREATORS)('C1b $name creates exactly its own bytes when it is retried', async (c) => {
    armWrite(writeFault(fsError('ENOSPC', 'no space left on device')));
    await rejection(c.create(root, REL, NEXT));
    disarm();

    const retry = await c.create(root, REL, NEXT).catch((e: unknown) => `refused: ${label(e)}`);

    expect(retry, 'the retry creates the file').toBe('created');
    expect(await readFile(file, 'utf8'), 'the file holds the bytes once').toBe(NEXT);
    expect(await readdir(dir)).toEqual([NAME]);
  });

  it('C1c writeFileNoFollow create-exclusive durable leaves nothing at the name when the fsync fails', async () => {
    const eio = fsError('EIO', 'input/output error', 'fsync');
    const fault: StepFault = { error: eio, fired: 0 };
    armStep('sync', fault);

    const err = await rejection(
      writeFileNoFollow(root, REL, NEXT, {
        mode: 'create-exclusive',
        fileMode: FILE_MODE,
        durable: true,
      }),
    );
    disarm();

    expect(
      fault.fired,
      'the durable write reached FileHandle.prototype.sync and failed',
    ).toBeGreaterThan(0);
    expect(err, 'the call rejects with the failed fsync’s own error').toBe(eio);
    expect(
      await readdir(dir),
      `nothing is left at the name or beside it (found: ${await whatIsIn(dir)})`,
    ).toEqual([]);
  });

  it.each(CREATORS)(
    'C2 $name reads both failures when removing what it created fails too',
    { timeout: SETTLES_MS },
    async (c) => {
      const enospc = fsError('ENOSPC', 'no space left on device');
      const eio = fsError('EIO', 'input/output error');
      const reads: ReadFault = { error: eio, fired: 0 };
      armWrite(writeFault(enospc));
      armRead(reads);

      const found = failuresIn(await rejection(c.create(root, REL, NEXT)));
      disarm();
      const readable = `readable from the rejection: ${found.map(label).join(', ')} (reads of the leftover: ${reads.fired})`;

      expect(found, `the failed write (ENOSPC) is ${readable}`).toContain(enospc);
      expect(found, `the failed removal (EIO) is ${readable}`).toContain(eio);
    },
  );

  it.each(CREATORS)(
    'C3 $name keeps a different file put at the name before the removal',
    async (c) => {
      const other = path.join(root, 'other.txt');
      await writeFile(other, PERSON, { encoding: 'utf8', mode: 0o600 });
      const before = await lstat(other);
      const enospc = fsError('ENOSPC', 'no space left on device');
      // Replaces the entry the call created, so the name is taken by an inode that is not its own.
      armWrite(writeFault(enospc, () => rename(other, file)));

      const err = await rejection(c.create(root, REL, NEXT));

      expect(err, 'the call rejects with the failed write’s own error').toBe(enospc);
      await expectOtherFileStands(before);
    },
  );

  it('C3c writeFileNoFollow create-exclusive durable keeps a different file put at the name when the fsync fails', async () => {
    const other = path.join(root, 'other.txt');
    await writeFile(other, PERSON, { encoding: 'utf8', mode: 0o600 });
    const before = await lstat(other);
    const eio = fsError('EIO', 'input/output error', 'fsync');
    // Replaces the entry the call created, so the name is taken by an inode that is not its own.
    armStep('sync', { error: eio, beforeThrow: () => rename(other, file), fired: 0 });

    const err = await rejection(
      writeFileNoFollow(root, REL, NEXT, {
        mode: 'create-exclusive',
        fileMode: FILE_MODE,
        durable: true,
      }),
    );
    disarm();

    expect(err, 'the call rejects with the failed fsync’s own error').toBe(eio);
    await expectOtherFileStands(before);
  });

  it.each(CREATORS)(
    'C3b $name never takes a file saved at the name while its leftover is judged',
    async (c) => {
      const enospc = fsError('ENOSPC', 'no space left on device');
      // The first read of the leftover is the judging of its bytes. By then the leftover is no
      // longer at the name, so a file saved there now is not the call's.
      const judged: ReadFault = { beforeRead: () => writeFile(file, PERSON, 'utf8'), fired: 0 };
      armWrite(writeFault(enospc));
      armRead(judged);

      const err = await rejection(c.create(root, REL, NEXT));
      disarm();

      expect(err, 'the call rejects with the failed write’s own error').toBe(enospc);
      expect(
        judged.fired,
        'the leftover was read, under a private name, before anything was removed',
      ).toBeGreaterThan(0);
      const stands = await readFile(file, 'utf8').catch((e: unknown) => `unreadable: ${label(e)}`);
      expect(stands, 'the file saved meanwhile stands').toBe(PERSON);
      expect(
        await readdir(dir),
        `nothing else is beside it (found: ${await whatIsIn(dir)})`,
      ).toEqual([NAME]);
    },
  );

  it.each(CREATORS)('C4 $name still creates the file with its bytes and mode', async (c) => {
    armWrite({
      content: Buffer.from('bytes no write carries', 'utf8'),
      error: fsError('EIO', 'unused'),
      fired: 0,
    });

    expect(await c.create(root, REL, NEXT)).toBe('created');

    const st = await lstat(file).catch(() => null);
    expect(st?.isFile(), 'the file is at its name').toBe(true);
    expect(await readFile(file, 'utf8'), 'the file holds its bytes').toBe(NEXT);
    expect((st?.mode ?? 0) & 0o777, 'the file has the mode it was asked for').toBe(FILE_MODE);
    expect(await readdir(dir), 'nothing is beside it').toEqual([NAME]);
  });

  // A prefix of what the call would write: even a judge on the bytes would accept it, so only
  // scoping the removal to a file the call created keeps it.
  const MINE = NEXT.slice(0, 40);

  it('C4b writeFileNoFollow create-exclusive refuses what is at the name and leaves it', async () => {
    await writeFile(file, MINE, { encoding: 'utf8', mode: 0o600 });
    const before = await lstat(file);

    await expect(
      writeFileNoFollow(root, REL, NEXT, { mode: 'create-exclusive' }),
    ).rejects.toMatchObject({ code: 'EEXIST' });

    const after = await lstat(file);
    expect(await readFile(file, 'utf8'), 'the file keeps its bytes').toBe(MINE);
    expect(after.ino, 'the file is the same inode').toBe(before.ino);
    expect(await readdir(dir)).toEqual([NAME]);
  });

  it('C4b updateFileNoFollow create:true refuses a file that appears before its own create', async () => {
    let before: Stats | undefined;
    const call = updateFileNoFollow(
      root,
      REL,
      async () => {
        await writeFile(file, MINE, { encoding: 'utf8', mode: 0o600 });
        before = await lstat(file);
        return NEXT;
      },
      { create: true },
    );

    await expect(call).rejects.toMatchObject({ code: 'EEXIST' });

    const after = await lstat(file);
    expect(await readFile(file, 'utf8'), 'the file keeps its bytes').toBe(MINE);
    expect(after.ino, 'the file is the same inode').toBe(before?.ino);
    expect(await readdir(dir)).toEqual([NAME]);
  });

  // The create itself leaves an empty file and then finishes it (a held-path check, `chmod`,
  // `chown`). A step failing in between takes the file back before a byte was written into it, so
  // what it may remove is a file holding no bytes.
  it.each(ENTRIES)(
    'C9 $name keeps a different file put at the name when a step after the create fails',
    async (c) => {
      const other = path.join(root, 'other.txt');
      await writeFile(other, PERSON, { encoding: 'utf8', mode: 0o600 });
      const before = await lstat(other);
      const eio = fsError('EIO', 'input/output error', 'fchmod');
      // Replaces the entry the call created, so the name is taken by an inode that is not its own.
      const fault: StepFault = { error: eio, beforeThrow: () => rename(other, file), fired: 0 };
      armStep('chmod', fault);

      const err = await rejection(c.create(root, REL, NEXT));
      disarm();

      expect(fault.fired, 'the step after the create was reached and failed').toBeGreaterThan(0);
      expect(err, 'the call rejects with the failed step’s own error').toBe(eio);
      await expectOtherFileStands(before);
    },
  );

  it.each(ENTRIES)(
    'C9 pin: $name still removes the empty file it created when a step after the create fails',
    async (c) => {
      const eio = fsError('EIO', 'input/output error', 'fchmod');
      const fault: StepFault = { error: eio, fired: 0 };
      armStep('chmod', fault);

      const err = await rejection(c.create(root, REL, NEXT));
      disarm();

      expect(fault.fired, 'the step after the create was reached and failed').toBeGreaterThan(0);
      expect(err, 'the call rejects with the failed step’s own error').toBe(eio);
      expect(
        await readdir(dir),
        `the empty file it created is removed (found: ${await whatIsIn(dir)})`,
      ).toEqual([]);
    },
  );
});
