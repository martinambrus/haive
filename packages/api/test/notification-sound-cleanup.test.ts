import { readdirSync, readlinkSync } from 'node:fs';
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
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
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { logger } from '@haive/shared';
import { userSettingsRoutes } from '../src/routes/user-settings.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';

// A sound whose write fails leaves what stands at its name as it was: the person's previous sound,
// or a file put there meanwhile. The write is failed at FileHandle.prototype.write by its bytes, as
// repo-upload-cleanup.test.ts does.

const app = new Hono<AppEnv>();
app.route('/', userSettingsRoutes);
app.onError(errorHandler);

const SOUND = Buffer.from(`ID3 ${'a sound that is written in two halves\n'.repeat(4)}`);
const PREVIOUS_SOUND = Buffer.from('ID3 the sound this person had before');
const OTHER = Buffer.from('a file somebody else saved at the sound’s name');

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

// The write lands its first half, runs `during` and fails; every other write goes through.
function failTheWriteOf(
  content: Buffer,
  error: Error,
  during?: (fh: FileHandle) => Promise<void>,
): { fired: number } {
  const seen = { fired: 0 };
  proto.write = async function (this: FileHandle, ...args: unknown[]) {
    const { chunk, position } = bytesOf(args);
    if (chunk.length === 0 || !content.includes(chunk)) return realWrite.apply(this, args);
    seen.fired += 1;
    await realWrite.call(this, chunk, 0, Math.max(1, Math.floor(chunk.length / 2)), position);
    await during?.(this);
    throw error;
  };
  return seen;
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

describe('POST /notifications/sound when the write fails', () => {
  let storage: string;
  let uploads: string;
  let soundPath: string;
  let fake: ReturnType<typeof createSoundDb>;
  let storedRoot: string | undefined;

  const createSoundDb = () =>
    createFakeDb({ userNotificationSettings: schema.userNotificationSettings });

  beforeEach(async () => {
    vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    storage = await mkdtemp(path.join(tmpdir(), 'notification-sound-'));
    const root = path.join(storage, 'repos');
    uploads = path.join(root, '_uploads', USER);
    await mkdir(uploads, { recursive: true });
    soundPath = path.join(uploads, 'notification-sound.mp3');
    storedRoot = process.env.REPO_STORAGE_ROOT;
    process.env.REPO_STORAGE_ROOT = root;
    fake = createSoundDb();
    h.db = fake.db;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (storedRoot === undefined) delete process.env.REPO_STORAGE_ROOT;
    else process.env.REPO_STORAGE_ROOT = storedRoot;
    await rm(storage, { recursive: true, force: true });
  });

  const upload = async (
    bytes: Buffer,
    name = 'chime.mp3',
    type = 'audio/mpeg',
  ): Promise<{ status: number; body: Record<string, unknown> | null; open: string[] }> => {
    const form = new FormData();
    form.set('sound', new File([new Uint8Array(bytes)], name, { type }));
    const res = await app.request('/notifications/sound', { method: 'POST', body: form });
    return {
      status: res.status,
      body: (await res.json().catch(() => null)) as never,
      open: openUnder(storage),
    };
  };

  const enospc = (): Error =>
    Object.assign(new Error('ENOSPC: no space left on device, write'), {
      code: 'ENOSPC',
      errno: -28,
      syscall: 'write',
    });

  const staged = async (): Promise<string[]> => (await readdir(uploads)).sort();

  // The person's sound as an earlier upload left it: the file, and the row that names it.
  async function seedSound(file: string, mime: string, filename: string) {
    await writeFile(file, PREVIOUS_SOUND, { mode: 0o644 });
    fake.insert(schema.userNotificationSettings, {
      userId: USER,
      soundPath: file,
      soundMime: mime,
      soundFilename: filename,
    });
    return lstat(file);
  }

  it('E3 keeps a different file put at the sound’s name when the write fails part-way', async () => {
    const other = path.join(storage, 'other.mp3');
    await writeFile(other, OTHER, { mode: 0o600 });
    const before = await lstat(other);
    const fault = failTheWriteOf(SOUND, enospc(), () => rename(other, soundPath));

    const res = await upload(SOUND);

    expect(fault.fired, 'the sound’s bytes reached FileHandle.prototype.write and failed').toBe(1);
    expect(res.status, `the upload fails (${String(res.body?.error)})`).toBe(500);
    expect(fake.rows(schema.userNotificationSettings), 'no sound is recorded').toEqual([]);
    const stands = await lstat(soundPath).catch(() => null);
    expect(
      stands?.isFile() ?? false,
      'the other file is still at the sound’s name (it was removed)',
    ).toBe(true);
    expect(await readFile(soundPath), 'it holds the other file’s bytes').toEqual(OTHER);
    expect(stands?.ino, 'it is the other file’s inode').toBe(before.ino);
    expect(await staged(), 'nothing else is beside it').toEqual(['notification-sound.mp3']);
  });

  it('E4 pin: removes the partial sound when the write fails', async () => {
    const fault = failTheWriteOf(SOUND, enospc());

    const res = await upload(SOUND);

    expect(fault.fired, 'the sound’s bytes reached FileHandle.prototype.write and failed').toBe(1);
    expect(res.status, `the upload fails (${String(res.body?.error)})`).toBe(500);
    expect(res.open.join(', '), 'no descriptor of the upload is left open').toBe('');
    expect(fake.rows(schema.userNotificationSettings), 'no sound is recorded').toEqual([]);
    expect(await staged(), 'the partial sound is removed').toEqual([]);
  });

  it('E4 pin: stores the sound and records it', async () => {
    const res = await upload(SOUND);

    expect(res.status, `the upload succeeds (${String(res.body?.error)})`).toBe(201);
    expect(res.open.join(', '), 'no descriptor of the upload is left open').toBe('');
    expect(res.body, 'the response says a custom sound is set').toMatchObject({
      hasCustomSound: true,
      soundFilename: 'chime.mp3',
    });
    expect(await readFile(soundPath), 'the sound is at its name').toEqual(SOUND);
    expect(await staged(), 'nothing else is beside it').toEqual(['notification-sound.mp3']);
    expect(fake.rows(schema.userNotificationSettings)).toMatchObject([
      { userId: USER, soundPath, soundMime: 'audio/mpeg', soundFilename: 'chime.mp3' },
    ]);
  });

  it('E4 pin: replaces the person’s previous sound at the same name', async () => {
    await seedSound(soundPath, 'audio/mpeg', 'before.mp3');

    const res = await upload(SOUND);

    expect(res.status, `the upload succeeds (${String(res.body?.error)})`).toBe(201);
    expect(await readFile(soundPath), 'the new sound replaced the previous one').toEqual(SOUND);
    expect(await staged(), 'nothing else is beside it').toEqual(['notification-sound.mp3']);
    expect(fake.rows(schema.userNotificationSettings)).toMatchObject([
      { userId: USER, soundPath, soundFilename: 'chime.mp3' },
    ]);
  });

  it('E4 pin: removes the person’s previous sound of another type', async () => {
    await seedSound(path.join(uploads, 'notification-sound.wav'), 'audio/wav', 'before.wav');

    const res = await upload(SOUND);

    expect(res.status, `the upload succeeds (${String(res.body?.error)})`).toBe(201);
    expect(await readFile(soundPath), 'the new sound is at its name').toEqual(SOUND);
    expect(await staged(), 'the previous sound is removed').toEqual(['notification-sound.mp3']);
  });

  it('E4 pin: replaces a link planted at the sound’s name without touching its target', async () => {
    const target = path.join(storage, 'target.bin');
    await writeFile(target, OTHER, { mode: 0o600 });
    await symlink(target, soundPath);

    const res = await upload(SOUND);

    expect(res.status, `the upload succeeds (${String(res.body?.error)})`).toBe(201);
    expect((await lstat(soundPath)).isFile(), 'the link is replaced by the sound').toBe(true);
    expect(await readFile(soundPath), 'the sound is at its name').toEqual(SOUND);
    expect(await readFile(target), 'the link’s target is untouched').toEqual(OTHER);
  });

  it('E6 keeps the person’s previous sound at the same name when a re-upload fails', async () => {
    const before = await seedSound(soundPath, 'audio/mpeg', 'before.mp3');
    const row = fake.rows(schema.userNotificationSettings);
    let midWrite: Buffer | null = null;
    const fault = failTheWriteOf(SOUND, enospc(), async () => {
      midWrite = await readFile(soundPath).catch(() => null);
    });

    const res = await upload(SOUND);

    expect(fault.fired, 'the sound’s bytes reached FileHandle.prototype.write and failed').toBe(1);
    expect(res.status, `the upload fails (${String(res.body?.error)})`).toBe(500);
    const stands = await lstat(soundPath).catch(() => null);
    expect(
      stands?.isFile() ?? false,
      'the previous sound is still at its name (it was removed)',
    ).toBe(true);
    expect(await readFile(soundPath), 'it holds the previous sound’s bytes').toEqual(
      PREVIOUS_SOUND,
    );
    expect(stands?.ino, 'it is the previous sound’s inode').toBe(before.ino);
    expect(fake.rows(schema.userNotificationSettings), 'the row is unchanged').toEqual(row);
    expect(await staged(), 'nothing else is beside it').toEqual(['notification-sound.mp3']);
    expect(
      midWrite,
      'the previous sound is what a reader sees while the new one is written',
    ).toEqual(PREVIOUS_SOUND);
  });

  it('E6 pin: keeps the person’s previous sound of another type when an upload fails', async () => {
    const wav = path.join(uploads, 'notification-sound.wav');
    const before = await seedSound(wav, 'audio/wav', 'before.wav');
    const row = fake.rows(schema.userNotificationSettings);
    const fault = failTheWriteOf(SOUND, enospc());

    const res = await upload(SOUND);

    expect(fault.fired, 'the sound’s bytes reached FileHandle.prototype.write and failed').toBe(1);
    expect(res.status, `the upload fails (${String(res.body?.error)})`).toBe(500);
    expect(await readFile(wav), 'the previous sound keeps its bytes').toEqual(PREVIOUS_SOUND);
    expect((await lstat(wav)).ino, 'it is the previous sound’s inode').toBe(before.ino);
    expect(fake.rows(schema.userNotificationSettings), 'the row is unchanged').toEqual(row);
    expect(await staged(), 'nothing else is beside it').toEqual(['notification-sound.wav']);
  });
});
