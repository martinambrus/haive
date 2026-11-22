import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as install from './install-files.js';
import {
  STACK_LOCK_BEAT_MS,
  STACK_LOCK_MAX_BYTES,
  STACK_LOCK_NAME,
  STACK_LOCK_POLL_MS,
  STACK_LOCK_RELEASE_PAUSE_MS,
  STACK_LOCK_RELEASE_TRIES,
  STACK_LOCK_ROUNDS,
  STACK_LOCK_STALE_MS,
  acquireStackLock,
  describeBusy,
  releaseOnSignal,
  type StackLock,
  type StackLockOptions,
} from './stack-lock.js';

let dir: string;
let path: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'stack-lock-'));
  path = join(dir, STACK_LOCK_NAME);
});
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

const record = (token: string, holder: string, seq: number): string =>
  `${JSON.stringify({ v: 1, token, holder, startedAt: '2026-11-21T10:00:00.000Z', seq })}\n`;
const token = () => randomBytes(16).toString('hex');
const parse = async () => JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
const idle = async () => {};
const base: StackLockOptions = { heartbeat: false, sleep: idle, staleMs: 5, pollMs: 1 };
const held = async (options: StackLockOptions = {}): Promise<StackLock> => {
  const outcome = await acquireStackLock(dir, { ...base, ...options });
  if (outcome.status !== 'held') throw new Error(`expected held, got ${outcome.status}`);
  return outcome.lock;
};
const tombs = async () => (await readdir(dir)).filter((name) => name.includes('.stale.'));

describe('constants and defaults', () => {
  it('names the protocol values', () => {
    expect(STACK_LOCK_NAME).toBe('.haive-stack-lock');
    expect(STACK_LOCK_BEAT_MS).toBe(5000);
    expect(STACK_LOCK_STALE_MS).toBe(60000);
    expect(STACK_LOCK_POLL_MS).toBe(1000);
    expect(STACK_LOCK_ROUNDS).toBe(3);
    expect(STACK_LOCK_MAX_BYTES).toBe(4096);
    expect(STACK_LOCK_RELEASE_TRIES).toBe(3);
    expect(STACK_LOCK_RELEASE_PAUSE_MS).toBe(100);
  });
  it('uses them as option defaults', async () => {
    // Default staleness is observed through the requested sleeps: 60 polls of 1000 ms.
    await writeFile(path, record(token(), 'extension', 1));
    const requested: number[] = [];
    const lock = await held({
      staleMs: undefined,
      pollMs: undefined,
      sleep: async (ms) => {
        requested.push(ms);
      },
    });
    expect(requested).toHaveLength(STACK_LOCK_STALE_MS / STACK_LOCK_POLL_MS);
    expect(new Set(requested)).toEqual(new Set([STACK_LOCK_POLL_MS]));
    await lock.release();
  });
  it('beats on the default cadence', async () => {
    const setEvery = vi.spyOn(globalThis, 'setInterval');
    const lock = await held({ heartbeat: true, beatMs: undefined });
    expect(setEvery).toHaveBeenCalledWith(expect.any(Function), STACK_LOCK_BEAT_MS);
    await lock.release();
  });
});

