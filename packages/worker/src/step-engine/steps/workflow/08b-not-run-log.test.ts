import { beforeEach, describe, it, expect, vi } from 'vitest';

const m = vi.hoisted(() => ({
  ddevExec: vi.fn(),
  ensureAppServing: vi.fn(),
  info: vi.fn(),
}));

vi.mock('./_app-runtime.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./_app-runtime.js')>()),
  ensureAppServing: m.ensureAppServing,
}));
vi.mock('../../../sandbox/ddev-runner.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../sandbox/ddev-runner.js')>()),
  ddevExec: m.ddevExec,
}));
vi.mock('../../../sandbox/ddev-playwright.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../sandbox/ddev-playwright.js')>()),
  ensureDdevPlaywrightBrowsers: async () => ({ attempted: false, ok: false, note: null }),
  killStalePlaywrightRuns: async () => 0,
}));

import { testManagementStep } from './08b-test-management.js';

describe('08b: the notRun field of the pass log follows whether the selective run happened', () => {
  const ctx = {
    taskId: 'aaaaaaaa-0000-4000-8000-000000000001',
    logger: { info: m.info, warn: vi.fn() },
    emitProgress: vi.fn(async () => {}),
  } as never;
  const detected = (over: Record<string, unknown> = {}) => ({
    workspacePath: '/wt',
    sandboxWorktreePath: '/ws',
    frameworks: ['phpunit'],
    primary: 'phpunit',
    frameworkRoots: { phpunit: '' },
    testDirs: ['tests'],
    ddev: true,
    ddevPlaywrightAddon: false,
    repoSubpath: 'repo-sub',
    spec: '',
    implementationFiles: { files: [], total: 0, truncated: false },
    planImpact: '',
    ...over,
  });
  const apply = (reported: string[], over: Record<string, unknown> = {}, iteration = 0) =>
    testManagementStep.apply(ctx, {
      detected: detected(over),
      formValues: { action: 'manage', runTests: true },
      iteration,
      previousIterations: [],
      llmOutput: { tests_created: reported, tests_updated: [], tests_deleted: [], notes: '' },
    } as never);
  const logged = (): Record<string, unknown> => m.info.mock.calls.at(-1)![0];

  beforeEach(() => {
    m.ddevExec.mockReset().mockResolvedValue({ exitCode: 0, output: 'ok' });
    m.ensureAppServing.mockReset();
    m.info.mockReset();
  });

  it('is false for a run that happened and passed', async () => {
    const out = await apply(['tests/OkTest.php']);
    expect(out.testRun).toMatchObject({ ran: true, passed: true });
    expect(logged().notRun).toBe(false);
  });

  it('is false when a file was dropped and the files that stayed ran and passed', async () => {
    const out = await apply(['tests/a bTest.php', 'tests/OkTest.php']);
    expect(out.testRun).toMatchObject({ ran: true, passed: true });
    expect(out.degradedNote).toContain('1 reported test file was dropped and did not run');
    expect(logged().notRun).toBe(false);
  });

  it('is false when a file was dropped and the files that stayed ran and failed', async () => {
    m.ddevExec.mockResolvedValue({ exitCode: 1, output: 'FAILURES!' });
    const out = await apply(['tests/a bTest.php', 'tests/OkTest.php']);
    expect(out.testRun).toMatchObject({ ran: true, passed: false });
    expect(out.testsPassed).toBe(false);
    expect(out.degradedNote).toContain('1 reported test file was dropped and did not run');
    expect(logged().notRun).toBe(false);
  });

  it('is true when every reported file was dropped', async () => {
    const out = await apply(['tests/a bTest.php', 'tests/c dTest.php']);
    expect(m.ddevExec).not.toHaveBeenCalled();
    expect(out.testRun).toMatchObject({ ran: false });
    expect(logged().notRun).toBe(true);
  });

  it('is true when the DDEV runner is unavailable', async () => {
    const out = await apply(['tests/OkTest.php'], { repoSubpath: null });
    expect(m.ddevExec).not.toHaveBeenCalled();
    expect(out.testRun).toMatchObject({ ran: false });
    expect(out.degradedNote).toContain('DDEV runner unavailable');
    expect(logged().notRun).toBe(true);
  });

  it('is true when no configuration file was found for the framework', async () => {
    const out = await apply(['tests/OkTest.php'], { frameworkRoots: { phpunit: null } });
    expect(m.ddevExec).not.toHaveBeenCalled();
    expect(out.testRun).toMatchObject({ ran: false });
    expect(out.degradedNote).toContain('written but never executed');
    expect(logged().notRun).toBe(true);
  });

  it('is true when the runner could not enumerate any test of a failed run', async () => {
    m.ddevExec
      .mockResolvedValueOnce({ exitCode: 1, output: 'failed' })
      .mockResolvedValueOnce({ exitCode: 1, output: 'no tests' });
    const out = await apply(
      ['tests/a.spec.ts'],
      { primary: 'playwright', frameworks: ['playwright'], frameworkRoots: { playwright: '' } },
      1,
    );
    expect(m.ddevExec).toHaveBeenCalledTimes(2);
    expect(out.testRun).toMatchObject({ ran: false });
    expect(out.degradedNote).toContain('could not enumerate any of the tests');
    expect(logged().notRun).toBe(true);
  });
});
