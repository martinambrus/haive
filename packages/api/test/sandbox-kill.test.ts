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
  step === 'listing' ? [run] : [{ stdout: IDS }, run];
const spawned = (step: 'listing' | 'removal') =>
  step === 'listing' ? [listing] : [listing, removal];
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
    queueMicrotask(() => play(child, run));
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
    expect(children.at(-1)?.kill).toHaveBeenCalledWith('SIGKILL');
    expect(argvs()).toEqual(spawned(step));
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
