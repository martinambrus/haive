import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  loadPreviousStepOutput,
  resolveDdevWorkspace,
  loadDeclaredVerifyCommands,
  ensureAppServing,
  ddevExec,
  runStepCommandInSandbox,
  recordLedgerEntry,
} = vi.hoisted(() => ({
  loadPreviousStepOutput: vi.fn(),
  resolveDdevWorkspace: vi.fn(),
  loadDeclaredVerifyCommands: vi.fn(),
  ensureAppServing: vi.fn(),
  ddevExec: vi.fn(),
  runStepCommandInSandbox: vi.fn(),
  recordLedgerEntry: vi.fn(),
}));

vi.mock('../onboarding/_helpers.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../onboarding/_helpers.js')>()),
  loadPreviousStepOutput,
}));
vi.mock('./_task-meta.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./_task-meta.js')>()),
  resolveDdevWorkspace,
  loadDeclaredVerifyCommands,
}));
vi.mock('./_app-runtime.js', () => ({
  ensureAppServing,
  withDdevProgress: <T>(_c: unknown, _l: string, run: (onLine: (l: string) => void) => T) =>
    run(() => {}),
}));
vi.mock('../../../sandbox/ddev-runner.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../sandbox/ddev-runner.js')>()),
  ddevExec,
  ddevRunnerLife: vi.fn(async () => ({ state: 'up', startedAt: 'T0' })),
}));
vi.mock('../../../sandbox/step-command.js', () => ({ runStepCommandInSandbox }));
vi.mock('../../task-ledger.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../task-ledger.js')>()),
  recordLedgerEntry,
}));

import { buildDdevCommand } from '../../../sandbox/ddev-runner.js';
import { shellQuote } from '../../../sandbox/shell-quote.js';
import { buildUnverifiedNote, phase5VerifyStep } from './08-phase-5-verify.js';

const execFileP = promisify(execFile);

const OLD_SHAPE_KEYS = ['workspacePath', 'ddevMode', 'testFramework', 'test', 'lint', 'typecheck'];

describe('08 detect with the repository verify commands', () => {
  let workspace = '';
  const put = (name: string, body: string) => writeFile(path.join(workspace, name), body);
  const detect = () =>
    phase5VerifyStep.detect!({
      db: {},
      taskId: 'task-1',
      workspacePath: workspace,
      repoPath: workspace,
      logger: { warn: vi.fn() },
    } as never);

  beforeEach(async () => {
    workspace = await mkdtemp(path.join(tmpdir(), 'verify-declared-'));
    loadPreviousStepOutput.mockReset().mockResolvedValue(null);
    resolveDdevWorkspace.mockReset().mockResolvedValue(null);
    loadDeclaredVerifyCommands.mockReset().mockResolvedValue(null);
  });
  afterEach(() => rm(workspace, { recursive: true, force: true }));

  it('a declared test beats a root package.json test script', async () => {
    await put('package.json', JSON.stringify({ scripts: { test: 'vitest run' } }));
    loadDeclaredVerifyCommands.mockResolvedValue({ test: 'vendor/bin/phpunit -c core' });

    const out = await detect();

    expect(out.test).toEqual({
      kind: 'host',
      label: 'vendor/bin/phpunit -c core',
      argv: ['sh', '-c', 'vendor/bin/phpunit -c core'],
      source: 'declared',
    });
  });

  it('a declared lint replaces both the main lint and the phpLint slot', async () => {
    await put('package.json', JSON.stringify({ scripts: { lint: 'eslint .' } }));
    await put('phpcs.xml', '<ruleset/>');
    expect((await detect()).phpLint?.argv).toEqual(['vendor/bin/phpcs']);

    loadDeclaredVerifyCommands.mockResolvedValue({ lint: 'make lint' });
    const out = await detect();

    expect(out.lint?.argv).toEqual(['sh', '-c', 'make lint']);
    expect('phpLint' in out).toBe(false);
  });

  it('an Off slot has no runner and is recorded; Off lint drops phpLint too', async () => {
    await put('package.json', JSON.stringify({ scripts: { test: 'x', lint: 'eslint .' } }));
    await put('phpcs.xml', '<ruleset/>');
    loadDeclaredVerifyCommands.mockResolvedValue({ test: null, lint: null });

    const out = await detect();

    expect([out.test, out.lint]).toEqual([null, null]);
    expect('phpLint' in out).toBe(false);
    expect(out.offSlots).toEqual(['test', 'lint']);
  });

  it('an absent key leaves detection alone for that slot', async () => {
    await put('package.json', JSON.stringify({ scripts: { test: 'x', lint: 'eslint .' } }));
    loadDeclaredVerifyCommands.mockResolvedValue({ typecheck: 'tsc --noEmit' });

    const out = await detect();

    expect(out.test?.argv).toEqual(['npm', 'run', 'test']);
    expect(out.lint?.argv).toEqual(['npm', 'run', 'lint']);
    expect(out.typecheck?.source).toBe('declared');
    expect('offSlots' in out).toBe(false);
  });

  it('in DDEV mode builds one raw bash -c with the command quoted once', async () => {
    await mkdir(path.join(workspace, '.ddev'));
    await put('.ddev/config.yaml', 'name: x\n');
    resolveDdevWorkspace.mockResolvedValue({ workspace, repoSubpath: 'u/r' });
    const command = `SIMPLETEST_DB=mysql://db:db@db/db vendor/bin/phpunit -c core "a b" 'c'`;
    loadDeclaredVerifyCommands.mockResolvedValue({ test: command });

    const out = await detect();

    expect(out.test).toEqual({
      kind: 'ddev',
      label: command,
      argv: ['exec', '--raw', '--', 'bash', '-c', shellQuote(command)],
      source: 'declared',
    });
  });

  it('with no verify_commands the output has exactly the old shape', async () => {
    await put('package.json', JSON.stringify({ scripts: { test: 'x' } }));

    const out = await detect();

    expect(Object.keys(out).sort()).toEqual([...OLD_SHAPE_KEYS].sort());
    expect(out.test).toEqual({ kind: 'host', label: 'npm run test', argv: ['npm', 'run', 'test'] });
    expect(JSON.stringify(out)).not.toContain('source');
  });

  it('an empty declaration (all slots Auto) changes nothing', async () => {
    await put('package.json', JSON.stringify({ scripts: { test: 'x' } }));
    const plain = await detect();
    loadDeclaredVerifyCommands.mockResolvedValue({});

    expect(await detect()).toEqual(plain);
  });
});

