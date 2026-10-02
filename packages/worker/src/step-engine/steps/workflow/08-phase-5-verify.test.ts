import { tmpdir } from 'node:os';
import { beforeEach, describe, it, expect, vi } from 'vitest';

const {
  ensureAppServing,
  withDdevProgress,
  ddevExec,
  runnerHandleForTask,
  ensureDdevPlaywrightBrowsers,
  killStalePlaywrightRuns,
  recordLedgerEntry,
} = vi.hoisted(() => ({
  ensureAppServing: vi.fn(),
  withDdevProgress: vi.fn(
    <T>(_ctx: unknown, _label: string, run: (onLine: (l: string) => void) => T) => run(() => {}),
  ),
  ddevExec: vi.fn(),
  runnerHandleForTask: vi.fn(),
  ensureDdevPlaywrightBrowsers: vi.fn(),
  killStalePlaywrightRuns: vi.fn(),
  recordLedgerEntry: vi.fn(),
}));

// withDdevProgress must be a real passthrough, not a stub: runSlot wraps every check in it,
// so a mock that omits it makes the module throw the moment a test reaches a slot.
vi.mock('./_app-runtime.js', () => ({ ensureAppServing, withDdevProgress }));
vi.mock('../../../sandbox/ddev-runner.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../sandbox/ddev-runner.js')>()),
  runnerHandleForTask,
  ddevExec,
}));
vi.mock('../../../sandbox/ddev-playwright.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../sandbox/ddev-playwright.js')>()),
  ensureDdevPlaywrightBrowsers,
  killStalePlaywrightRuns,
}));
vi.mock('../../task-ledger.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../task-ledger.js')>()),
  recordLedgerEntry,
}));

import { TaskCancelledError } from '../../step-definition.js';
import {
  buildUnverifiedNote,
  buildVerifyDegradedNote,
  buildVerifyCommand,
  parseRuntimeSmokeOutput,
  phase5VerifyStep,
  runRuntimeSmoke,
} from './08-phase-5-verify.js';

const smokeCtx = {
  logger: { info: vi.fn(), warn: vi.fn() },
} as never;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('buildVerifyCommand', () => {
  it('builds host pm-script commands (JS, always host)', () => {
    expect(buildVerifyCommand({ runner: 'pm', pm: 'pnpm', script: 'test' }, false)).toEqual({
      kind: 'host',
      label: 'pnpm run test',
      argv: ['pnpm', 'run', 'test'],
    });
    // ddevMode does not move JS scripts into ddev
    expect(buildVerifyCommand({ runner: 'pm', pm: 'npm', script: 'lint' }, true)?.kind).toBe(
      'host',
    );
  });

  it('returns null for pm runner without a package manager or script', () => {
    expect(buildVerifyCommand({ runner: 'pm', pm: 'none', script: 'test' }, false)).toBeNull();
    expect(buildVerifyCommand({ runner: 'pm', pm: 'pnpm' }, false)).toBeNull();
  });

  it('routes composer scripts through ddev when ddevMode, else host', () => {
    expect(buildVerifyCommand({ runner: 'composer', script: 'phpcs' }, true)).toEqual({
      kind: 'ddev',
      label: 'ddev composer phpcs',
      argv: ['composer', 'phpcs'],
    });
    expect(buildVerifyCommand({ runner: 'composer', script: 'test' }, false)).toEqual({
      kind: 'host',
      label: 'composer test',
      argv: ['composer', 'test'],
    });
  });

  it('builds phpunit / phpcs / phpstan / pytest binaries, ddev vs host', () => {
    expect(buildVerifyCommand({ runner: 'phpunit' }, true)).toEqual({
      kind: 'ddev',
      label: 'ddev exec vendor/bin/phpunit',
      argv: ['exec', 'vendor/bin/phpunit'],
    });
    expect(buildVerifyCommand({ runner: 'phpcs' }, false)).toEqual({
      kind: 'host',
      label: 'vendor/bin/phpcs',
      argv: ['vendor/bin/phpcs'],
    });
    expect(buildVerifyCommand({ runner: 'phpstan' }, true)).toEqual({
      kind: 'ddev',
      label: 'ddev exec vendor/bin/phpstan analyse',
      argv: ['exec', 'vendor/bin/phpstan', 'analyse'],
    });
    expect(buildVerifyCommand({ runner: 'pytest' }, false)).toEqual({
      kind: 'host',
      label: 'pytest',
      argv: ['pytest'],
    });
  });
});

