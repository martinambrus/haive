import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  loadPreviousStepOutput: vi.fn(),
  ensureAppServing: vi.fn(),
  gitWorkspaceStatus: vi.fn(),
}));

vi.mock('../onboarding/_helpers.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../onboarding/_helpers.js')>()),
  loadPreviousStepOutput: m.loadPreviousStepOutput,
}));
vi.mock('../workflow/_app-runtime.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../workflow/_app-runtime.js')>()),
  ensureAppServing: m.ensureAppServing,
}));
vi.mock('../../../repo/git-workspace.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../repo/git-workspace.js')>()),
  gitWorkspaceStatus: m.gitWorkspaceStatus,
}));

import { TaskCancelledError } from '../../step-definition.js';
import { runAppReadyStep } from './99-run-app-ready.js';

const warn = vi.fn();
const ctx = {
  taskId: 'task-1',
  workspacePath: '/repos/u/r',
  db: { query: { tasks: { findFirst: vi.fn(async () => ({ exposeDbPort: false })) } } },
  logger: { info: vi.fn(), warn },
} as never;

const detect = () => runAppReadyStep.detect!(ctx);
const rejection = (run: () => Promise<unknown>) =>
  run().then(
    () => null,
    (e: unknown) => e,
  );

// The ready gate's runtime bring-up is best-effort, but a Stop is no failure to degrade around: the step
// runner tells it apart only by `instanceof TaskCancelledError`.
describe('run-app ready gate runtime bring-up', () => {
  beforeEach(() => {
    m.loadPreviousStepOutput.mockReset().mockResolvedValue(null);
    m.ensureAppServing.mockReset();
    m.gitWorkspaceStatus.mockReset().mockResolvedValue('absent');
    warn.mockClear();
  });

  it('lets a cancel from the app ensure out as that same cancel, whatever its message', async () => {
    const cancel = new TaskCancelledError('stopped from the task page');
    m.ensureAppServing.mockRejectedValueOnce(cancel);

    const err = await rejection(detect);

    expect(m.ensureAppServing, 'the bring-up never reached the app ensure').toHaveBeenCalledTimes(
      1,
    );
    expect(err, 'the cancel was swallowed as a runtime bring-up miss').not.toBeNull();
    expect(err, 'the cancel was replaced by another error').toBe(cancel);
  });

  it('still renders the gate without an app when an ordinary error only says the task was cancelled', async () => {
    const boom = new Error('task cancelled');
    m.ensureAppServing.mockRejectedValueOnce(boom);

    const detected = await detect();

    expect(m.ensureAppServing).toHaveBeenCalledTimes(1);
    expect(detected).toMatchObject({
      mode: 'none',
      appUrl: null,
      liveBrowser: null,
      directAccess: false,
      dbAccess: false,
      workspacePath: '/repos/u/r',
      hasGit: false,
    });
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ err: boom }), expect.any(String));
    const form = runAppReadyStep.form!(ctx, detected)!;
    expect(form.fields.map((f) => f.id)).toContain('commit');
  });
});
