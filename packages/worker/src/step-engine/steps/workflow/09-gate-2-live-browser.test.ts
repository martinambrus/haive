import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  loadPreviousStepOutput: vi.fn(),
  getTaskEnvTemplate: vi.fn(),
  resolveDdevWorkspace: vi.fn(),
  hasWorkspaceEntry: vi.fn(),
  ensureDdevWithProgress: vi.fn(),
  startBrowserDesktop: vi.fn(),
  restoreRunnerBrowserWindow: vi.fn(),
  runnerExec: vi.fn(),
  ddevPrimaryUrl: vi.fn(),
  ddevMailpitUrls: vi.fn(),
  resolveTaskDirectAccess: vi.fn(),
  resolveScreenshotRoot: vi.fn(),
  loadTaskSimilarSites: vi.fn(),
  loadUnactedInsights: vi.fn(),
}));

vi.mock('../onboarding/_helpers.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../onboarding/_helpers.js')>()),
  loadPreviousStepOutput: m.loadPreviousStepOutput,
}));
vi.mock('../env-replicate/_shared.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../env-replicate/_shared.js')>()),
  getTaskEnvTemplate: m.getTaskEnvTemplate,
}));
vi.mock('./_task-meta.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./_task-meta.js')>()),
  resolveDdevWorkspace: m.resolveDdevWorkspace,
}));
vi.mock('../../workspace-probe.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../workspace-probe.js')>()),
  hasWorkspaceEntry: m.hasWorkspaceEntry,
}));
vi.mock('./_app-runtime.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./_app-runtime.js')>()),
  ensureDdevWithProgress: m.ensureDdevWithProgress,
}));
vi.mock('../../../sandbox/ddev-runner.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../sandbox/ddev-runner.js')>()),
  startBrowserDesktop: m.startBrowserDesktop,
  restoreRunnerBrowserWindow: m.restoreRunnerBrowserWindow,
  runnerExec: m.runnerExec,
  ddevPrimaryUrl: m.ddevPrimaryUrl,
  ddevMailpitUrls: m.ddevMailpitUrls,
}));
vi.mock('../../../sandbox/_browser-access.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../sandbox/_browser-access.js')>()),
  resolveTaskDirectAccess: m.resolveTaskDirectAccess,
}));
vi.mock('./_screenshots.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./_screenshots.js')>()),
  resolveScreenshotRoot: m.resolveScreenshotRoot,
}));
vi.mock('./_similar-sites.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./_similar-sites.js')>()),
  loadTaskSimilarSites: m.loadTaskSimilarSites,
}));
vi.mock('./_gate-insights.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./_gate-insights.js')>()),
  loadUnactedInsights: m.loadUnactedInsights,
}));

import { TaskCancelledError } from '../../step-definition.js';
import { gate2VerifyApprovalStep } from './09-gate-2-verify-approval.js';

const HANDLE = { container: 'haive-ddev-ensured', projectDir: '/repos/u/r' };
const warn = vi.fn();
const ctx = {
  taskId: 'task-1',
  repoPath: '/repos/u/r',
  round: 0,
  db: { query: { tasks: { findFirst: vi.fn(async () => null) } } },
  logger: { info: vi.fn(), warn },
} as never;

const detect = () => gate2VerifyApprovalStep.detect!(ctx);
const rejection = (run: () => Promise<unknown>) =>
  run().then(
    () => null,
    (e: unknown) => e,
  );

// The gate brings the live browser up best-effort: whatever fails there lands in `liveBrowser.reason`
// and the gate still renders. A Stop is not a failure to degrade around, and the step runner tells it
// apart only by `instanceof TaskCancelledError`.
describe('gate-2 live browser bring-up', () => {
  beforeEach(() => {
    m.loadPreviousStepOutput.mockReset().mockResolvedValue(null);
    m.getTaskEnvTemplate
      .mockReset()
      .mockResolvedValue({ status: 'ready', declaredDeps: { browserTesting: true } });
    m.resolveTaskDirectAccess.mockReset().mockResolvedValue(false);
    m.resolveDdevWorkspace
      .mockReset()
      .mockResolvedValue({ workspace: '/repos/u/r', repoSubpath: 'u/r' });
    m.hasWorkspaceEntry
      .mockReset()
      .mockImplementation(async (_root: string, rel: string) => rel === '.ddev/config.yaml');
    m.ensureDdevWithProgress.mockReset().mockResolvedValue(HANDLE);
    m.startBrowserDesktop.mockReset().mockResolvedValue(undefined);
    m.restoreRunnerBrowserWindow.mockReset().mockResolvedValue(undefined);
    m.ddevPrimaryUrl.mockReset().mockResolvedValue('https://app.ddev.site');
    m.ddevMailpitUrls.mockReset().mockResolvedValue({ http: 'http://app.ddev.site:8025' });
    m.runnerExec.mockReset().mockResolvedValue({ exitCode: 0, output: '' });
    m.resolveScreenshotRoot.mockReset().mockResolvedValue('/repos/u/r');
    m.loadTaskSimilarSites.mockReset().mockResolvedValue({ sites: [], omitted: 0 });
    m.loadUnactedInsights.mockReset().mockResolvedValue({ insights: [], omitted: 0 });
    warn.mockClear();
  });

  it('lets a cancel from the runner ensure out as that same cancel, whatever its message', async () => {
    const cancel = new TaskCancelledError('stopped from the task page');
    m.ensureDdevWithProgress.mockRejectedValueOnce(cancel);

    const err = await rejection(detect);

    expect(err, 'the cancel was swallowed into liveBrowser.reason').not.toBeNull();
    expect(err, 'the cancel was replaced by another error').toBe(cancel);
  });

  it('brings the live browser up through the handle the ensure returned', async () => {
    const detected = await detect();

    expect(m.startBrowserDesktop).toHaveBeenCalledWith(HANDLE);
    expect(detected.liveBrowser).toMatchObject({
      available: true,
      appUrl: 'https://app.ddev.site',
      mailpitUrl: 'http://app.ddev.site:8025',
    });
  });

  it('still turns any other ensure failure into liveBrowser.reason, and the gate renders', async () => {
    const boom = new Error('DDEV cannot start: boom');
    m.ensureDdevWithProgress.mockRejectedValueOnce(boom);

    const detected = await detect();

    expect(detected.liveBrowser).toEqual({
      available: false,
      appUrl: null,
      reason: 'DDEV cannot start: boom',
    });
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ err: boom }), expect.any(String));
    expect(m.startBrowserDesktop).not.toHaveBeenCalled();
    const form = gate2VerifyApprovalStep.form!(ctx, detected)!;
    expect(form.fields.map((f) => f.id)).toContain('decision');
  });

  it('does not take a plain error that only says the task was cancelled for a cancel', async () => {
    m.ensureDdevWithProgress.mockRejectedValueOnce(new Error('task cancelled'));

    const detected = await detect();

    expect(detected.liveBrowser).toEqual({
      available: false,
      appUrl: null,
      reason: 'task cancelled',
    });
  });
});