describe('acquire and release', () => {
  it('creates a 0644 regular file with the protocol record, and release removes it', async () => {
    const lock = await held();
    const text = await readFile(path, 'utf8');
    expect(text.endsWith('\n')).toBe(true);
    const fields = JSON.parse(text) as Record<string, unknown>;
    expect(Object.keys(fields)).toEqual(['v', 'token', 'holder', 'startedAt', 'seq']);
    expect(fields).toMatchObject({ v: 1, holder: 'updater', seq: 1 });
    expect(fields.token).toMatch(/^[0-9a-f]{32}$/);
    expect(fields.token).toBe(lock.token);
    expect(new Date(String(fields.startedAt)).toISOString()).toBe(fields.startedAt);
    expect((await stat(path)).mode & 0o777).toBe(0o644);
    await lock.release();
    expect(await readdir(dir)).toEqual([]);
  });
  it('is busy while the holder is live and reports who holds it', async () => {
    const other = token();
    await writeFile(path, record(other, 'extension', 1));
    const inode = (await stat(path)).ino;
    let seq = 1;
    const outcome = await acquireStackLock(dir, {
      ...base,
      sleep: async () => {
        seq += 1;
        await writeFile(path, record(other, 'extension', seq));
      },
    });
    expect(outcome).toEqual({
      status: 'busy',
      holder: 'extension',
      startedAt: '2026-11-21T10:00:00.000Z',
    });
    expect((await parse()).token).toBe(other);
    expect(await tombs()).toEqual([]);
    // A live holder's file is never moved aside, even if it would be put back: same inode.
    expect((await stat(path)).ino).toBe(inode);
  });
  it('breaks a record that never changes, leaving no tomb', async () => {
    await writeFile(path, record(token(), 'extension', 1));
    const events: string[] = [];
    const lock = await held({ onEvent: (event) => void events.push(event) });
    expect(events).toEqual(expect.arrayContaining(['stack-lock-waiting', 'stack-lock-broken']));
    expect(events.at(-1)).toBe('stack-lock-acquired');
    expect((await parse()).holder).toBe('updater');
    expect(await tombs()).toEqual([]);
    await lock.release();
  });
  it('clears an empty record like any other unchanged bytes', async () => {
    await writeFile(path, '');
    const lock = await held();
    expect((await parse()).token).toBe(lock.token);
    await lock.release();
  });
  it('treats a poll of 0 as 1 ms so the observation always ends', async () => {
    await writeFile(path, record(token(), 'extension', 1));
    const requested: number[] = [];
    const lock = await held({
      pollMs: 0,
      staleMs: 3,
      sleep: async (ms) => {
        requested.push(ms);
      },
    });
    expect(requested).toEqual([1, 1, 1]);
    await lock.release();
  });
  it('restores a fresh record displaced by a break, byte for byte, and ends busy', async () => {
    await writeFile(path, record(token(), 'extension', 1));
    const fresh = record(token(), 'extension', 77);
    const outcome = await acquireStackLock(dir, {
      ...base,
      hooks: {
        beforeBreak: async () => {
          await writeFile(path, fresh);
        },
      },
    });
    expect(outcome.status).toBe('busy');
    expect(await readFile(path, 'utf8')).toBe(fresh);
    expect(await tombs()).toEqual([]);
  });
  it.each([2, 3])(
    'ends busy after exactly %i rounds when the lock keeps being re-created',
    async (rounds) => {
      await writeFile(path, record(token(), 'extension', 1));
      const real = install.InstallDirectory.prototype.createExclusive;
      let seq = 1;
      // Each time the name is free, another holder takes it just before our create.
      vi.spyOn(install.InstallDirectory.prototype, 'createExclusive').mockImplementation(
        async function (this: install.InstallDirectory, name: string, bytes: Buffer) {
          seq += 1;
          await writeFile(path, record(token(), 'extension', seq)).catch(() => {});
          return real.call(this, name, bytes);
        },
      );
      const events: string[] = [];
      const outcome = await acquireStackLock(dir, {
        ...base,
        rounds,
        onEvent: (event) => void events.push(event),
      });
      expect(outcome.status).toBe('busy');
      expect(events.filter((event) => event === 'stack-lock-broken')).toHaveLength(rounds);
      expect(await tombs()).toEqual([]);
    },
  );
  it('a tomb that cannot be removed after the equal re-read is left behind, not busy', async () => {
    await writeFile(path, record(token(), 'extension', 1));
    const real = install.InstallDirectory.prototype.remove;
    vi.spyOn(install.InstallDirectory.prototype, 'remove').mockImplementation(async function (
      this: install.InstallDirectory,
      name: string,
    ) {
      if (name.includes('.stale.')) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
      return real.call(this, name);
    });
    const events: Array<[string, Record<string, unknown> | undefined]> = [];
    const lock = await held({ onEvent: (event, fields) => void events.push([event, fields]) });
    expect(events).toContainEqual(['stack-lock-tomb-left', { code: 'EBUSY' }]);
    expect(events.map(([event]) => event)).toContain('stack-lock-broken');
    expect(await tombs()).toHaveLength(1);
    expect((await parse()).token).toBe(lock.token);
    await lock.release();
  });
  it('refuses a directory at the name and never deletes it', async () => {
    await mkdir(path);
    await expect(acquireStackLock(dir, base)).rejects.toThrow();
    expect((await stat(path)).isDirectory()).toBe(true);
  });
  it('refuses a link at the name and never follows or deletes it', async () => {
    const target = join(dir, 'elsewhere');
    await writeFile(target, 'keep');
    await symlink(target, path);
    await expect(acquireStackLock(dir, base)).rejects.toThrow();
    expect(await readFile(target, 'utf8')).toBe('keep');
    expect((await readdir(dir)).sort()).toEqual(['.haive-stack-lock', 'elsewhere']);
  });
  it('reports absent for a missing install directory', async () => {
    const events: string[] = [];
    const outcome = await acquireStackLock(join(dir, 'missing'), {
      ...base,
      onEvent: (event) => void events.push(event),
    });
    expect(outcome).toEqual({ status: 'absent' });
    expect(events).toEqual(['stack-lock-skipped']);
  });
  it('removes the file it created when the fsync that follows fails', async () => {
    const probe = await open(join(dir, 'probe'), 'w');
    const proto = Object.getPrototypeOf(probe) as { sync: () => Promise<void> };
    await probe.close();
    vi.spyOn(proto, 'sync').mockRejectedValueOnce(new Error('disk full'));
    await expect(acquireStackLock(dir, base)).rejects.toThrow('disk full');
    expect((await readdir(dir)).filter((name) => name !== 'probe')).toEqual([]);
  });
});