describe('08 apply with a declared command', () => {
  const applyCtx = {
    taskId: 'task-1',
    taskStepId: 'step-1',
    round: 0,
    db: {},
    logger: { info: vi.fn(), warn: vi.fn() },
  } as never;
  const RUNNER = { container: 'haive-ddev-x', projectDir: '/repos/u/r' };

  const declared = (command: string, ddev: boolean) =>
    ddev
      ? {
          kind: 'ddev',
          label: command,
          argv: ['exec', '--raw', '--', 'bash', '-c', shellQuote(command)],
          source: 'declared',
        }
      : { kind: 'host', label: command, argv: ['sh', '-c', command], source: 'declared' };

  const run = (detected: Record<string, unknown>, formValues: Record<string, boolean>) =>
    phase5VerifyStep.apply(applyCtx, {
      detected: {
        workspacePath: '/repos/u/r',
        ddevMode: false,
        testFramework: null,
        test: null,
        lint: null,
        typecheck: null,
        ...detected,
      },
      formValues,
      iteration: 0,
      previousIterations: [],
    } as never);

  beforeEach(() => {
    ensureAppServing.mockReset().mockResolvedValue({ mode: 'none' });
    ddevExec
      .mockReset()
      .mockImplementation(async (_h: unknown, args: string) =>
        args.includes('curl')
          ? { exitCode: 0, output: 'HTTP/1.1 200 OK\r\n\r\nok\nHAIVE_HTTP_CODE=200' }
          : { exitCode: 0, output: 'ok' },
      );
    runStepCommandInSandbox.mockReset().mockResolvedValue({ ran: true, exitCode: 0, output: 'ok' });
    recordLedgerEntry.mockReset().mockResolvedValue(undefined);
  });

  it.each([127, 126])(
    'exit %i of a declared command is NOT RUN and sends no fix round',
    async (code) => {
      runStepCommandInSandbox.mockResolvedValue({
        ran: true,
        exitCode: code,
        output: 'sh: 1: x: not found',
      });

      const out = await run({ test: declared('x --all', false) }, { runTest: true });

      expect(out.test.ran).toBe(false);
      expect(out.test.passed).toBe(false);
      expect(out.test.note).toContain('command not found / not executable');
      expect(out.passed).toBe(true);
      expect(phase5VerifyStep.fixLoop!.evaluate(out)).toBeNull();
      expect(out.degradedNote).toContain('command not found / not executable');
    },
  );

  it('exit 127 of a detected (not declared) command still fails the check', async () => {
    runStepCommandInSandbox.mockResolvedValue({ ran: true, exitCode: 127, output: 'nope' });

    const out = await run(
      { test: { kind: 'host', label: 'npm run test', argv: ['npm', 'run', 'test'] } },
      { runTest: true },
    );

    expect(out.test.ran).toBe(true);
    expect(out.passed).toBe(false);
  });

  it('exit 1 of a declared command is an ordinary failure', async () => {
    runStepCommandInSandbox.mockResolvedValue({ ran: true, exitCode: 1, output: 'FAILED' });

    const out = await run({ test: declared('make test', false) }, { runTest: true });

    expect(out.test.ran).toBe(true);
    expect(out.passed).toBe(false);
    expect(phase5VerifyStep.fixLoop!.evaluate(out)).not.toBeNull();
  });

  it("reads Playwright's missing-browser error from a declared test whatever 08b detected", async () => {
    const missing = "browserType.launch: Executable doesn't exist at /root/.cache/ms-playwright/x";
    runStepCommandInSandbox.mockResolvedValue({ ran: true, exitCode: 1, output: missing });

    const out = await run(
      { testFramework: 'phpunit', test: declared('cd e2e && npx playwright test', false) },
      { runTest: true },
    );
    expect(out.test.ran).toBe(false);
    expect(phase5VerifyStep.fixLoop!.evaluate(out)).toBeNull();

    const detected = await run(
      {
        testFramework: 'phpunit',
        test: { kind: 'host', label: 'npm run test', argv: ['npm', 'run', 'test'] },
      },
      { runTest: true },
    );
    expect(detected.test.ran).toBe(true);
    expect(detected.passed).toBe(false);
  });

  it('runs a declared host command as one sh -c string', async () => {
    await run({ test: declared('cd a && make test', false) }, { runTest: true });

    expect(runStepCommandInSandbox.mock.calls[0]![1].argv).toEqual([
      'sh',
      '-c',
      'cd a && make test',
    ]);
  });

  it('declared lint is unscoped and never takes the phpcs report path', async () => {
    runStepCommandInSandbox.mockResolvedValue({ ran: true, exitCode: 1, output: 'bad' });

    const out = await run({ lint: declared('vendor/bin/phpcs', false) }, { runLint: true });

    expect(runStepCommandInSandbox.mock.calls).toHaveLength(1);
    expect(runStepCommandInSandbox.mock.calls[0]![1].argv).toEqual([
      'sh',
      '-c',
      'vendor/bin/phpcs',
    ]);
    expect(out.lint.note).toBe('lint verdict unscoped: declared command');
  });

  it('an Off slot runs nothing and the ledger says it is off', async () => {
    const out = await run({ test: null, offSlots: ['test'] }, { runTest: true });

    expect(runStepCommandInSandbox).not.toHaveBeenCalled();
    expect(out.test.ran).toBe(false);
    expect(recordLedgerEntry.mock.calls[0]![3].text).toContain(
      'test: turned off for this repository',
    );
    expect(out.degradedNote).toContain('Turned off for this repository: test.');
    expect(out.degradedNote).toContain("Declare commands on the repository's Tooling page.");
  });

  it('a command with every shell-special character reaches ddev as one quoted bash -c word', async () => {
    ensureAppServing.mockResolvedValue({ mode: 'ddev', url: 'http://x', handle: RUNNER });
    const command = `echo 'a' "b" $HOME \`id\` # c; d \\ e`;

    await run({ ddevMode: true, test: declared(command, true) }, { runTest: true });

    const slotCall = ddevExec.mock.calls.find((c) => !String(c[1]).includes('curl'))!;
    expect(slotCall[1]).toBe(`exec --raw -- bash -c ${shellQuote(command)}`);
    expect(buildDdevCommand('/repos/u/r', slotCall[1], 60_000).shell).toBe(
      `cd /repos/u/r && ddev exec --raw -- timeout --kill-after=5s 50s bash -c ${shellQuote(command)}`,
    );
  });
});

