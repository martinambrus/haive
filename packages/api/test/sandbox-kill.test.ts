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
const IDS = 'aaa\trunning\nbbb\tcreated\n';
const listing = [
  'docker',
  'ps',
  '-a',
  '--format',
  '{{.ID}}\t{{.State}}',
  '--filter',
  `label=haive.task.id=${TASK}`,
  '--filter',
  `name=^${containerPrefix(CONTAINER_FAMILY.cli)}`,
];
const removal = ['docker', 'rm', '-f', 'aaa', 'bbb'];

const causes: { name: string; run: Run }[] = [
  {
    name: 'cannot be spawned',
    run: { error: new Error('spawn docker ENOENT') },
  },
  { name: 'throws on spawn', run: { throws: new Error('spawn E2BIG') } },
  {
    name: 'exits 1',
    run: { code: 1, stderr: 'first line\nCannot connect to the daemon\n\n' },
  },
  { name: 'exits 125 with nothing on stderr', run: { code: 125 } },
  { name: 'is ended by a signal', run: { code: null, signal: 'SIGKILL' } },
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
  h.spawn.mockImplementation((_cmd: string, args: string[]) => {
    const run = runs.shift();
    if (!run) throw new Error('unscripted docker call');
    if (run.throws) throw run.throws;
    // Model Docker's ID-only output when an older caller omits --format.
    if (args[0] === 'ps' && !args.includes('--format') && run.stdout) {
      run.stdout = run.stdout.replace(/\t[^\n]*/g, '');
    }
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
    it.each(causes)('$name: rejects with the fixed reason code', async ({ run }) => {
      runs.push(...failing(step, run));
      expect(await rejection(killTaskSandboxesOrThrow(TASK))).toBe(`sandbox_${step}_failed`);
      expect(argvs()).toEqual(spawned(step));
    });
  });

  it('does not take the ids a failing listing printed', async () => {
    runs.push({ code: 1, stdout: IDS, stderr: 'boom\n' });
    expect(await rejection(killTaskSandboxesOrThrow(TASK))).toBe('sandbox_listing_failed');
    expect(argvs()).toEqual([listing]);
  });

  it.each(deadlines)(
    'rejects a %s that outlasts %i ms with the fixed reason code',
    async (step, ms) => {
      runs.push(...failing(step, { hang: true }));
      let settled = false;
      const pending = rejection(killTaskSandboxesOrThrow(TASK)).finally(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(ms - 1);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await pending).toBe(`sandbox_${step}_failed`);
      expect(children[step === 'listing' ? 0 : 1]?.kill).toHaveBeenCalledWith('SIGKILL');
      expect(argvs()).toEqual(spawned(step));
    },
  );

  describe('when the removal fails, it lists the task again until the ids are gone', () => {
    const failed: Run = { code: 1, stderr: 'removal of container aaa is already in progress\n' };
    const cause = 'sandbox_removal_failed';
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
        runs.push({ stdout: IDS }, run, { stdout: 'ccc\texited\nddd\tdead\n' });
        await expect(killTaskSandboxesOrThrow(TASK)).resolves.toBe(2);
        expect(argvs()).toEqual([listing, removal, listing]);
      },
    );

    it('lists every 250 ms and resolves the count as soon as none of the ids is listed', async () => {
      runs.push(
        { stdout: IDS },
        failed,
        { stdout: 'aaa\trunning\n' },
        { stdout: 'aaa\trunning\n' },
        { stdout: '' },
      );
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
      ['the first of them', 'aaa\trunning\n'],
      ['the second of them', 'bbb\tpaused\n'],
      ['one of them among others', 'ccc\texited\nbbb\tpaused\n'],
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
      runs.push(
        { stdout: IDS },
        failed,
        { stdout: 'aaa\trunning\n', delay: 2_900 },
        { stdout: 'aaa\trunning\n' },
      );
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
        runs.push({ stdout: IDS }, failed, { stdout: 'aaa\trunning\n' }, run);
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
    await expect(killTaskSandboxes(TASK)).resolves.toMatchObject({
      killed: 2,
      killConfirmed: true,
    });
    expect(argvs()).toEqual([listing, removal]);
  });

  it('resolves 0 for an empty listing and spawns no removal', async () => {
    runs.push({ stdout: '' });
    await expect(killTaskSandboxes(TASK)).resolves.toMatchObject({
      killed: 0,
      killConfirmed: true,
    });
    expect(argvs()).toEqual([listing]);
  });

  it.each(causes)(
    'reports unconfirmed and spawns no removal when the listing $name',
    async ({ run }) => {
      runs.push(run);
      await expect(killTaskSandboxes(TASK)).resolves.toMatchObject({
        killed: 0,
        killConfirmed: false,
      });
      expect(argvs()).toEqual([listing]);
    },
  );

  it.each(causes)('reports unconfirmed when the removal $name', async ({ run }) => {
    runs.push({ stdout: IDS }, run, { code: 1 });
    await expect(killTaskSandboxes(TASK)).resolves.toMatchObject({
      killed: 0,
      killConfirmed: false,
    });
    expect(argvs()).toEqual([listing, removal, listing]);
  });

  it.each(deadlines)(
    'resolves when the %s outlasts %i ms, without claiming confirmation',
    async (step, ms) => {
      runs.push(...failing(step, { hang: true }));
      const pending = killTaskSandboxes(TASK);
      await vi.advanceTimersByTimeAsync(ms);
      await expect(pending).resolves.toMatchObject({ killed: 0, killConfirmed: false });
      expect(children[step === 'listing' ? 0 : 1]?.kill).toHaveBeenCalledWith('SIGKILL');
    },
  );
});

