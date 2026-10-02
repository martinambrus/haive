import { beforeEach, describe, expect, it, vi } from 'vitest';

const { ensureDdevStarted } = vi.hoisted(() => ({ ensureDdevStarted: vi.fn() }));

vi.mock('../../../sandbox/ddev-runner.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../sandbox/ddev-runner.js')>()),
  ensureDdevStarted,
}));

import { RuntimeSlotAbortedError } from '../../../sandbox/runtime-admission.js';
import { TaskCancelledError } from '../../step-definition.js';
import { ensureDdevWithProgress } from './_app-runtime.js';

const SUBPATH = 'haive-test-user/haive-test-repo';
const HANDLE = { container: 'haive-ddev-ensured', projectDir: `/repos/${SUBPATH}` };
const stop = new AbortController();
const ctx = {
  taskId: 'task-1',
  signal: stop.signal,
  db: { query: { tasks: { findFirst: vi.fn(async () => null) } } },
} as never;

// 01c, 06a, 07c and 09 call this directly. The step runner tells a Stop from a failure only by
// `instanceof TaskCancelledError`, so a Stop during the runtime slot wait has to leave as that class,
// as ensureAppServing already makes it.
describe('ensureDdevWithProgress', () => {
  beforeEach(() => {
    ensureDdevStarted.mockReset();
  });

  it('maps a Stop during the runtime slot wait to a cancel', async () => {
    ensureDdevStarted.mockRejectedValueOnce(new RuntimeSlotAbortedError('task-1'));

    const err = await ensureDdevWithProgress(ctx, SUBPATH).then(
      () => null,
      (e: unknown) => e,
    );

    expect(err, 'the slot wait abort escaped as itself').toBeInstanceOf(TaskCancelledError);
  });

  it('passes any other error through unchanged', async () => {
    const boom = new Error('ddev start failed: boom');
    ensureDdevStarted.mockRejectedValueOnce(boom);

    await expect(ensureDdevWithProgress(ctx, SUBPATH)).rejects.toBe(boom);
  });

  it('passes a cancel the ensure itself raised through unchanged', async () => {
    const cancel = new TaskCancelledError();
    ensureDdevStarted.mockRejectedValueOnce(cancel);

    await expect(ensureDdevWithProgress(ctx, SUBPATH)).rejects.toBe(cancel);
  });

  it('does not take an error that only describes an aborted wait for the abort', async () => {
    const lookalike = new Error('runtime slot wait aborted: task task-1 was stopped');
    ensureDdevStarted.mockRejectedValueOnce(lookalike);

    await expect(ensureDdevWithProgress(ctx, SUBPATH)).rejects.toBe(lookalike);
  });

  // A Stop after admission, or during a warm start, is not seen by the ensure itself, so the boot
  // returns as if nothing happened, and the caller's migration or import must not run on it.
  it('rechecks for a Stop once the boot returns, and goes no further', async () => {
    const cancel = new TaskCancelledError();
    const findFirst = vi.fn(async () => null);
    const stopped = {
      taskId: 'task-1',
      signal: stop.signal,
      db: { query: { tasks: { findFirst } } },
      throwIfCancelled: () => {
        throw cancel;
      },
    } as never;
    ensureDdevStarted.mockResolvedValueOnce(HANDLE);

    await expect(ensureDdevWithProgress(stopped, SUBPATH)).rejects.toBe(cancel);
    expect(findFirst, 'the debug and database wiring ran after the Stop').not.toHaveBeenCalled();
  });

  it('hands the step abort signal to the ensure and returns the live handle', async () => {
    ensureDdevStarted.mockResolvedValueOnce(HANDLE);

    await expect(ensureDdevWithProgress(ctx, SUBPATH)).resolves.toBe(HANDLE);

    expect(ensureDdevStarted).toHaveBeenCalledWith(
      'task-1',
      SUBPATH,
      expect.objectContaining({ signal: stop.signal }),
    );
  });
});
