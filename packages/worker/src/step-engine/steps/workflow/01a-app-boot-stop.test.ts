import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ ensureAppRunnerStarted: vi.fn() }));
vi.mock('../../../sandbox/app-runner.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../sandbox/app-runner.js')>()),
  ensureAppRunnerStarted: m.ensureAppRunnerStarted,
}));

import { RuntimeSlotAbortedError } from '../../../sandbox/runtime-admission.js';
import { TaskCancelledError } from '../../step-definition.js';
import { appBootStep } from './01a-app-boot.js';

const stop = new AbortController();
const ctx = {
  taskId: 'task-1',
  signal: stop.signal,
  logger: { info: vi.fn(), warn: vi.fn() },
  emitProgress: vi.fn(async () => {}),
} as never;
const args = {
  detected: {
    containerized: true,
    envImageTag: 'img:tag',
    repoSubpath: 'u/r',
    suggestedBootCommand: 'npm run dev',
    suggestedInstallCommand: '',
    suggestedPort: 3000,
    skip: false,
  },
  formValues: {},
  llmOutput: null,
} as never;

// The launch is best-effort and records booted:false on a failure; a Stop is not a failure, and the
// step runner tells it apart only by `instanceof TaskCancelledError`.
describe('01a-app-boot app-runner launch', () => {
  beforeEach(() => {
    m.ensureAppRunnerStarted.mockReset();
  });

  it('hands the step signal to the runner ensure and lets a Stop out as a cancel', async () => {
    m.ensureAppRunnerStarted.mockRejectedValueOnce(new RuntimeSlotAbortedError('task-1'));

    const err = await appBootStep.apply(ctx, args).then(
      () => null,
      (e: unknown) => e,
    );

    expect(err, 'the Stop was recorded as a failed launch').toBeInstanceOf(TaskCancelledError);
    expect(m.ensureAppRunnerStarted).toHaveBeenCalledWith('task-1', 'u/r', 'img:tag', 3000, {
      signal: stop.signal,
    });
  });

  it('still records any other launch failure as booted:false', async () => {
    m.ensureAppRunnerStarted.mockRejectedValueOnce(new Error('docker unavailable'));

    const res = await appBootStep.apply(ctx, args);

    expect(res).toMatchObject({
      booted: false,
      output: 'app-runner launch failed: docker unavailable',
    });
  });
});