describe('size cap', () => {
  const readCapped = (max: number) => install.inInstall(dir, (d) => d.read(STACK_LOCK_NAME, max));
  it('returns a file of exactly the maximum whole', async () => {
    await writeFile(path, Buffer.alloc(16, 0x61));
    expect((await readCapped(16))?.bytes).toHaveLength(16);
  });
  it('returns max + 1 bytes for a file one byte over, and for a huge sparse file', async () => {
    await writeFile(path, Buffer.alloc(17, 0x61));
    expect((await readCapped(16))?.bytes).toHaveLength(17);
    await rm(path);
    const sparse = await open(path, 'w');
    try {
      await sparse.truncate(64 * 1024 * 1024);
    } finally {
      await sparse.close();
    }
    expect((await readCapped(16))?.bytes).toHaveLength(17);
    expect((await readCapped(STACK_LOCK_MAX_BYTES))?.bytes).toHaveLength(STACK_LOCK_MAX_BYTES + 1);
  });
  it('passes the cap on every read the lock makes: observe, tomb, beat and release', async () => {
    const reads = vi.spyOn(install.InstallDirectory.prototype, 'read');
    await writeFile(path, record(token(), 'extension', 1));
    const lock = await held({ maxBytes: 123 });
    await lock.beat();
    await lock.release();
    // First read, 5 polls, the tomb, one beat and the release.
    expect(reads.mock.calls.length).toBeGreaterThanOrEqual(9);
    for (const [, cap] of reads.mock.calls) expect(cap).toBe(123);
  });
  it('reads a record in full when no cap is given (other callers unchanged)', async () => {
    await writeFile(path, Buffer.alloc(9000, 0x61));
    expect((await install.inInstall(dir, (d) => d.read(STACK_LOCK_NAME)))?.bytes).toHaveLength(
      9000,
    );
  });
  it('breaks an oversize file that stays unchanged for the stale window', async () => {
    await writeFile(path, Buffer.alloc(100, 0x61));
    const events: string[] = [];
    const lock = await held({ maxBytes: 16, onEvent: (event) => void events.push(event) });
    expect(events).toContain('stack-lock-broken');
    expect((await parse()).token).toBe(lock.token);
    await lock.release();
  });
  it('compares only the capped prefix: a change past it is no beat, a change inside it is', async () => {
    await writeFile(path, Buffer.alloc(100, 0x61));
    const past = await acquireStackLock(dir, {
      ...base,
      maxBytes: 16,
      sleep: async () => {
        const tail = Buffer.alloc(100, 0x61);
        tail[90] = 0x62;
        await writeFile(path, tail);
      },
    });
    expect(past.status).toBe('held');
    if (past.status === 'held') await past.lock.release();
    await writeFile(path, Buffer.alloc(100, 0x61));
    const inside = await acquireStackLock(dir, {
      ...base,
      maxBytes: 16,
      sleep: async () => {
        const head = Buffer.alloc(100, 0x61);
        head[3] = 0x62;
        await writeFile(path, head);
      },
    });
    expect(inside.status).toBe('busy');
  });
});