describe('parseRuntimeSmokeOutput', () => {
  it('passes a clean 200 response', () => {
    const r = parseRuntimeSmokeOutput(
      'HTTP/1.1 200 OK\r\nContent-Type: text/html\r\n\r\n<html><body>Welcome</body></html>',
    );
    expect(r).toEqual({
      ran: true,
      passed: true,
      httpStatus: 200,
      errorExcerpt: expect.any(String),
    });
  });

  it('fails a 200 page that renders a DB-connection error in the body', () => {
    const raw = [
      'HTTP/1.1 200 OK',
      'Content-Type: text/html',
      '',
      'An Error Has Occured',
      'There has been a problem found while trying to connect to a database. Connection was refused.',
      'File = /var/www/html/database.php  Line = 72',
      'Extra Message = No such file or directory',
    ].join('\n');
    const r = parseRuntimeSmokeOutput(raw);
    expect(r.ran).toBe(true);
    expect(r.passed).toBe(false);
    expect(r.httpStatus).toBe(200);
    expect(r.errorExcerpt).toContain('Connection was refused');
  });

  it('fails on a 5xx status even with a clean body', () => {
    expect(
      parseRuntimeSmokeOutput('HTTP/1.1 503 Service Unavailable\r\n\r\nupstream down').passed,
    ).toBe(false);
  });

  it('fails on a PHP fatal error in the body', () => {
    const r = parseRuntimeSmokeOutput(
      'HTTP/1.1 200 OK\n\nFatal error: Uncaught Error: Call to undefined function mysql_pconnect()',
    );
    expect(r.passed).toBe(false);
  });

  it('uses the final status code across a redirect chain', () => {
    const raw = 'HTTP/1.1 301 Moved Permanently\r\nLocation: /x\r\n\r\nHTTP/1.1 200 OK\r\n\r\nok';
    const r = parseRuntimeSmokeOutput(raw);
    expect(r.httpStatus).toBe(200);
    expect(r.passed).toBe(true);
  });

  it('reports ran:false when the probe binary is missing', () => {
    const r = parseRuntimeSmokeOutput('bash: curl: command not found');
    expect(r.ran).toBe(false);
    expect(r.passed).toBe(false);
    expect(r.httpStatus).toBeNull();
  });

  it('fails when curl ran but got no HTTP response (app down)', () => {
    const r = parseRuntimeSmokeOutput(
      'curl: (7) Failed to connect to 127.0.0.1 port 80: Connection refused',
    );
    expect(r.ran).toBe(true);
    expect(r.passed).toBe(false);
    expect(r.httpStatus).toBeNull();
  });

  // Regression: a large response body pushes the head `HTTP/… NNN` status line out of
  // ddevExec's 8000-char tail-slice, leaving only body. The `-w` marker (appended after
  // the body) must still yield the status — otherwise it reads as a false "no response".
  it('reads the status from the tail marker when the head status line was truncated', () => {
    const bodyOnly = '<html><body>Installer step 1</body></html>HAIVE_HTTP_CODE=200';
    const r = parseRuntimeSmokeOutput(bodyOnly);
    expect(r.ran).toBe(true);
    expect(r.passed).toBe(true);
    expect(r.httpStatus).toBe(200);
    // The sentinel must not leak into the human-facing excerpt.
    expect(r.errorExcerpt).not.toContain('HAIVE_HTTP_CODE');
    expect(r.errorExcerpt).toContain('</html>');
  });

  it('still fails when the truncated body carries a fatal even with a 200 marker', () => {
    const r = parseRuntimeSmokeOutput(
      'Fatal error: Uncaught Error: Call to undefined function foo()\nHAIVE_HTTP_CODE=200',
    );
    expect(r.passed).toBe(false);
    expect(r.httpStatus).toBe(200);
  });

  it('prefers the marker over a stale head status line', () => {
    const raw =
      'HTTP/1.1 500 Internal Server Error\r\n\r\n<html>retry ok</html>HAIVE_HTTP_CODE=200';
    const r = parseRuntimeSmokeOutput(raw);
    expect(r.httpStatus).toBe(200);
    expect(r.passed).toBe(true);
  });
});

