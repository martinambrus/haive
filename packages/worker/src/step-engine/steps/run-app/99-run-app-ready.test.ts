import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  loadPreviousStepOutput: vi.fn(),
  ensureAppServing: vi.fn(),
  gitWorkspaceStatus: vi.fn(),
  gitRun: vi.fn(),
  detectOrigin: vi.fn(),
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
vi.mock('../../../repo/git-push.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../repo/git-push.js')>()),
  gitRun: m.gitRun,
  detectOrigin: m.detectOrigin,
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
    m.gitRun.mockReset();
    m.detectOrigin.mockReset().mockResolvedValue(false);
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

  it.each([1, 2])(
    'keeps serving and omits the diff when git status fails on call %i',
    async (failedCall) => {
      m.ensureAppServing.mockResolvedValue({ mode: 'host', url: 'http://app.local' });
      m.gitWorkspaceStatus.mockResolvedValue('ok');
      let statusCalls = 0;
      m.gitRun.mockImplementation(async (_cwd: string, args: string[]) => {
        if (!args.includes('status')) return { code: 0, stdout: 'main\n', stderr: '' };
        statusCalls += 1;
        return statusCalls === failedCall
          ? { code: 128, stdout: '', stderr: 'fatal: index file corrupt' }
          : { code: 0, stdout: ' M changed.txt\n', stderr: '' };
      });

      const detected = await detect();

      expect(statusCalls).toBe(failedCall);
      expect(detected).toMatchObject({
        mode: 'host',
        appUrl: 'http://app.local',
        diffArtifactPath: null,
      });
      expect(warn).toHaveBeenCalledWith(
        { err: new Error('git status failed in /repos/u/r: fatal: index file corrupt') },
        'run-app-ready: failed to build commit diff artifact',
      );
      expect(runAppReadyStep.form!(ctx, detected)).not.toBeNull();
    },
  );
});