describe('release', () => {
  it('leaves a foreign token alone', async () => {
    const lock = await held();
    const theirs = record(token(), 'extension', 9);
    await writeFile(path, theirs);
    await lock.release();
    expect(await readFile(path, 'utf8')).toBe(theirs);
  });
  it('is idempotent and never throws', async () => {
    const lock = await held();
    await lock.release();
    await expect(lock.release()).resolves.toBeUndefined();
  });
  it('a second release waits for the one in progress instead of returning early', async () => {
    const lock = await held();
    const real = install.InstallDirectory.prototype.remove;
    let open!: () => void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    let reached!: () => void;
    const entered = new Promise<void>((resolve) => {
      reached = resolve;
    });
    vi.spyOn(install.InstallDirectory.prototype, 'remove').mockImplementation(async function (
      this: install.InstallDirectory,
      name: string,
    ) {
      reached();
      await gate;
      return real.call(this, name);
    });
    const first = lock.release();
    // The first release is now stopped inside its removal, so the second can only wait for it.
    await entered;
    const second = lock.release();
    let resolved = false;
    void second.then(() => {
      resolved = true;
    });
    // One event-loop turn runs every promise that can settle without the gate; no time passes.
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(resolved).toBe(false);
    open();
    await Promise.all([first, second]);
    expect(await readdir(dir)).toEqual([]);
  });
  it('retries the removal and succeeds on the last try', async () => {
    const lock = await held({ releaseTries: 3 });
    const real = install.InstallDirectory.prototype.remove;
    let calls = 0;
    vi.spyOn(install.InstallDirectory.prototype, 'remove').mockImplementation(async function (
      this: install.InstallDirectory,
      name: string,
    ) {
      calls += 1;
      if (calls < 3) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
      return real.call(this, name);
    });
    await lock.release();
    expect(calls).toBe(3);
    expect(await readdir(dir)).toEqual([]);
  });
  it('gives up after all tries without throwing and says so', async () => {
    const events: string[] = [];
    const lock = await held({
      releaseTries: 3,
      onEvent: (event) => void events.push(event),
    });
    let calls = 0;
    vi.spyOn(install.InstallDirectory.prototype, 'remove').mockImplementation(async () => {
      calls += 1;
      throw Object.assign(new Error('busy'), { code: 'EBUSY' });
    });
    await expect(lock.release()).resolves.toBeUndefined();
    expect(calls).toBe(3);
    expect(events).toContain('stack-lock-release-failed');
    expect((await parse()).token).toBe(lock.token);
  });
  it('pauses between tries by the requested amount', async () => {
    const pauses: number[] = [];
    const lock = await held({
      releaseTries: 3,
      releasePauseMs: 7,
      sleep: async (ms) => {
        pauses.push(ms);
      },
    });
    pauses.length = 0;
    vi.spyOn(install.InstallDirectory.prototype, 'remove').mockRejectedValue(new Error('busy'));
    await lock.release();
    expect(pauses).toEqual([7, 7]);
  });
});