describe('the runner shell sees a declared command as exactly one argument', () => {
  let dir = '';

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'verify-quoting-'));
    await writeFile(
      path.join(dir, 'ddev'),
      '#!/bin/sh\nfor a in "$@"; do printf \'%s\\0\' "$a"; done\n',
    );
    await chmod(path.join(dir, 'ddev'), 0o755);
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  const argvSeenByDdev = async (command: string): Promise<string[]> => {
    loadDeclaredVerifyCommands.mockResolvedValue({ test: command });
    resolveDdevWorkspace.mockResolvedValue({ workspace: dir, repoSubpath: 'u/r' });
    loadPreviousStepOutput.mockResolvedValue(null);
    await mkdir(path.join(dir, '.ddev'), { recursive: true });
    await writeFile(path.join(dir, '.ddev/config.yaml'), 'name: x\n');
    const detected = await phase5VerifyStep.detect!({
      db: {},
      taskId: 't',
      workspacePath: dir,
      repoPath: dir,
      logger: { warn: vi.fn() },
    } as never);
    const slot = detected.test!;
    const shell = buildDdevCommand(dir, slot.argv.join(' '), 60_000).shell;
    const { stdout } = await execFileP('bash', ['-c', shell], {
      env: { PATH: `${dir}:${process.env.PATH}`, HOSTNAME: 'EXPANDED-BY-OUTER-SHELL', HOME: '/h' },
    });
    return stdout.split('\0').slice(0, -1);
  };

  it.each([
    [`echo 'a' "b" $HOSTNAME \`id\` # c; d \\ e`],
    ['SIMPLETEST_DB=mysql://db:db@db/db vendor/bin/phpunit -c core && echo $(whoami) | cat'],
    [`it's "ok" $((1+2)) ; rm -rf / #`],
  ])('%s', async (command) => {
    const seen = await argvSeenByDdev(command);

    expect(seen).toEqual([
      'exec',
      '--raw',
      '--',
      'timeout',
      '--kill-after=5s',
      '50s',
      'bash',
      '-c',
      command,
    ]);
    expect(seen.join('')).not.toContain('EXPANDED-BY-OUTER-SHELL');
  });
});