describe('deadline timers', () => {
  const settle = async (spawned: number) => {
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(31_000);
    expect(children).toHaveLength(spawned);
    for (const child of children) expect(child.kill).not.toHaveBeenCalled();
  };

  it.each(deadlines)('leaves no timer and no kill when the %s call exits', async (step) => {
    runs.push(...(step === 'listing' ? [{ stdout: '' }] : [{ stdout: IDS }, { stdout: IDS }]));
    await expect(killTaskSandboxes(TASK)).resolves.toMatchObject({
      killed: step === 'listing' ? 0 : 2,
      killConfirmed: true,
    });
    await settle(step === 'listing' ? 1 : 2);
  });

  it.each(deadlines)('leaves no timer and no kill when the %s call cannot spawn', async (step) => {
    runs.push(...failing(step, { error: new Error('spawn docker ENOENT') }));
    await expect(killTaskSandboxes(TASK)).resolves.toMatchObject({
      killed: 0,
      killConfirmed: false,
    });
    await settle(step === 'listing' ? 1 : 3);
  });
});

describe('sandbox cleanup confirmation', () => {
  it('a failed Docker listing is structurally unconfirmed', async () => {
    runs.push({ code: 1, stderr: 'Cannot connect to the daemon' });
    expect(await killTaskSandboxes(TASK)).toMatchObject({ killed: 0, killConfirmed: false });
  });
  it('a failed removal never claims a confirmed kill count', async () => {
    runs.push({ stdout: IDS }, { code: 1 }, { code: 1 });
    expect(await killTaskSandboxes(TASK)).toMatchObject({ killed: 0, killConfirmed: false });
  });
  it('finds created and exited sandboxes as well as running ones', async () => {
    h.spawn.mockImplementation((_cmd: string, args: string[]) => {
      const child = new FakeChild();
      queueMicrotask(() =>
        play(child, { stdout: args[0] === 'ps' && args.includes('-a') ? IDS : '' }),
      );
      return child;
    });
    await killTaskSandboxes(TASK);
    expect(argvs()).toContainEqual(removal);
  });
});

describe.each([
  ['ordinary', killTaskSandboxes],
  ['strict', killTaskSandboxesOrThrow],
] as const)('%s removal confirmation', (_name, kill) => {
  it.each(['', 'aaa\tremoving\n', 'aaa\tdead\n', 'aaa\texited\n'])(
    'confirms a failed removal when no live sandbox remains (%j)',
    async (after) => {
      runs.push(
        { stdout: 'aaa\trunning\n' },
        { code: 1, stderr: 'opaque conflict' },
        { stdout: after },
      );
      const pending = kill(TASK);
      const observed = pending.catch(() => undefined);
      await vi.runAllTimersAsync();
      await observed;
      const result = await pending;
      expect(result).toEqual(_name === 'ordinary' ? { killed: 1, killConfirmed: true } : 1);
      expect(argvs()).toEqual([listing, ['docker', 'rm', '-f', 'aaa'], listing]);
    },
  );
  it.each(['removing', 'dead'])(
    'confirms a %s leftover even when its removal fails',
    async (state) => {
      runs.push({ stdout: `aaa\t${state}\n` }, { code: 1 }, { stdout: `aaa\t${state}\n` });
      const pending = kill(TASK);
      const observed = pending.catch(() => undefined);
      await vi.runAllTimersAsync();
      await observed;
      expect(await pending).toEqual(_name === 'ordinary' ? { killed: 1, killConfirmed: true } : 1);
    },
  );
  it.each(['created', 'running', 'restarting', 'paused'])(
    'refuses confirmation while a %s sandbox remains despite benign stderr',
    async (state) => {
      runs.push(
        { stdout: 'aaa\trunning\n' },
        { code: 1, stderr: 'already gone' },
        ...Array.from({ length: 13 }, () => ({ stdout: `aaa\t${state}\n` })),
      );
      const pending = _name === 'ordinary' ? kill(TASK) : rejection(kill(TASK));
      await vi.advanceTimersByTimeAsync(3000);
      expect(await pending).toEqual(
        _name === 'ordinary'
          ? { killed: 0, killConfirmed: false, killError: 'sandbox_removal_failed' }
          : 'sandbox_removal_failed',
      );
    },
  );
  it('does not confirm when a replacement live sandbox appears', async () => {
    runs.push(
      { stdout: 'aaa\trunning\n' },
      { code: 1 },
      ...Array.from({ length: 13 }, () => ({ stdout: 'new\trunning\n' })),
    );
    const pending = _name === 'ordinary' ? kill(TASK) : rejection(kill(TASK));
    await vi.advanceTimersByTimeAsync(3000);
    expect(await pending).toEqual(
      _name === 'ordinary'
        ? { killed: 0, killConfirmed: false, killError: 'sandbox_removal_failed' }
        : 'sandbox_removal_failed',
    );
  });
});
it('returns a coded reason instead of private Docker stderr', async () => {
  runs.push({ code: 1, stderr: 'private /var/run/private-docker.sock secret=example' });
  expect(await killTaskSandboxes(TASK)).toEqual({
    killed: 0,
    killConfirmed: false,
    killError: 'sandbox_listing_failed',
  });
});

it.each(['aaa', 'aaa\tunknown\n', 'aaa\trunning\textra\n'])(
  'refuses malformed or unknown Docker states (%j)',
  async (stdout) => {
    runs.push({ stdout });
    expect(await killTaskSandboxes(TASK)).toEqual({
      killed: 0,
      killConfirmed: false,
      killError: 'sandbox_listing_failed',
    });
    expect(argvs()).toEqual([listing]);
  },
);