describe('heartbeat', () => {
  it('beat bumps seq and changes the bytes', async () => {
    const lock = await held();
    const before = await readFile(path, 'utf8');
    expect(await lock.beat()).toBe('ok');
    const after = await readFile(path, 'utf8');
    expect(after).not.toBe(before);
    expect(await parse()).toMatchObject({ seq: 2, token: lock.token });
    expect(await lock.beat()).toBe('ok');
    expect(await parse()).toMatchObject({ seq: 3 });
    await lock.release();
  });
  it.each([['taken over', async () => writeFile(path, record(token(), 'extension', 1))]])(
    'detects a lost lock (%s), reports once and never touches it again',
    async (_name, lose) => {
      const events: string[] = [];
      const lock = await held({ onEvent: (event) => void events.push(event) });
      await lose();
      const before = await readFile(path, 'utf8').catch(() => null);
      expect(await lock.beat()).toBe('lost');
      expect(lock.lost).toBe(true);
      expect(await lock.beat()).toBe('lost');
      expect(events.filter((event) => event === 'stack-lock-lost')).toHaveLength(1);
      expect(await readFile(path, 'utf8').catch(() => null)).toBe(before);
      await lock.release();
      expect(await readFile(path, 'utf8').catch(() => null)).toBe(before);
    },
  );
  it('re-creates its own record, seq + 1, when the name is absent', async () => {
    const events: string[] = [];
    const lock = await held({ onEvent: (event) => void events.push(event) });
    await rm(path);
    expect(await lock.beat()).toBe('ok');
    expect(await parse()).toMatchObject({ token: lock.token, holder: 'updater', seq: 2 });
    expect((await stat(path)).mode & 0o777).toBe(0o644);
    expect(lock.lost).toBe(false);
    expect(events).not.toContain('stack-lock-lost');
    expect(await lock.beat()).toBe('ok');
    expect(await parse()).toMatchObject({ seq: 3 });
    await lock.release();
    expect(await readdir(dir)).toEqual([]);
  });
  it('a failed re-create (EEXIST) is a failed beat; a foreign record is then a loss', async () => {
    const lock = await held();
    await rm(path);
    const theirs = record(token(), 'extension', 5);
    const real = install.InstallDirectory.prototype.createExclusive;
    vi.spyOn(install.InstallDirectory.prototype, 'createExclusive').mockImplementationOnce(
      async function (this: install.InstallDirectory, name: string, bytes: Buffer) {
        await writeFile(path, theirs);
        return real.call(this, name, bytes);
      },
    );
    expect(await lock.beat()).toBe('error');
    expect(lock.lost).toBe(false);
    expect(await lock.beat()).toBe('lost');
    expect(lock.lost).toBe(true);
    expect(await readFile(path, 'utf8')).toBe(theirs);
    await lock.release();
    expect(await readFile(path, 'utf8')).toBe(theirs);
  });
  it('a failed re-create whose name now holds its own restored record stays held', async () => {
    const lock = await held();
    await rm(path);
    const real = install.InstallDirectory.prototype.createExclusive;
    vi.spyOn(install.InstallDirectory.prototype, 'createExclusive').mockImplementationOnce(
      async function (this: install.InstallDirectory, name: string, bytes: Buffer) {
        await writeFile(path, record(lock.token, 'updater', 1));
        return real.call(this, name, bytes);
      },
    );
    expect(await lock.beat()).toBe('error');
    expect(await lock.beat()).toBe('ok');
    expect(lock.lost).toBe(false);
    expect(await parse()).toMatchObject({ token: lock.token, seq: 2 });
    await lock.release();
    expect(await readdir(dir)).toEqual([]);
  });
  it('a beat after release has started never re-creates the file', async () => {
    const lock = await held();
    await lock.release();
    expect(await readdir(dir)).toEqual([]);
    expect(await lock.beat()).toBe('lost');
    expect(await readdir(dir)).toEqual([]);
  });
  it('reports a failing write once per streak and recovers', async () => {
    const events: string[] = [];
    const lock = await held({ onEvent: (event) => void events.push(event) });
    const spy = vi
      .spyOn(install.InstallDirectory.prototype, 'overwrite')
      .mockRejectedValue(new Error('io'));
    expect(await lock.beat()).toBe('error');
    expect(await lock.beat()).toBe('error');
    expect(events.filter((event) => event === 'stack-lock-beat-failed')).toHaveLength(1);
    spy.mockRestore();
    expect(await lock.beat()).toBe('ok');
    await lock.release();
  });
  it('rewrites its own record after a failed write left it empty, without reporting a loss', async () => {
    const events: string[] = [];
    const lock = await held({ onEvent: (event) => void events.push(event) });
    const real = install.InstallDirectory.prototype.overwrite;
    vi.spyOn(install.InstallDirectory.prototype, 'overwrite').mockImplementationOnce(
      async function (this: install.InstallDirectory, name: string) {
        await real.call(this, name, Buffer.alloc(0));
        throw new Error('io');
      },
    );
    expect(await lock.beat()).toBe('error');
    expect(await readFile(path, 'utf8')).toBe('');
    expect(await lock.beat()).toBe('ok');
    expect(await parse()).toMatchObject({ token: lock.token, seq: 2 });
    expect(lock.lost).toBe(false);
    expect(events).not.toContain('stack-lock-lost');
    await lock.release();
    expect(await readdir(dir)).toEqual([]);
  });
  it('still reports a loss for an unparseable record when no write had failed', async () => {
    const lock = await held();
    await writeFile(path, '');
    expect(await lock.beat()).toBe('lost');
    expect(lock.lost).toBe(true);
    await lock.release();
    expect(await readFile(path, 'utf8')).toBe('');
  });
  it('beats once per beatMs and stops beating after release', async () => {
    // Only the heartbeat's interval is faked; the file operations stay real and are awaited.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const lock = await held({ heartbeat: true, beatMs: 7 });
    const beat = vi.spyOn(lock, 'beat');
    await vi.advanceTimersByTimeAsync(6);
    expect(beat).not.toHaveBeenCalled();
    // The tick starts one beat; its result is the promise the interval callback did not await.
    for (const [seq, advance] of [
      [2, 1],
      [3, 7],
      [4, 7],
    ] as const) {
      await vi.advanceTimersByTimeAsync(advance);
      expect(await beat.mock.results.at(-1)!.value).toBe('ok');
      expect(await parse()).toMatchObject({ seq });
    }
    expect(beat).toHaveBeenCalledTimes(3);
    await lock.release();
    await vi.advanceTimersByTimeAsync(10 * 7);
    expect(beat).toHaveBeenCalledTimes(3);
    expect(await readdir(dir)).toEqual([]);
  });
});

