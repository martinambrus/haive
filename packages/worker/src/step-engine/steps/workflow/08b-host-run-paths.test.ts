import { beforeEach, describe, it, expect, vi } from 'vitest';

const m = vi.hoisted(() => ({
  ddevExec: vi.fn(),
  ensureAppServing: vi.fn(),
  run: vi.fn(),
}));

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  const { promisify } = await import('node:util');
  return { ...actual, execFile: Object.assign(vi.fn(), { [promisify.custom]: m.run }) };
});
vi.mock('./_app-runtime.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./_app-runtime.js')>()),
  ensureAppServing: m.ensureAppServing,
}));
vi.mock('../../../sandbox/ddev-runner.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../sandbox/ddev-runner.js')>()),
  ddevExec: m.ddevExec,
}));

import { testManagementStep } from './08b-test-management.js';

describe('08b: the reported test paths a selective run is built from, by how the run is made', () => {
  const ctx = {
    taskId: 'aaaaaaaa-0000-4000-8000-000000000001',
    logger: { info: vi.fn(), warn: vi.fn() },
    emitProgress: vi.fn(async () => {}),
  } as never;
  const detected = (ddev: boolean, over: Record<string, unknown> = {}) => ({
    workspacePath: '/wt',
    sandboxWorktreePath: '/ws',
    frameworks: ['vitest'],
    primary: 'vitest',
    frameworkRoots: { vitest: '' },
    testDirs: ['tests'],
    ddev,
    ddevPlaywrightAddon: false,
    repoSubpath: 'repo-sub',
    spec: '',
    implementationFiles: { files: [], total: 0, truncated: false },
    planImpact: '',
    ...over,
  });
  const apply = (
    ddev: boolean,
    reported: string[],
    over: Record<string, unknown> = {},
    updated: string[] = [],
  ) =>
    testManagementStep.apply(ctx, {
      detected: detected(ddev, over),
      formValues: { action: 'manage', runTests: true },
      iteration: 0,
      previousIterations: [],
      llmOutput: { tests_created: reported, tests_updated: updated, tests_deleted: [], notes: '' },
    } as never);

  const SYNTAX = ['app/[id]/page.test.tsx', 'app/(group)/x.spec.ts', 'tests/a b Test.php'];

  beforeEach(() => {
    m.run.mockReset().mockResolvedValue({ stdout: 'ok', stderr: '' });
    m.ddevExec.mockReset().mockResolvedValue({ exitCode: 0, output: 'ok' });
    m.ensureAppServing.mockReset();
  });

  it('hands a host run every reported path as one argument, whatever characters it holds', async () => {
    const out = await apply(false, SYNTAX);
    expect(m.ddevExec).not.toHaveBeenCalled();
    expect(m.run).toHaveBeenCalledTimes(1);
    expect(m.run).toHaveBeenCalledWith(
      'npx',
      ['vitest', 'run', ...SYNTAX],
      expect.objectContaining({ cwd: '/wt' }),
    );
    expect(out.testRun).toMatchObject({ ran: true, passed: true });
    expect(out.testsPassed).toBe(true);
    expect('degradedNote' in out).toBe(false);
  });

  it('hands a host phpunit run a path with a space as one argument', async () => {
    await apply(false, ['tests/a b Test.php'], {
      primary: 'phpunit',
      frameworks: ['phpunit'],
      frameworkRoots: { phpunit: '' },
    });
    expect(m.run).toHaveBeenCalledWith(
      'vendor/bin/phpunit',
      ['tests/a b Test.php'],
      expect.objectContaining({ cwd: '/wt' }),
    );
  });

  it('drops the same paths from a ddev run and says so', async () => {
    const out = await apply(true, SYNTAX);
    expect(m.run).not.toHaveBeenCalled();
    expect(m.ddevExec).not.toHaveBeenCalled();
    expect(out.testsPassed).toBeNull();
    expect(out.testRun).toMatchObject({ ran: false });
    expect(out.degradedNote).toContain('3 reported test files were dropped and did not run');
  });

  it('runs the files a ddev run kept and says it dropped the other', async () => {
    const out = await apply(true, ['tests/OkTest.php', 'tests/a b Test.php'], {
      primary: 'phpunit',
      frameworks: ['phpunit'],
      frameworkRoots: { phpunit: '' },
    });
    expect(m.ddevExec).toHaveBeenCalledTimes(1);
    expect(m.ddevExec.mock.calls[0]![1]).toContain('tests/OkTest.php');
    expect(m.ddevExec.mock.calls[0]![1]).not.toContain('tests/a b Test.php');
    expect(out.degradedNote).toContain('1 reported test file was dropped and did not run');
  });

  it('runs both files of the same report on a host run', async () => {
    await apply(false, ['tests/OkTest.php', 'tests/a b Test.php'], {
      primary: 'phpunit',
      frameworks: ['phpunit'],
      frameworkRoots: { phpunit: '' },
    });
    expect(m.run).toHaveBeenCalledWith(
      'vendor/bin/phpunit',
      ['tests/OkTest.php', 'tests/a b Test.php'],
      expect.anything(),
    );
  });

  it('still keeps an absolute, parent-segment or control-character path out of a host run', async () => {
    const out = await apply(false, [
      '/etc/x.spec.ts',
      'tests/../x.spec.ts',
      '../y.spec.ts',
      'tests/a\nb.spec.ts',
      'tests/ok.spec.ts',
    ]);
    expect(m.run).toHaveBeenCalledWith(
      'npx',
      ['vitest', 'run', 'tests/ok.spec.ts'],
      expect.anything(),
    );
    expect(out.degradedNote).toContain('4 reported test files were dropped and did not run');
  });

  // A runner parses options out of its arguments whether or not a shell sits in front of it.
  const OPTION_LIKE: Array<[string, string]> = [
    ['an option with a value', '--config=x.spec.ts'],
    ['a segment starting with a dash', 'tests/-x/FooTest.php'],
  ];
  const ORDINARY = ['tests/Unit/FooTest.php', 'tests/e2e-flows/login-flow.spec.ts'];

  it.each(OPTION_LIKE)('keeps a path with %s out of a host run', async (_n, bad) => {
    await apply(false, [bad, 'tests/ok.spec.ts']);
    expect(m.run).toHaveBeenCalledTimes(1);
    expect(m.run).toHaveBeenCalledWith(
      'npx',
      ['vitest', 'run', 'tests/ok.spec.ts'],
      expect.anything(),
    );
  });

  it.each(OPTION_LIKE)('keeps a path with %s out of a ddev run', async (_n, bad) => {
    await apply(true, [bad, 'tests/ok.spec.ts']);
    expect(m.ddevExec).toHaveBeenCalledTimes(1);
    expect(m.ddevExec.mock.calls[0]![1]).not.toContain(bad);
    expect(m.ddevExec.mock.calls[0]![1]).toContain('tests/ok.spec.ts');
  });

  it('keeps ordinary paths on a host run, a dash inside a name included', async () => {
    await apply(false, ORDINARY);
    expect(m.run).toHaveBeenCalledWith('npx', ['vitest', 'run', ...ORDINARY], expect.anything());
  });

  it('keeps ordinary paths on a ddev run, a dash inside a name included', async () => {
    await apply(true, ORDINARY);
    expect(m.ddevExec).toHaveBeenCalledTimes(1);
    for (const p of ORDINARY) expect(m.ddevExec.mock.calls[0]![1]).toContain(p);
  });

  it('says one file was dropped on a host run, and runs the other', async () => {
    const out = await apply(false, ['/etc/x.spec.ts', 'tests/ok.spec.ts']);
    expect(m.run).toHaveBeenCalledTimes(1);
    expect(m.run).toHaveBeenCalledWith(
      'npx',
      ['vitest', 'run', 'tests/ok.spec.ts'],
      expect.anything(),
    );
    expect(out.testRun).toMatchObject({ ran: true, passed: true });
    expect(out.degradedNote).toContain('1 reported test file was dropped and did not run');
  });

  it('says the same on a ddev run', async () => {
    const out = await apply(true, ['/etc/x.spec.ts', 'tests/ok.spec.ts']);
    expect(m.ddevExec).toHaveBeenCalledTimes(1);
    expect(m.ddevExec.mock.calls[0]![1]).toContain('tests/ok.spec.ts');
    expect(m.ddevExec.mock.calls[0]![1]).not.toContain('/etc/x.spec.ts');
    expect(out.degradedNote).toContain('1 reported test file was dropped and did not run');
  });

  it('runs nothing and still says so when a host run dropped every reported file', async () => {
    const out = await apply(false, ['/etc/x.spec.ts', '../y.spec.ts']);
    expect(m.run).not.toHaveBeenCalled();
    expect(out.testRun).toMatchObject({ ran: false });
    expect(out.testsPassed).toBeNull();
    expect(out.degradedNote).toContain('2 reported test files were dropped and did not run');
  });

  it('counts a host-dropped file once, however many times it was reported', async () => {
    const out = await apply(false, ['/etc/x.spec.ts', 'tests/ok.spec.ts'], {}, ['/etc/x.spec.ts']);
    expect(out.degradedNote).toContain('1 reported test file was dropped and did not run');
  });

  it('does not count a reported file that was never a test file', async () => {
    const out = await apply(false, ['/etc/passwd', 'tests/ok.spec.ts']);
    expect(m.run).toHaveBeenCalledTimes(1);
    expect('degradedNote' in out).toBe(false);
  });

  it('gives each kind of run the rule that applies to it', async () => {
    const host = await apply(false, ['/etc/x.spec.ts']);
    const ddev = await apply(true, ['/etc/x.spec.ts']);
    expect(host.degradedNote).toContain('relative');
    expect(host.degradedNote).not.toContain('"._/@+-"');
    expect(ddev.degradedNote).toContain('"._/@+-"');
  });
});