describe('runRuntimeSmoke', () => {
  it('fails a DDEV boot error instead of recording it as a non-blocking smoke miss', async () => {
    ensureAppServing.mockRejectedValueOnce(
      new Error('ddev start failed: version constraint is incompatible'),
    );

    await expect(runRuntimeSmoke(smokeCtx, { failOnDdevBootError: true })).rejects.toThrow(
      'DDEV environment could not start for runtime verification: ddev start failed',
    );
  });

  it('keeps non-DDEV runtime boot errors as an advisory smoke result', async () => {
    ensureAppServing.mockRejectedValueOnce(new Error('host runtime unavailable'));

    await expect(runRuntimeSmoke(smokeCtx)).resolves.toMatchObject({
      ran: false,
      passed: false,
      httpStatus: null,
      errorExcerpt: 'Runtime smoke could not run: host runtime unavailable',
    });
  });

  // Without failOnDdevBootError a boot error is recorded as "not probed", but a Stop is no boot error:
  // the step runner tells it apart only by `instanceof TaskCancelledError`.
  describe('without failOnDdevBootError, a Stop during the boot', () => {
    const smoke = () => runRuntimeSmoke(smokeCtx, { failOnDdevBootError: false });
    const rejection = (run: () => Promise<unknown>) =>
      run().then(
        () => null,
        (e: unknown) => e,
      );

    it('stays a cancel, whatever message it carries', async () => {
      const cancel = new TaskCancelledError('stopped from the task page');
      ensureAppServing.mockRejectedValueOnce(cancel);

      const err = await rejection(smoke);

      expect(ensureAppServing, 'the smoke never reached the runtime ensure').toHaveBeenCalledTimes(
        1,
      );
      expect(err, 'the cancel was recorded as a smoke that could not run').not.toBeNull();
      expect(err, 'the cancel was replaced by another error').toBe(cancel);
    });

    it('still records an ordinary error that only says the task was cancelled as not probed', async () => {
      ensureAppServing.mockRejectedValueOnce(new Error('task cancelled'));

      await expect(smoke()).resolves.toEqual({
        ran: false,
        passed: false,
        httpStatus: null,
        url: null,
        errorExcerpt: expect.stringContaining('task cancelled'),
      });
    });
  });
});

describe('phase5VerifyStep.fixLoopOnError', () => {
  const route = (msg: string) => (phase5VerifyStep.fixLoopOnError as (m: string) => boolean)(msg);

  it('routes an agent-authored .ddev defect back to implementation THROUGH the wrapper', () => {
    // runRuntimeSmoke wraps the boot error in its own sentence, so the classifier only
    // still fires because it matches on a substring. That is the property under test.
    expect(
      route(
        'DDEV environment could not start for runtime verification: DDEV cannot start: ' +
          'DDEV config is not valid YAML: .ddev/config.yaml cannot be parsed — Nested ' +
          'mappings are not allowed in compact mappings at line 14, column 13.',
      ),
    ).toBe(true);
  });

  it('leaves a host-level boot failure on the hard-fail path', () => {
    expect(
      route(
        'DDEV environment could not start for runtime verification: ddev start failed: ' +
          "your DDEV version 'v1.25.3' doesn't meet the constraint '= v1.24.8'",
      ),
    ).toBe(false);
  });
});

