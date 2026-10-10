import { beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({ run: vi.fn(), acquire: vi.fn() }));
vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  const { promisify } = await import('node:util');
  const execFile = Object.assign(vi.fn(), { [promisify.custom]: mock.run });
  return { ...actual, execFile };
});
vi.mock('../db.js', () => ({
  getDb: () => ({ query: { tasks: { findFirst: async () => null } } }),
}));
vi.mock('./runtime-caps.js', () => ({
  RUNTIME_WEIGHT_LABEL: 'haive.runtime.weight',
  buildResourceLimitArgs: () => [],
  resolveRunnerCaps: async () => null,
  resolveRuntimeWeightMb: async () => 2048,
}));
vi.mock('./runtime-admission.js', async () => {
  const actual =
    await vi.importActual<typeof import('./runtime-admission.js')>('./runtime-admission.js');
  return { ...actual, acquireRuntimeSlot: mock.acquire };
});

import { ensureAppRunnerStarted } from './app-runner.js';
import { RuntimeSlotAbortedError } from './runtime-admission.js';

/** A full slot gate: waits until released by the test, rejects the way the real gate does when
 *  the signal it was handed aborts. */
function fullGate(): { admit: () => void; release: ReturnType<typeof vi.fn> } {
  const release = vi.fn();
  let admit!: () => void;
  mock.acquire.mockImplementation(
    (taskId: string, _kind: string, _onWait?: unknown, signal?: AbortSignal) =>
      new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(new RuntimeSlotAbortedError(taskId));
        signal?.addEventListener('abort', () => reject(new RuntimeSlotAbortedError(taskId)), {
          once: true,
        });
        admit = () => resolve(release);
      }),
  );
  return { admit: () => admit(), release };
}

/** Settles with the call's outcome, or 'pending' when it has not settled within `ms`. */
async function settled(p: Promise<unknown>, ms = 200): Promise<unknown> {
  const outcome = p.then(
    () => 'resolved',
    (err: unknown) => err,
  );
  return Promise.race([outcome, new Promise((r) => setTimeout(() => r('pending'), ms))]);
}

let args: readonly [string, string, string];
let taskSeq = 0;

beforeEach(() => {
  args = [`task-${++taskSeq}`, 'ws/sub', 'img:tag'];
  mock.run.mockReset();
  mock.run.mockRejectedValue(new Error('docker unavailable'));
  mock.acquire.mockReset();
});

describe('ensureAppRunnerStarted cancellation', () => {
  it('hands its signal to the slot gate and rejects when it aborts mid-wait', async () => {
    const gate = fullGate();
    const stop = new AbortController();
    const call = ensureAppRunnerStarted(...args, undefined, { signal: stop.signal });
    await vi.waitFor(() => expect(mock.acquire).toHaveBeenCalledTimes(1));
    expect(mock.acquire.mock.calls[0]![3]).toBe(stop.signal);
    stop.abort();
    expect(await settled(call)).toBeInstanceOf(RuntimeSlotAbortedError);
    expect(gate.release).not.toHaveBeenCalled();
  });

  it('lets a joiner stop waiting on its own signal while the first call keeps booting', async () => {
    const gate = fullGate();
    const first = ensureAppRunnerStarted(...args);
    await vi.waitFor(() => expect(mock.acquire).toHaveBeenCalledTimes(1));
    const stop = new AbortController();
    const joiner = ensureAppRunnerStarted(...args, undefined, { signal: stop.signal });
    expect(await settled(joiner)).toBe('pending');
    stop.abort();
    expect(await settled(joiner)).toBeInstanceOf(RuntimeSlotAbortedError);
    expect(mock.acquire).toHaveBeenCalledTimes(1);
    expect(await settled(first)).toBe('pending');
    gate.admit();
    expect(await settled(first)).toEqual(new Error('docker unavailable'));
    expect(gate.release).toHaveBeenCalledTimes(1);
  });

  it('rejects a joiner whose signal was already aborted without touching the first call', async () => {
    const gate = fullGate();
    const first = ensureAppRunnerStarted(...args);
    await vi.waitFor(() => expect(mock.acquire).toHaveBeenCalledTimes(1));
    const stop = new AbortController();
    stop.abort();
    const joiner = ensureAppRunnerStarted(...args, undefined, { signal: stop.signal });
    expect(await settled(joiner)).toBeInstanceOf(RuntimeSlotAbortedError);
    expect(await settled(first)).toBe('pending');
    gate.admit();
    await settled(first);
  });

  it('boots again for a joiner that did not stop when the first call was stopped', async () => {
    const gate = fullGate();
    const stop = new AbortController();
    const first = ensureAppRunnerStarted(...args, undefined, { signal: stop.signal });
    await vi.waitFor(() => expect(mock.acquire).toHaveBeenCalledTimes(1));
    const joiner = ensureAppRunnerStarted(...args);
    stop.abort();
    expect(await settled(first)).toBeInstanceOf(RuntimeSlotAbortedError);
    await vi.waitFor(() => expect(mock.acquire).toHaveBeenCalledTimes(2));
    expect(await settled(joiner)).toBe('pending');
    gate.admit();
    expect(await settled(joiner)).toEqual(new Error('docker unavailable'));
  });
});
