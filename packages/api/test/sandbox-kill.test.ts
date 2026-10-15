import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONTAINER_FAMILY, containerPrefix } from '@haive/shared';

const h = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: h.spawn,
}));

import { killTaskSandboxes, killTaskSandboxesOrThrow } from '../src/lib/sandbox-kill.js';

interface Run {
  stdout?: string;
  stderr?: string;
  code?: number | null;
  signal?: string;
  error?: Error;
  throws?: Error;
  hang?: boolean;
  delay?: number;
}

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill = vi.fn((_signal: string) => {
    queueMicrotask(() => this.emit('close', null, 'SIGKILL'));
    return true;
  });
}

const play = (child: FakeChild, run: Run) => {
  if (run.hang) return;
  if (run.error) {
    child.emit('error', run.error);
    return;
  }
  if (run.stdout) child.stdout.emit('data', Buffer.from(run.stdout));
  if (run.stderr) child.stderr.emit('data', Buffer.from(run.stderr));
  child.emit('close', run.code === undefined ? 0 : run.code, run.signal ?? null);
};

const TASK = '0b0f7a52-3c5e-4e0a-9d6e-5a3f0c1d2e41';
const IDS = 'aaa\nbbb\n';
const listing = [
  'docker',
  'ps',
  '-q',
  '--filter',
  `label=haive.task.id=${TASK}`,
  '--filter',
  `name=^${containerPrefix(CONTAINER_FAMILY.cli)}`,
];
const removal = ['docker', 'rm', '-f', 'aaa', 'bbb'];

const causes: { name: string; run: Run; text: string }[] = [
  {
    name: 'cannot be spawned',
    run: { error: new Error('spawn docker ENOENT') },
    text: 'spawn docker ENOENT',
  },
  { name: 'throws on spawn', run: { throws: new Error('spawn E2BIG') }, text: 'spawn E2BIG' },
  {
    name: 'exits 1',
    run: { code: 1, stderr: 'first line\nCannot connect to the daemon\n\n' },
    text: 'exit 1: Cannot connect to the daemon',
  },
  { name: 'exits 125 with nothing on stderr', run: { code: 125 }, text: 'exit 125' },
  { name: 'is ended by a signal', run: { code: null, signal: 'SIGKILL' }, text: 'exit SIGKILL' },
];
const deadlines = [
  ['listing', 10_000],
  ['removal', 30_000],
] as const;

let runs: Run[];
let children: FakeChild[];
const argvs = () => h.spawn.mock.calls.map(([cmd, args]) => [cmd, ...args]);
const failing = (step: 'listing' | 'removal', run: Run): Run[] =>
  step === 'listing' ? [run] : [{ stdout: IDS }, run, { code: 1 }];
const spawned = (step: 'listing' | 'removal') =>
  step === 'listing' ? [listing] : [listing, removal, listing];
const rejection = async (call: Promise<unknown>) => {
  const err = await call.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(Error);
  return (err as Error).message;
};

beforeEach(() => {
  vi.useFakeTimers();
  runs = [];
  children = [];
  h.spawn.mockReset();
  h.spawn.mockImplementation(() => {
    const run = runs.shift();
    if (!run) throw new Error('unscripted docker call');
    if (run.throws) throw run.throws;
    const child = new FakeChild();
    children.push(child);
    if (run.delay === undefined) queueMicrotask(() => play(child, run));
    else setTimeout(() => play(child, run), run.delay);
    return child;
  });
});
afterEach(() => vi.useRealTimers());