describe('buildUnverifiedNote', () => {
  const cmd = { kind: 'host' as const, label: 'pnpm run test', argv: ['pnpm', 'run', 'test'] };
  const ran = { ran: true, passed: true, command: 'pnpm run test', output: '' };
  const skipped = { ran: false, passed: false, command: null, output: 'skipped' };

  // `passed` is "nothing that ran failed", so three skipped slots produce the same true a
  // fully green run produces — and gate 2 reads that as allPassed.
  it('names the slots that had no runner at all', () => {
    const note = buildUnverifiedNote(
      { test: null, lint: null, typecheck: null },
      { test: skipped, lint: skipped, typecheck: skipped },
    );
    expect(note).toContain('No verification check ran this pass');
    expect(note).toContain('test, lint, typecheck');
    expect(note).toContain('subdirectory');
    expect(note).not.toContain('not selected');
  });

  // "no runner exists" and "you unticked it" are different facts; only the first is nobody's
  // decision, so the note keeps them apart.
  it('separates undetected slots from unticked ones', () => {
    const note = buildUnverifiedNote(
      { test: cmd, lint: null, typecheck: null },
      { test: skipped, lint: skipped, typecheck: skipped },
    );
    expect(note).toContain('lint, typecheck');
    expect(note).toContain('Detected but not selected for this pass: test');
  });

  it('says nothing once any check actually ran', () => {
    expect(
      buildUnverifiedNote(
        { test: cmd, lint: null, typecheck: null },
        { test: ran, lint: skipped, typecheck: skipped },
      ),
    ).toBe('');
  });

  // A check that ran and FAILED is a failure, not an absence — it has its own route (fixLoop)
  // and must not also be reported as unverified.
  it('says nothing when a check ran and failed', () => {
    expect(
      buildUnverifiedNote(
        { test: cmd, lint: null, typecheck: null },
        { test: { ...ran, passed: false }, lint: skipped, typecheck: skipped },
      ),
    ).toBe('');
  });
});

// This step's fixLoop routes ANY failing check back to implementation, so an environment
// failure it cannot name burns a whole round on something no agent can repair — the same
// failure 08b's guard exists for.
describe('buildVerifyDegradedNote', () => {
  const blocker = {
    reason: 'the browser binaries are not installed',
    repair: 'npx playwright install --with-deps',
  };

  it('names the blocker and the repair, and says the suite is not green', () => {
    const note = buildVerifyDegradedNote(blocker, '');
    expect(note).toContain('the browser binaries are not installed');
    expect(note).toContain('npx playwright install --with-deps');
    expect(note).toContain('NOT known to be green');
  });

  it('joins both halves, blocker first — a blocker is itself a reason nothing ran', () => {
    const note = buildVerifyDegradedNote(blocker, 'No runner was detected for: lint.');
    expect(note.indexOf('could not be run')).toBeLessThan(note.indexOf('No runner was detected'));
    expect(note).toContain('No runner was detected for: lint.');
  });

  it('passes the unverified note through untouched when nothing is blocked', () => {
    expect(buildVerifyDegradedNote(null, 'No runner was detected for: test.')).toBe(
      'No runner was detected for: test.',
    );
  });

  it('is empty on the green path', () => {
    expect(buildVerifyDegradedNote(null, '')).toBe('');
  });
});