describe('releaseOnSignal', () => {
  const saved: Record<string, NodeJS.SignalsListener[]> = {};
  beforeEach(() => {
    for (const signal of ['SIGTERM', 'SIGINT'] as const) {
      saved[signal] = process.listeners(signal) as NodeJS.SignalsListener[];
      process.removeAllListeners(signal);
    }
  });
  afterEach(() => {
    for (const signal of ['SIGTERM', 'SIGINT'] as const) {
      process.removeAllListeners(signal);
      for (const listener of saved[signal]!) process.on(signal, listener);
    }
  });
  it.each([['SIGTERM', 143]] as const)('releases then exits on %s', async (signal, exitCode) => {
    const lock = await held();
    const exited = new Promise<number>((resolve) => {
      releaseOnSignal(lock, (c) => resolve(c) as never);
    });
    process.emit(signal);
    expect(await exited).toBe(exitCode);
    expect(await readdir(dir)).toEqual([]);
  });
  it('waits for one cleanup across repeated signals before releasing', async () => {
    const lock = await held();
    let finish: () => void = () => {};
    const cleanup = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    let done: (code: number) => void = () => {};
    const exited = new Promise<number>((resolve) => {
      done = resolve;
    });
    const exit = vi.fn((code: number) => done(code) as never);
    releaseOnSignal(lock, exit, ['SIGTERM'], { beforeRelease: cleanup });
    process.emit('SIGTERM');
    process.emit('SIGTERM');
    await Promise.resolve();
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalled();
    expect(await parse()).toMatchObject({ token: lock.token });
    finish();
    expect(await exited).toBe(143);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(await readdir(dir)).toEqual([]);
  });
  it('handles SIGTERM only by default, leaving SIGINT alone', async () => {
    const lock = await held();
    const dispose = releaseOnSignal(lock, vi.fn() as never);
    expect(process.listenerCount('SIGTERM')).toBe(1);
    expect(process.listenerCount('SIGINT')).toBe(0);
    dispose();
    await lock.release();
  });
  it('the disposer detaches the handlers', async () => {
    const lock = await held();
    const dispose = releaseOnSignal(lock, vi.fn() as never);
    expect(process.listenerCount('SIGTERM')).toBe(1);
    dispose();
    expect(process.listenerCount('SIGTERM')).toBe(0);
    expect(process.listenerCount('SIGINT')).toBe(0);
    await lock.release();
  });
});

describe('describeBusy', () => {
  it('names the holder, says to retry and that an interrupted holder clears itself', () => {
    const updater = describeBusy({ status: 'busy', holder: 'updater' });
    const extension = describeBusy({ status: 'busy', holder: 'extension' });
    expect(updater).toContain('another upgrade');
    expect(extension).toContain('a Haive Desktop operation');
    for (const text of [updater, extension]) {
      expect(text).toMatch(/retry/i);
      expect(text).toMatch(/stale|clears itself|minute/i);
    }
  });
  it('shows only a plain holder name, never other record text', () => {
    const hostile = describeBusy({
      status: 'busy',
      holder: '<img src=x onerror=alert(1)> [x](javascript:1)',
    });
    expect(hostile).toContain('another process (unknown)');
    expect(hostile).not.toContain('<');
    expect(describeBusy({ status: 'busy', holder: 'other-tool.2' })).toContain(
      'another process (other-tool.2)',
    );
  });
});