describe('08 notes and form for declared and turned-off slots', () => {
  const skipped = { ran: false, passed: false, command: null, output: 'skipped' };
  const results = { test: skipped, lint: skipped, typecheck: skipped };
  const cmd = { kind: 'host' as const, label: 'npm run test', argv: ['npm', 'run', 'test'] };
  const ROOT =
    'Only the workspace ROOT is searched for a package.json / composer.json script or a phpunit / pytest / phpcs / phpstan config, so a project whose tooling lives in a subdirectory reports none.';

  it('names a turned-off slot apart from an undetected one, and points at the Tooling page', () => {
    const note = buildUnverifiedNote(
      { test: null, lint: null, typecheck: null },
      results,
      [],
      ['test'],
    );
    expect(note).toBe(
      'No verification check ran this pass, so this step passing means nothing was checked — not that everything passed.\n\n' +
        `No runner was detected in this workspace for: lint, typecheck. ${ROOT} Declare commands on the repository's Tooling page.\n\n` +
        'Turned off for this repository: test.',
    );
  });

  it('adds the hint when a declared command is among the unticked slots', () => {
    const declared = { ...cmd, label: 'make test', source: 'declared' as const };
    const note = buildUnverifiedNote({ test: declared, lint: null, typecheck: cmd }, results);
    expect(note).toContain(`${ROOT} Declare commands on the repository's Tooling page.`);
    expect(note).toContain('Detected but not selected for this pass: test, typecheck.');
  });

  it('points at the Tooling page and says nothing is turned off without declared or off slots', () => {
    const plain = buildUnverifiedNote({ test: cmd, lint: null, typecheck: null }, results);
    expect(plain).toContain('Tooling page');
    expect(plain).not.toContain('Turned off');
    expect(buildUnverifiedNote({ test: cmd, lint: null, typecheck: null }, results, [], [])).toBe(
      plain,
    );
  });

  it('the form lists the slots in a code block, labelling a declared command and a turned-off slot', () => {
    const base = { workspacePath: '/w', ddevMode: false, test: cmd, lint: null, typecheck: null };
    const description = (d: Record<string, unknown>) =>
      phase5VerifyStep.form!({} as never, d as never)!.description;
    expect(description(base)).toBe(
      '```\nworkspace: /w\ntest: npm run test\nlint: none detected\ntypecheck: none detected\n```',
    );
    expect(
      description({
        ...base,
        test: { ...cmd, label: 'make test', source: 'declared' },
        offSlots: ['lint'],
      }),
    ).toBe(
      '```\nworkspace: /w\ntest: make test (declared)\nlint: turned off for this repository\ntypecheck: none detected\n```',
    );
  });

  it('fences a declared command holding markdown so it shows as typed', () => {
    const typed = 'echo ```x``` `date` && [x](http://e) **y**';
    const d = phase5VerifyStep.form!(
      {} as never,
      {
        workspacePath: '/w',
        ddevMode: false,
        test: { ...cmd, label: typed, source: 'declared' },
        lint: null,
        typecheck: null,
      } as never,
    )!.description!;
    const [open, ...rest] = d.split('\n');
    expect(open).toBe('````');
    expect(rest.at(-1)).toBe('````');
    expect(d).toContain(`test: ${typed} (declared)`);
  });
});