// The slots (test, lint, typecheck) exec into the task's DDEV runner. A runner gone since 01c reads
// as a failing check, which spends a fix round on "No such container", so the runtime is ensured first.
describe('phase5VerifyStep.apply', () => {
  const RAW = { container: 'haive-ddev-raw', projectDir: '/repos/u/r' };
  const ENSURED = { container: 'haive-ddev-ensured', projectDir: '/repos/u/r' };
  const DDEV_RUNTIME = { mode: 'ddev', url: 'http://r.ddev.site', handle: ENSURED };
  const PHPUNIT = buildVerifyCommand({ runner: 'phpunit' }, true)!;
  const PHPCS = buildVerifyCommand({ runner: 'phpcs' }, true)!;
  const PHPSTAN = buildVerifyCommand({ runner: 'phpstan' }, true)!;
  const HOST_CHECK = {
    kind: 'host' as const,
    label: 'node -e 0',
    argv: [process.execPath, '-e', '0'],
  };
  const UNAVAILABLE = 'DDEV runner unavailable — skipped';
  const applyCtx = {
    taskId: 'task-1',
    taskStepId: 'step-1',
    round: 0,
    db: {},
    logger: { info: vi.fn(), warn: vi.fn() },
  } as never;
  const route = (msg: string) => (phase5VerifyStep.fixLoopOnError as (m: string) => boolean)(msg);

  function runApply(detected: Record<string, unknown>, formValues: Record<string, boolean>) {
    return phase5VerifyStep.apply(applyCtx, {
      detected: {
        workspacePath: '/repos/u/r',
        ddevMode: true,
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
  }

  const slotExecs = () => ddevExec.mock.calls.filter((c) => !String(c[1]).includes('curl'));

  beforeEach(() => {
    runnerHandleForTask.mockReset().mockReturnValue(RAW);
    ensureAppServing.mockReset().mockResolvedValue(DDEV_RUNTIME);
    ddevExec
      .mockReset()
      .mockImplementation(async (_handle: unknown, args: string) =>
        args.includes('curl')
          ? { exitCode: 0, output: 'HTTP/1.1 200 OK\r\n\r\nok\nHAIVE_HTTP_CODE=200' }
          : { exitCode: 0, output: 'ok' },
      );
    ensureDdevPlaywrightBrowsers
      .mockReset()
      .mockResolvedValue({ attempted: true, ok: true, note: null });
    killStalePlaywrightRuns.mockReset().mockResolvedValue(0);
    recordLedgerEntry.mockReset().mockResolvedValue(undefined);
  });

  describe('in DDEV mode, ensures the runtime before a check execs into it', () => {
    it('ensures the runtime before the first slot exec', async () => {
      await runApply({ test: PHPUNIT }, { runTest: true });

      const ensureAt = ensureAppServing.mock.invocationCallOrder[0];
      const firstExecAt = ddevExec.mock.invocationCallOrder[0];
      expect(ensureAt, 'the runtime was never ensured').toBeDefined();
      expect(firstExecAt, 'no check exec ran').toBeDefined();
      expect(ensureAt!, 'the first exec ran before the runtime was ensured').toBeLessThan(
        firstExecAt!,
      );
    });

    it('runs every slot on the handle the ensure returned', async () => {
      await runApply(
        { test: PHPUNIT, lint: PHPCS, typecheck: PHPSTAN },
        { runTest: true, runLint: true, runTypecheck: true },
      );

      expect(slotExecs().map((c) => c[1])).toEqual([
        'exec vendor/bin/phpunit',
        'exec vendor/bin/phpcs',
        'exec vendor/bin/phpstan analyse',
      ]);
      expect(slotExecs().map((c) => c[0].container)).toEqual([
        ENSURED.container,
        ENSURED.container,
        ENSURED.container,
      ]);
    });

    it('hands the ensured handle to both playwright helpers', async () => {
      await runApply({ test: PHPUNIT, testFramework: 'playwright' }, { runTest: true });

      expect(ensureDdevPlaywrightBrowsers).toHaveBeenCalledTimes(1);
      expect(killStalePlaywrightRuns).toHaveBeenCalledTimes(1);
      expect(ensureDdevPlaywrightBrowsers.mock.calls[0]![0].container).toBe(ENSURED.container);
      expect(killStalePlaywrightRuns.mock.calls[0]![0].container).toBe(ENSURED.container);
    });

    it('provisions playwright only after the runtime is ensured', async () => {
      await runApply({ test: PHPUNIT, testFramework: 'playwright' }, { runTest: true });

      const ensureAt = ensureAppServing.mock.invocationCallOrder[0]!;
      expect(
        ensureDdevPlaywrightBrowsers.mock.invocationCallOrder[0]!,
        'the browsers were provisioned before the runtime was ensured',
      ).toBeGreaterThan(ensureAt);
      expect(
        killStalePlaywrightRuns.mock.invocationCallOrder[0]!,
        'stale runs were swept before the runtime was ensured',
      ).toBeGreaterThan(ensureAt);
    });

    it('fails the step at a boot failure, before any slot or helper execs', async () => {
      ensureAppServing.mockRejectedValueOnce(new Error('DDEV cannot start: boot failed'));

      await expect(
        runApply({ test: PHPUNIT, testFramework: 'playwright' }, { runTest: true }),
      ).rejects.toThrow(/boot failed/);

      expect(ddevExec, 'a slot ran against a runtime that never booted').not.toHaveBeenCalled();
      expect(ensureDdevPlaywrightBrowsers).not.toHaveBeenCalled();
      expect(killStalePlaywrightRuns).not.toHaveBeenCalled();
    });

    it('reports a slot as unavailable when the ensured runtime is not a ddev runner', async () => {
      ensureAppServing.mockResolvedValue({ mode: 'none', url: null });

      const out = await runApply({ test: PHPUNIT }, { runTest: true });

      expect(out.test).toEqual({
        ran: false,
        passed: false,
        command: PHPUNIT.label,
        output: UNAVAILABLE,
      });
      expect(
        ddevExec,
        'a slot exec went through a handle no ensure returned',
      ).not.toHaveBeenCalled();
    });
  });

  describe('what the earlier ensure leaves as it was', () => {
    // The checks can run for minutes, and a runner reclaimed or recreated meanwhile must not leave
    // the smoke probing the handle from before them: gate 2 reads a failed smoke as a reject.
    it('ensures again right before the smoke, which probes the runner as it is then', async () => {
      const REPLACED = { container: 'haive-ddev-replaced', projectDir: '/repos/u/r' };
      ensureAppServing
        .mockResolvedValueOnce(DDEV_RUNTIME)
        .mockResolvedValueOnce({ ...DDEV_RUNTIME, handle: REPLACED });

      await runApply(
        { test: PHPUNIT, lint: PHPCS, typecheck: PHPSTAN },
        { runTest: true, runLint: true, runTypecheck: true },
      );

      expect(ensureAppServing).toHaveBeenCalledTimes(2);
      expect(new Set(slotExecs().map((c) => c[0].container))).toEqual(new Set([ENSURED.container]));
      const probe = ddevExec.mock.calls.find((c) => String(c[1]).includes('curl'));
      expect(probe?.[0].container, 'the smoke probed the handle from before the checks').toBe(
        REPLACED.container,
      );
    });

    it('probes the smoke through the ensured runtime and reports its url', async () => {
      const out = await runApply({ test: PHPUNIT }, { runTest: true });

      const probe = ddevExec.mock.calls.find((c) => String(c[1]).includes('curl'));
      expect(probe?.[0].container).toBe(ENSURED.container);
      expect(out.runtimeSmoke).toMatchObject({
        ran: true,
        passed: true,
        httpStatus: 200,
        url: 'http://r.ddev.site',
      });
    });

    it.each([
      [
        'an agent-authored .ddev defect',
        'DDEV cannot start: DDEV config is not valid YAML: .ddev/config.yaml cannot be parsed — ' +
          'Nested mappings are not allowed in compact mappings at line 14, column 13.',
        true,
      ],
      [
        'a host-level failure',
        "ddev start failed: your DDEV version 'v1.25.3' doesn't meet the constraint '= v1.24.8'",
        false,
      ],
    ])('routes %s the way the smoke wrapper did', async (_name, cause, routed) => {
      ensureAppServing.mockRejectedValue(new Error(cause));

      const err = await runApply({ test: PHPUNIT }, { runTest: true }).then(
        () => null,
        (e: unknown) => e as Error,
      );

      expect(err?.message).toBe(
        `DDEV environment could not start for runtime verification: ${cause}`,
      );
      expect(route(err!.message)).toBe(routed);
    });

    it('keeps a non-DDEV boot failure advisory', async () => {
      ensureAppServing.mockRejectedValue(new Error('host runtime unavailable'));

      const out = await runApply({ ddevMode: false }, {});

      expect(out.runtimeSmoke).toMatchObject({
        ran: false,
        passed: false,
        errorExcerpt: 'Runtime smoke could not run: host runtime unavailable',
      });
    });

    it('in non-DDEV mode ensures once, after the host checks, and execs into no ddev runner', async () => {
      ensureAppServing.mockResolvedValue({ mode: 'host', url: 'http://localhost' });

      const out = await runApply(
        { ddevMode: false, workspacePath: tmpdir(), test: HOST_CHECK },
        { runTest: true },
      );

      expect(out.test).toMatchObject({ ran: true, passed: true });
      expect(ensureAppServing).toHaveBeenCalledTimes(1);
      expect(
        withDdevProgress.mock.invocationCallOrder[0]!,
        'the host check ran after the runtime was ensured',
      ).toBeLessThan(ensureAppServing.mock.invocationCallOrder[0]!);
      expect(ddevExec).not.toHaveBeenCalled();
    });

    it('reports a slot as unavailable when the ensure finds no runtime', async () => {
      ensureAppServing.mockResolvedValue({ mode: 'none', url: null });

      const out = await runApply({ test: PHPUNIT }, { runTest: true });

      expect(out.test).toEqual({
        ran: false,
        passed: false,
        command: PHPUNIT.label,
        output: UNAVAILABLE,
      });
      expect(ddevExec).not.toHaveBeenCalled();
    });

    it.each([
      ['no playwright test framework', { testFramework: null }, { runTest: true }],
      ['the test slot unticked', { testFramework: 'playwright' }, { runTest: false }],
    ])('does not provision playwright with %s', async (_name, detected, formValues) => {
      await runApply({ test: PHPUNIT, ...detected }, formValues);

      expect(ensureDdevPlaywrightBrowsers).not.toHaveBeenCalled();
      expect(killStalePlaywrightRuns).not.toHaveBeenCalled();
    });
  });

  // The step runner tells a Stop from a failure only by `instanceof TaskCancelledError`, so the boot
  // wrapper must not turn a cancel into the plain Error it makes of every other boot failure.
  describe('a Stop during the boot stays a cancel', () => {
    const smoke = () => runRuntimeSmoke(smokeCtx, { failOnDdevBootError: true });
    const apply = () => runApply({ test: PHPUNIT }, { runTest: true });
    const rejection = (run: () => Promise<unknown>) =>
      run().then(
        () => null,
        (e: unknown) => e,
      );

    it('runRuntimeSmoke rethrows the cancel as it is, whatever message it carries', async () => {
      const cancel = new TaskCancelledError('stopped from the task page');
      ensureAppServing.mockRejectedValueOnce(cancel);

      expect(await rejection(smoke), 'the cancel was rewrapped as a boot failure').toBe(cancel);
    });

    it('apply lets the cancel out of the earlier ensure as it is, before any slot execs', async () => {
      const cancel = new TaskCancelledError('stopped from the task page');
      ensureAppServing.mockRejectedValueOnce(cancel);

      expect(await rejection(apply), 'the cancel was rewrapped as a boot failure').toBe(cancel);
      expect(ddevExec, 'a slot ran against a runtime that never booted').not.toHaveBeenCalled();
    });

    it.each([
      ['runRuntimeSmoke', smoke],
      ['apply', apply],
    ])('%s still rewraps an ordinary error that only mentions a cancel', async (_name, run) => {
      ensureAppServing.mockRejectedValueOnce(new Error('task cancelled'));

      const err = (await rejection(run)) as Error;

      expect(err).not.toBeInstanceOf(TaskCancelledError);
      expect(err.message).toBe(
        'DDEV environment could not start for runtime verification: task cancelled',
      );
    });
  });
});