describe('killTaskSandboxesOrThrow', () => {
  it('resolves the count when the listing succeeds and the removal exits 0', async () => {
    runs.push({ stdout: IDS }, { stdout: IDS });
    await expect(killTaskSandboxesOrThrow(TASK)).resolves.toBe(2);
    expect(argvs()).toEqual([listing, removal]);
  });

  it('resolves 0 for an empty listing and spawns no removal', async () => {
    runs.push({ stdout: '\n' });
    await expect(killTaskSandboxesOrThrow(TASK)).resolves.toBe(0);
    expect(argvs()).toEqual([listing]);
  });

  describe.each(['listing', 'removal'] as const)('when the %s', (step) => {
    it.each(causes)(
      '$name: rejects naming the step and the cause, nothing else',
      async ({ run, text }) => {
        runs.push(...failing(step, run));
        expect(await rejection(killTaskSandboxesOrThrow(TASK))).toBe(
          `sandbox ${step} failed: ${text}`,
        );
        expect(argvs()).toEqual(spawned(step));
      },
    );
  });

  it('does not take the ids a failing listing printed', async () => {
    runs.push({ code: 1, stdout: IDS, stderr: 'boom\n' });
    expect(await rejection(killTaskSandboxesOrThrow(TASK))).toBe(
      'sandbox listing failed: exit 1: boom',
    );
    expect(argvs()).toEqual([listing]);
  });

  it.each(deadlines)('rejects a %s that outlasts %i ms with "timed out"', async (step, ms) => {
    runs.push(...failing(step, { hang: true }));
    let settled = false;
    const pending = rejection(killTaskSandboxesOrThrow(TASK)).finally(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(ms - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toBe(`sandbox ${step} failed: timed out`);
    expect(children[step === 'listing' ? 0 : 1]?.kill).toHaveBeenCalledWith('SIGKILL');
    expect(argvs()).toEqual(spawned(step));
  });

  describe('when the removal fails, it lists the task again until the ids are gone', () => {
    const failed: Run = { code: 1, stderr: 'removal of container aaa is already in progress\n' };
    const cause = 'sandbox removal failed: exit 1: removal of container aaa is already in progress';
    const relistings = 1 + 3_000 / 250;
    const listingsOf = (stdout: string): Run[] =>
      Array.from({ length: relistings }, () => ({ stdout }));
    const everyListing = Array.from({ length: relistings }, () => listing);
    const noMoreListings = async (spawned: number) => {
      await vi.advanceTimersByTimeAsync(30_000);
      expect(h.spawn).toHaveBeenCalledTimes(spawned);
    };

    it('resolves the count when none of the ids is listed any more', async () => {
      runs.push({ stdout: IDS }, failed, { stdout: '' });
      await expect(killTaskSandboxesOrThrow(TASK)).resolves.toBe(2);
      expect(argvs()).toEqual([listing, removal, listing]);
    });

    it.each(causes)(
      'resolves the count when the removal $name and only other ids are listed',
      async ({ run }) => {
        runs.push({ stdout: IDS }, run, { stdout: 'ccc\nddd\n' });
        await expect(killTaskSandboxesOrThrow(TASK)).resolves.toBe(2);
        expect(argvs()).toEqual([listing, removal, listing]);
      },
    );

    it('lists every 250 ms and resolves the count as soon as none of the ids is listed', async () => {
      runs.push({ stdout: IDS }, failed, { stdout: 'aaa\n' }, { stdout: 'aaa\n' }, { stdout: '' });
      let outcome: string | undefined;
      const pending = killTaskSandboxesOrThrow(TASK).then(
        (count) => {
          outcome = `resolved ${count}`;
        },
        (err: Error) => {
          outcome = `rejected ${err.message}`;
        },
      );
      await vi.advanceTimersByTimeAsync(249);
      expect(outcome).toBeUndefined();
      expect(argvs()).toEqual([listing, removal, listing]);
      await vi.advanceTimersByTimeAsync(1);
      expect(argvs()).toEqual([listing, removal, listing, listing]);
      await vi.advanceTimersByTimeAsync(249);
      expect(outcome).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      await pending;
      expect(outcome).toBe('resolved 2');
      expect(argvs()).toEqual([listing, removal, listing, listing, listing]);
      await noMoreListings(5);
    });

    it.each([
      ['the first of them', 'aaa\n'],
      ['the second of them', 'bbb\n'],
      ['one of them among others', 'ccc\nbbb\n'],
    ])(
      'rejects with the removal cause once 3000 ms have passed with %s still listed',
      async (_which, relisted) => {
        runs.push({ stdout: IDS }, failed, ...listingsOf(relisted));
        let settled = false;
        const pending = rejection(killTaskSandboxesOrThrow(TASK)).finally(() => {
          settled = true;
        });
        await vi.advanceTimersByTimeAsync(2_999);
        expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect(await pending).toBe(cause);
        expect(argvs()).toEqual([listing, removal, ...everyListing]);
        await noMoreListings(2 + relistings);
      },
    );

    it('counts the 3000 ms from the failure, a slow listing included', async () => {
      runs.push({ stdout: IDS }, failed, { stdout: 'aaa\n', delay: 2_900 }, { stdout: 'aaa\n' });
      let settled = false;
      const pending = rejection(killTaskSandboxesOrThrow(TASK)).finally(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(2_999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await pending).toBe(cause);
      expect(argvs()).toEqual([listing, removal, listing, listing]);
      await noMoreListings(4);
    });

    it.each(causes)('rejects with the removal cause when the re-listing $name', async ({ run }) => {
      runs.push({ stdout: IDS }, failed, run);
      expect(await rejection(killTaskSandboxesOrThrow(TASK))).toBe(cause);
      expect(argvs()).toEqual([listing, removal, listing]);
    });

    it.each(causes)(
      'rejects with the removal cause when a later re-listing $name',
      async ({ run }) => {
        runs.push({ stdout: IDS }, failed, { stdout: 'aaa\n' }, run);
        const pending = rejection(killTaskSandboxesOrThrow(TASK));
        await vi.advanceTimersByTimeAsync(250);
        expect(await pending).toBe(cause);
        expect(argvs()).toEqual([listing, removal, listing, listing]);
        await noMoreListings(4);
      },
    );

    it('rejects with the removal cause when the re-listing outlasts 10000 ms', async () => {
      runs.push({ stdout: IDS }, failed, { hang: true });
      let settled = false;
      const pending = rejection(killTaskSandboxesOrThrow(TASK)).finally(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(9_999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await pending).toBe(cause);
      expect(children.at(-1)?.kill).toHaveBeenCalledWith('SIGKILL');
      expect(argvs()).toEqual([listing, removal, listing]);
    });
  });
});

describe('killTaskSandboxes', () => {
  it('resolves the count of the sandboxes it removed', async () => {
    runs.push({ stdout: IDS }, { stdout: IDS });
    await expect(killTaskSandboxes(TASK)).resolves.toBe(2);
    expect(argvs()).toEqual([listing, removal]);
  });

  it('resolves 0 for an empty listing and spawns no removal', async () => {
    runs.push({ stdout: '' });
    await expect(killTaskSandboxes(TASK)).resolves.toBe(0);
    expect(argvs()).toEqual([listing]);
  });

  it.each(causes)('resolves 0 and spawns no removal when the listing $name', async ({ run }) => {
    runs.push(run);
    await expect(killTaskSandboxes(TASK)).resolves.toBe(0);
    expect(argvs()).toEqual([listing]);
  });

  it.each(causes)('still resolves the count when the removal $name', async ({ run }) => {
    runs.push({ stdout: IDS }, run);
    await expect(killTaskSandboxes(TASK)).resolves.toBe(2);
    expect(argvs()).toEqual([listing, removal]);
  });

  it.each(deadlines)('resolves when the %s outlasts %i ms, as it always did', async (step, ms) => {
    runs.push(...failing(step, { hang: true }));
    const pending = killTaskSandboxes(TASK);
    await vi.advanceTimersByTimeAsync(ms);
    await expect(pending).resolves.toBe(step === 'listing' ? 0 : 2);
    expect(children.at(-1)?.kill).toHaveBeenCalledWith('SIGKILL');
  });
});
