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

import { testManagementStep } from './08b-test-management.js';

describe('08b: written tests the DDEV runner could not run', () => {
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
    repoSubpath: null,
    spec: '',
    implementationFiles: { files: [], total: 0, truncated: false },
    planImpact: '',
    ...over,
  });
  const apply = (
    created: string[],
    over: Record<string, unknown> = {},
    values: Record<string, unknown> = {},
  ) =>
    testManagementStep.apply(ctx, {
      detected: detected(over),
      formValues: { action: 'manage', runTests: true, ...values },
      iteration: 0,
      previousIterations: [],
      llmOutput: { tests_created: created, tests_updated: [], tests_deleted: [], notes: '' },
    } as never);
  const logged = (): Record<string, unknown> => m.info.mock.calls.at(-1)![0];

  beforeEach(() => {
    m.ddevExec.mockReset();
    m.ensureAppServing.mockReset();
    m.info.mockReset();
  });

  it.each([
    ['no runner subpath', null],
    ['an empty runner subpath', ''],
  ])('says the tests were written but never executed when there is %s', async (_n, repoSubpath) => {
    const out = await apply(['tests/FooTest.php'], { repoSubpath });
    expect(m.ddevExec).not.toHaveBeenCalled();
    expect(out.testsPassed).toBeNull();
    expect(out.testRun).toMatchObject({ ran: false, passed: false });
    expect(out.degradedNote).toContain('DDEV runner unavailable');
    expect(out.degradedNote).toContain('could not be run');
    expect(out.degradedNote).toContain('written but never executed');
    expect(logged().notRun).toBe(true);
  });

  it('words it like the other branches that wrote tests and could not run them', async () => {
    const out = await apply(['tests/FooTest.php']);
    expect(out.degradedNote).toBe(out.testRun?.output);
  });

  it('is no verdict for the fix loop, which only a failing run feeds', async () => {
    const out = await apply(['tests/FooTest.php']);
    expect(testManagementStep.fixLoop!.evaluate(out)).toBeNull();
  });

  it('adds no note when the user asked for the tests not to run', async () => {
    const out = await apply(['tests/FooTest.php'], {}, { runTests: false });
    expect('degradedNote' in out).toBe(false);
    expect(logged().notRun).toBe(false);
  });

  it('adds no note from this branch when no runnable test file was written', async () => {
    const out = await apply(['docs/notes.md']);
    expect(out.testRun?.output).toBe(
      'no runnable test files among the changes — selective run skipped',
    );
    expect('degradedNote' in out).toBe(false);
  });
});
