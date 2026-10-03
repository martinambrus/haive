import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';

const {
  ensureAppServing,
  withDdevProgress,
  ddevExec,
  runnerHandleForTask,
  ensureDdevPlaywrightBrowsers,
  killStalePlaywrightRuns,
  recordLedgerEntry,
  collectChangedLineMap,
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
  collectChangedLineMap: vi.fn(),
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
vi.mock('./_impl-changes.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./_impl-changes.js')>()),
  collectChangedLineMap,
}));

import { TaskCancelledError } from '../../step-definition.js';
import type { ChangedFileLines, ChangedLineMap } from './_impl-changes.js';
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

describe('phase5VerifyStep.fixLoop.evaluate', () => {
  const skipped = { ran: false, passed: false, command: null, output: 'skipped' };
  const failedLint = (over: Record<string, unknown>) => ({
    ran: true,
    passed: false,
    command: 'vendor/bin/phpcs',
    output: '',
    ...over,
  });
  const diagnosisFor = (lint: unknown) =>
    phase5VerifyStep.fixLoop!.evaluate({
      test: skipped,
      lint,
      typecheck: skipped,
      passed: false,
      runtimeSmoke: null,
    } as never);

  it('gives an output stored without a scope the diagnosis it always had: its last 2000 characters', () => {
    const output = `${'a'.repeat(1500)}${'b'.repeat(2000)}`;

    expect(diagnosisFor(failedLint({ output }))).toEqual({
      blocking: true,
      diagnosis: `### lint failed (\`vendor/bin/phpcs\`)\n${'b'.repeat(2000)}`,
    });
  });

  it('hands a scoped failure over whole, since its list is already bounded and cut at whole lines', () => {
    const output = ['src/a.php:3: [ERROR] m (S.A)', 'x'.repeat(2500)].join('\n');

    expect(
      diagnosisFor(failedLint({ output, scope: { blocking: 2, preExisting: 4 } }))?.diagnosis,
    ).toBe(`### lint failed (\`vendor/bin/phpcs\`)\n${output}`);
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

  // A slot that was selected and could not run carries a note saying why, and "not selected"
  // beside it would contradict that note.
  it('does not call a slot that was selected but could not run unticked', () => {
    const notRun = {
      ran: false,
      passed: false,
      command: 'vendor/bin/phpcs',
      output: 'vendor/bin/phpcs not found — lint not run',
      note: 'vendor/bin/phpcs not found — lint not run',
    };
    const note = buildUnverifiedNote(
      { test: null, lint: cmd, typecheck: null },
      { test: skipped, lint: notRun, typecheck: skipped },
    );
    expect(note).toContain('No runner was detected in this workspace for: test, typecheck');
    expect(note).not.toContain('not selected');
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

  it('ends with the lint note, which says the lint verdict is unscoped or the lint did not run', () => {
    expect(buildVerifyDegradedNote(null, '', 'lint verdict unscoped: project script')).toBe(
      'lint verdict unscoped: project script',
    );
    const note = buildVerifyDegradedNote(
      blocker,
      'No runner was detected for: test.',
      'vendor/bin/phpcs not found — lint not run',
    );
    expect(note.endsWith('vendor/bin/phpcs not found — lint not run')).toBe(true);
    expect(note.indexOf('No runner was detected')).toBeLessThan(
      note.indexOf('vendor/bin/phpcs not found'),
    );
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
    collectChangedLineMap.mockReset().mockResolvedValue(null);
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
        note: 'DDEV runner unavailable — test not run',
      });
      expect(
        ddevExec,
        'a slot exec went through a handle no ensure returned',
      ).not.toHaveBeenCalled();
    });

    // A suite its environment stopped did run as selected; "not selected" would say otherwise.
    it('does not call a test suite its environment blocked "not selected"', async () => {
      ddevExec.mockImplementation(async (_handle: unknown, args: string) =>
        args.includes('curl')
          ? { exitCode: 0, output: 'HTTP/1.1 200 OK\r\n\r\nok\nHAIVE_HTTP_CODE=200' }
          : {
              exitCode: 1,
              output:
                "browserType.launch: Executable doesn't exist at /root/.cache/ms-playwright/chromium-1/chrome-linux/chrome",
            },
      );

      const out = await runApply(
        { test: PHPUNIT, testFramework: 'playwright' },
        { runTest: true, runLint: false, runTypecheck: false },
      );

      expect(out.test.ran).toBe(false);
      expect(out.degradedNote).toContain('NOT known to be green');
      expect(out.degradedNote).not.toContain('not selected');
    });

    // The user ticked these slots; "not selected" would say the opposite of what happened.
    it('names every slot whose runner was unavailable in the card note, and calls none of them unselected', async () => {
      ensureAppServing.mockResolvedValue({ mode: 'none', url: null });

      const out = await runApply(
        { test: PHPUNIT, lint: PHPCS, typecheck: PHPSTAN },
        { runTest: true, runLint: true, runTypecheck: true },
      );

      expect(out.degradedNote).toContain('No verification check ran this pass');
      for (const slot of ['test', 'lint', 'typecheck']) {
        expect(out.degradedNote).toContain(`DDEV runner unavailable — ${slot} not run`);
        expect(recordLedgerEntry.mock.calls[0]![3].text).toContain(
          `${slot}: DDEV runner unavailable — ${slot} not run`,
        );
      }
      expect(out.degradedNote).not.toContain('not selected');
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
        note: 'DDEV runner unavailable — test not run',
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

  it('keeps the tail of a long host check output, as the DDEV path does', async () => {
    ensureAppServing.mockResolvedValue({ mode: 'host', url: 'http://localhost' });
    const noisy = {
      kind: 'host' as const,
      label: 'noisy',
      argv: [
        process.execPath,
        '-e',
        "process.stdout.write('x'.repeat(6000) + 'END'); process.exitCode = 1",
      ],
    };

    const out = await runApply(
      { ddevMode: false, workspacePath: tmpdir(), test: noisy },
      { runTest: true },
    );

    expect(out.test.output).toHaveLength(4000);
    expect(out.test.output.endsWith('END')).toBe(true);
  });

  describe('lint limited to the lines the change wrote', () => {
    const PHPCS_HOST = buildVerifyCommand({ runner: 'phpcs' }, false)!;
    const WHOLE: ChangedFileLines = { whole: true, ranges: [] };
    const changed = (entries: Record<string, ChangedFileLines>): ChangedLineMap =>
      new Map(Object.entries(entries));
    const rangesIn = (file: string, ...r: [number, number][]) =>
      changed({ [file]: { whole: false, ranges: r } });
    const reportJson = (files: Record<string, number[]>): string =>
      JSON.stringify({
        totals: { errors: 0, warnings: 0 },
        files: Object.fromEntries(
          Object.entries(files).map(([file, lines]) => [
            file,
            {
              errors: lines.length,
              warnings: 0,
              messages: lines.map((line) => ({
                message: `Problem on line ${line}`,
                source: 'Drupal.Test.Sniff',
                severity: 5,
                fixable: false,
                type: 'ERROR',
                line,
                column: 1,
              })),
            },
          ]),
        ),
      });
    const ledgerText = (): string => recordLedgerEntry.mock.calls[0]![3].text as string;
    const evaluate = (out: unknown) => phase5VerifyStep.fixLoop!.evaluate(out as never);
    const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const REPORT_FLAG = '--report-json=';
    const FLAGGED_ARGV_LENGTH = 3;

    /** The first slot run lasts `ms` on the clock the step times its runs with. */
    function firstRunTakes(ms: number): void {
      vi.useFakeTimers({ toFake: ['performance'] });
      withDdevProgress.mockImplementationOnce((async (
        _ctx: unknown,
        _label: string,
        run: (onLine: () => void) => Promise<unknown>,
      ) => {
        try {
          return await run(() => {});
        } finally {
          vi.advanceTimersByTime(ms);
        }
      }) as never);
    }

    let workspace: string;
    beforeEach(async () => {
      workspace = await mkdtemp(path.join(tmpdir(), 'verify-lint-'));
    });
    afterEach(async () => {
      vi.useRealTimers();
      await rm(workspace, { recursive: true, force: true });
    });

    describe('on the host', () => {
      /** A `vendor/bin/phpcs` that logs its argv, then answers as told: the flagged run (one that
       *  asks for a JSON report) writes `report` where it was asked to, the plain run does not. */
      const FAKE_PHPCS = `
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync('calls.log', JSON.stringify(args) + '\\n');
const plan = JSON.parse(fs.readFileSync('fake-phpcs.json', 'utf8'));
const flag = args.find((a) => a.startsWith('${REPORT_FLAG}'));
const run = flag ? plan.flagged : plan.plain;
if (flag && typeof run.report === 'string') {
  fs.writeFileSync(flag.slice('${REPORT_FLAG}'.length), run.report);
}
process.stdout.write(run.console ?? '');
process.exitCode = run.exit;
`;
      interface Answer {
        exit: number;
        console?: string;
        report?: string;
      }
      async function installPhpcs(
        plan: { flagged: Answer; plain?: Answer },
        root = workspace,
      ): Promise<void> {
        const bin = path.join(root, 'vendor/bin/phpcs');
        await mkdir(path.dirname(bin), { recursive: true });
        await writeFile(bin, `#!${process.execPath}\n${FAKE_PHPCS}`);
        await chmod(bin, 0o755);
        await writeFile(
          path.join(root, 'fake-phpcs.json'),
          JSON.stringify({ plain: { exit: 2 }, ...plan }),
        );
      }
      const calls = async (root = workspace): Promise<string[][]> =>
        (await readFile(path.join(root, 'calls.log'), 'utf8').catch(() => ''))
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line) as string[]);
      const reportsLeft = () => readdir(path.join(workspace, '.haive/verify'));

      function lintApply(map: ChangedLineMap | null, lint = PHPCS_HOST, root = workspace) {
        collectChangedLineMap.mockResolvedValue(map);
        return runApply({ ddevMode: false, workspacePath: root, lint }, { runLint: true });
      }

      beforeEach(() => {
        ensureAppServing.mockResolvedValue({ mode: 'host', url: 'http://localhost' });
      });

      it('passes a failing phpcs whose every violation is on a line the change did not write', async () => {
        await installPhpcs({
          flagged: { exit: 2, report: reportJson({ 'src/legacy.php': [3, 4, 90] }) },
        });

        const out = await lintApply(rangesIn('src/a.php', [10, 12]));

        expect(out.lint).toEqual({
          ran: true,
          passed: true,
          command: 'vendor/bin/phpcs',
          output: '3 pre-existing violation(s) elsewhere predate this change — not blocking.',
          scope: { blocking: 0, preExisting: 3 },
        });
        expect(out.passed).toBe(true);
        expect(evaluate(out)).toBeNull();
        expect(ledgerText()).toContain(
          'lint: `vendor/bin/phpcs` passes on changed lines (3 pre-existing)',
        );
        expect(out.degradedNote).toBeUndefined();
        expect(ddevExec).not.toHaveBeenCalled();
      });

      it('asks for the JSON report under .haive/verify with the workspace as basepath, and removes it', async () => {
        await installPhpcs({
          flagged: { exit: 2, report: reportJson({ 'src/legacy.php': [3] }) },
        });

        await lintApply(rangesIn('src/a.php', [10, 12]));

        const [argv, ...rest] = await calls();
        expect(rest).toEqual([]);
        expect(argv).toHaveLength(FLAGGED_ARGV_LENGTH);
        expect(argv![0]).toBe('--report=full');
        expect(argv![1]).toMatch(
          new RegExp(
            `^${REPORT_FLAG}${escaped(workspace)}/\\.haive/verify/phpcs-[0-9a-f]{16}\\.json$`,
          ),
        );
        expect(argv![2]).toBe(`--basepath=${workspace}`);
        expect(await reportsLeft()).toEqual([]);
      });

      it('fails on the violations on lines the change wrote, and says how many it left', async () => {
        await installPhpcs({
          flagged: {
            exit: 2,
            report: reportJson({ 'src/a.php': [3, 11, 12, 90], 'src/legacy.php': [5] }),
          },
        });

        const out = await lintApply(rangesIn('src/a.php', [10, 12]));

        expect(out.lint).toEqual({
          ran: true,
          passed: false,
          command: 'vendor/bin/phpcs',
          output: [
            'src/a.php:11: [ERROR] Problem on line 11 (Drupal.Test.Sniff)',
            'src/a.php:12: [ERROR] Problem on line 12 (Drupal.Test.Sniff)',
            '3 pre-existing violation(s) elsewhere predate this change — do not edit code to clear them.',
          ].join('\n'),
          scope: { blocking: 2, preExisting: 3 },
        });
        expect(out.passed).toBe(false);
        expect(evaluate(out)).toEqual({
          blocking: true,
          diagnosis: `### lint failed (\`vendor/bin/phpcs\`)\n${out.lint.output}`,
        });
        expect(ledgerText()).toContain('lint: `vendor/bin/phpcs` FAILS on lines this change wrote');
        expect(out.degradedNote).toBeUndefined();
      });

      it('counts every line of a file only git or an agent named', async () => {
        await installPhpcs({
          flagged: { exit: 2, report: reportJson({ 'src/new.php': [1, 500] }) },
        });

        const out = await lintApply(changed({ 'src/new.php': WHOLE }));

        expect(out.lint.scope).toEqual({ blocking: 2, preExisting: 0 });
        expect(out.lint.output).toContain('src/new.php:500:');
        expect(out.lint.output).not.toContain('pre-existing');
      });

      it('passes a phpcs that exits 0 without reading any report', async () => {
        await installPhpcs({ flagged: { exit: 0 } });

        const out = await lintApply(rangesIn('src/a.php', [10, 12]));

        expect(out.lint).toEqual({
          ran: true,
          passed: true,
          command: 'vendor/bin/phpcs',
          output: '',
        });
        expect(await calls()).toHaveLength(1);
        expect(ledgerText()).toContain('lint: `vendor/bin/phpcs` passes;');
      });

      it('re-runs the original command and keeps its verdict when phpcs wrote no report', async () => {
        await installPhpcs({
          flagged: { exit: 255, console: 'PHP Fatal error: Permission denied' },
          plain: { exit: 2, console: 'FILE: src/a.php\nFOUND 1 ERROR' },
        });

        const out = await lintApply(rangesIn('src/a.php', [10, 12]));

        const all = await calls();
        expect(all).toHaveLength(2);
        expect(all[0]).toHaveLength(FLAGGED_ARGV_LENGTH);
        expect(all[1]).toEqual([]);
        expect(out.lint).toEqual({
          ran: true,
          passed: false,
          command: 'vendor/bin/phpcs',
          output: 'FILE: src/a.php\nFOUND 1 ERROR',
          note: 'lint verdict unscoped: phpcs wrote no report',
        });
        expect(out.passed).toBe(false);
        expect(out.degradedNote).toContain('lint verdict unscoped: phpcs wrote no report');
        expect(evaluate(out)?.diagnosis).toBe(
          '### lint failed (`vendor/bin/phpcs`)\nFILE: src/a.php\nFOUND 1 ERROR',
        );
      });

      it('re-runs the original command when the report is cut off, and removes what was left', async () => {
        await installPhpcs({
          flagged: { exit: 2, report: '{"files":{"src/a.php":{"messages":[{"message":"x"' },
          plain: { exit: 2, console: 'raw report' },
        });

        const out = await lintApply(rangesIn('src/a.php', [10, 12]));

        expect(await calls()).toHaveLength(2);
        expect(out.lint).toMatchObject({
          passed: false,
          output: 'raw report',
          note: 'lint verdict unscoped: the report is malformed',
        });
        expect(out.lint.scope).toBeUndefined();
        expect(await reportsLeft()).toEqual([]);
      });

      it.each([
        ['wrote no report', undefined],
        ['left a report cut off', '{"files":{"src/a.php":{"messages":[{"message":"x"'],
      ])(
        'does not re-run a flagged run that used the whole time limit and %s',
        async (_name, report) => {
          await installPhpcs({
            flagged: { exit: 1, console: 'partial console', report },
            plain: { exit: 2, console: 'raw report' },
          });
          firstRunTakes(600_000);

          const out = await lintApply(rangesIn('src/a.php', [10, 12]));

          expect(await calls()).toHaveLength(1);
          expect(out.lint).toEqual({
            ran: false,
            passed: false,
            command: 'vendor/bin/phpcs',
            output: 'partial console',
            note: 'phpcs reached its time limit — lint not verified',
          });
          expect(out.passed).toBe(true);
          expect(out.degradedNote).toContain('phpcs reached its time limit — lint not verified');
          expect(evaluate(out)).toBeNull();
          expect(await reportsLeft()).toEqual([]);
        },
      );

      it('still re-runs a flagged run that failed far inside the time limit', async () => {
        await installPhpcs({
          flagged: { exit: 255 },
          plain: { exit: 2, console: 'raw report' },
        });
        firstRunTakes(60_000);

        const out = await lintApply(rangesIn('src/a.php', [10, 12]));

        expect(await calls()).toHaveLength(2);
        expect(out.lint.note).toBe('lint verdict unscoped: phpcs wrote no report');
      });

      it('runs the original command once, unflagged, when the change could not be measured', async () => {
        await installPhpcs({
          flagged: { exit: 2, report: reportJson({ 'src/a.php': [11] }) },
          plain: { exit: 2, console: 'raw report' },
        });

        const out = await lintApply(null);

        expect(await calls()).toEqual([[]]);
        expect(out.lint).toEqual({
          ran: true,
          passed: false,
          command: 'vendor/bin/phpcs',
          output: 'raw report',
          note: 'lint verdict unscoped: the change could not be measured',
        });
      });

      it('puts no note on an unscoped lint that passes', async () => {
        await installPhpcs({ flagged: { exit: 0 }, plain: { exit: 0, console: 'clean' } });

        const out = await lintApply(null);

        expect(out.lint).toEqual({
          ran: true,
          passed: true,
          command: 'vendor/bin/phpcs',
          output: 'clean',
        });
        expect(out.degradedNote).toBeUndefined();
      });

      it('does not block, and says the lint did not run, when vendor/bin/phpcs is missing', async () => {
        const out = await lintApply(rangesIn('src/a.php', [10, 12]));

        const note = 'vendor/bin/phpcs not found — lint not run';
        expect(out.lint).toEqual({
          ran: false,
          passed: false,
          command: 'vendor/bin/phpcs',
          output: note,
          note,
        });
        expect(out.passed).toBe(true);
        expect(evaluate(out)).toBeNull();
        expect(out.degradedNote).toContain(note);
        expect(out.degradedNote).not.toContain('not selected');
        expect(ledgerText()).toContain(`lint: ${note}`);
      });

      it('treats an exit 127 from phpcs the same way, without a second run', async () => {
        await installPhpcs({ flagged: { exit: 127, console: 'env: php: not found' } });

        const out = await lintApply(rangesIn('src/a.php', [10, 12]));

        expect(out.lint).toMatchObject({
          ran: false,
          passed: false,
          note: 'vendor/bin/phpcs not found — lint not run',
        });
        expect(out.passed).toBe(true);
        expect(await calls()).toHaveLength(1);
      });

      it('runs a project lint script exactly as before, noting that its verdict is unscoped', async () => {
        const record =
          "require('node:fs').appendFileSync('calls.log', JSON.stringify(process.argv.slice(1)) + '\\n');";
        const script = (exit: number) => ({
          kind: 'host' as const,
          label: 'composer phpcs',
          argv: [process.execPath, '-e', `${record} process.exit(${exit})`],
        });

        const failing = await lintApply(rangesIn('src/a.php', [10, 12]), script(1));
        const passing = await lintApply(rangesIn('src/a.php', [10, 12]), script(0));

        expect(await calls()).toEqual([[], []]);
        expect(collectChangedLineMap).not.toHaveBeenCalled();
        expect(failing.lint).toEqual({
          ran: true,
          passed: false,
          command: 'composer phpcs',
          output: '',
          note: 'lint verdict unscoped: project script',
        });
        expect(failing.degradedNote).toContain('lint verdict unscoped: project script');
        expect(passing.lint).toEqual({
          ran: true,
          passed: true,
          command: 'composer phpcs',
          output: '',
        });
      });

      it('falls back to the unscoped verdict when the report directory cannot be made', async () => {
        await installPhpcs({ flagged: { exit: 2, report: reportJson({ 'src/a.php': [11] }) } });
        await writeFile(path.join(workspace, '.haive'), 'a file where the directory should be');

        const out = await lintApply(rangesIn('src/a.php', [10, 12]));

        expect(await calls()).toEqual([[]]);
        expect(out.lint.note).toBe(
          'lint verdict unscoped: the report directory could not be prepared',
        );
      });

      it('falls back to the unscoped verdict for a workspace path a shell command cannot carry', async () => {
        const spaced = path.join(workspace, 'with space');
        await mkdir(spaced);
        await installPhpcs(
          { flagged: { exit: 2, report: reportJson({ 'src/a.php': [11] }) } },
          spaced,
        );

        const out = await lintApply(rangesIn('src/a.php', [10, 12]), PHPCS_HOST, spaced);

        expect(await calls(spaced)).toEqual([[]]);
        expect(out.lint.note).toBe(
          'lint verdict unscoped: the report directory could not be prepared',
        );
      });

      // Root writes into a 0555 directory, so there is no unwritable directory to observe as root.
      it.skipIf(process.getuid?.() === 0)(
        'does not repair a report directory the worker cannot write, which is the unscoped fallback',
        async () => {
          await installPhpcs({
            flagged: { exit: 2, report: reportJson({ 'src/a.php': [11] }) },
            plain: { exit: 2, console: 'raw report' },
          });
          const dir = path.join(workspace, '.haive/verify');
          await mkdir(dir, { recursive: true });
          await chmod(dir, 0o555);
          try {
            const out = await lintApply(rangesIn('src/a.php', [10, 12]));

            expect(out.lint).toMatchObject({
              passed: false,
              output: 'raw report',
              note: 'lint verdict unscoped: phpcs wrote no report',
            });
          } finally {
            await chmod(dir, 0o755);
          }
        },
      );
    });

    describe('in DDEV mode', () => {
      const PHPCS = buildVerifyCommand({ runner: 'phpcs' }, true)!;
      const FLAGGED =
        /^exec vendor\/bin\/phpcs --report=full --report-json=\/var\/www\/html\/\.haive\/verify\/phpcs-[0-9a-f]{16}\.json --basepath=\/var\/www\/html$/;

      /** The container writes the report at its path; the host sees it under the workspace. */
      function runnerAnswers(plan: { flagged: [number, string | null]; plain?: [number, string] }) {
        ddevExec.mockImplementation(async (_handle: unknown, args: string) => {
          if (args.includes('curl')) {
            return { exitCode: 0, output: 'HTTP/1.1 200 OK\r\n\r\nok\nHAIVE_HTTP_CODE=200' };
          }
          const target = /--report-json=(\S+)/.exec(args)?.[1];
          if (target === undefined)
            return { exitCode: plan.plain?.[0] ?? 2, output: plan.plain?.[1] ?? '' };
          const [exitCode, report] = plan.flagged;
          if (report !== null) await writeFile(target.replace('/var/www/html', workspace), report);
          return { exitCode, output: 'console report' };
        });
      }

      function lintApply(map: ChangedLineMap | null) {
        collectChangedLineMap.mockResolvedValue(map);
        return runApply({ workspacePath: workspace, lint: PHPCS }, { runLint: true });
      }

      it('asks the container for the report at the project mount and scopes what it wrote', async () => {
        runnerAnswers({
          flagged: [2, reportJson({ 'src/a.php': [11], 'src/legacy.php': [3, 4] })],
        });

        const out = await lintApply(rangesIn('src/a.php', [10, 12]));

        expect(slotExecs().map((c) => c[1])).toEqual([expect.stringMatching(FLAGGED)]);
        expect(out.lint).toMatchObject({
          ran: true,
          passed: false,
          command: 'ddev exec vendor/bin/phpcs',
          scope: { blocking: 1, preExisting: 2 },
        });
        expect(out.lint.output).toContain('src/a.php:11: [ERROR] Problem on line 11');
        expect(await readdir(path.join(workspace, '.haive/verify'))).toEqual([]);
      });

      it('passes when only pre-existing violations remain', async () => {
        runnerAnswers({ flagged: [2, reportJson({ 'src/legacy.php': [3, 4] })] });

        const out = await lintApply(rangesIn('src/a.php', [10, 12]));

        expect(out.lint).toMatchObject({
          ran: true,
          passed: true,
          scope: { blocking: 0, preExisting: 2 },
        });
        expect(out.passed).toBe(true);
      });

      it('does not block, and says the lint did not run, on exit 127', async () => {
        runnerAnswers({ flagged: [127, null] });

        const out = await lintApply(rangesIn('src/a.php', [10, 12]));

        expect(out.lint).toMatchObject({
          ran: false,
          note: 'vendor/bin/phpcs not found — lint not run',
        });
        expect(out.passed).toBe(true);
        expect(slotExecs()).toHaveLength(1);
      });

      it('re-runs exactly the original command when the container wrote no report', async () => {
        runnerAnswers({ flagged: [255, null], plain: [2, 'raw report'] });

        const out = await lintApply(rangesIn('src/a.php', [10, 12]));

        expect(slotExecs().map((c) => c[1])).toEqual([
          expect.stringMatching(FLAGGED),
          'exec vendor/bin/phpcs',
        ]);
        expect(out.lint).toMatchObject({
          passed: false,
          output: 'raw report',
          note: 'lint verdict unscoped: phpcs wrote no report',
        });
      });

      it('does not re-run a flagged run that used the whole time limit', async () => {
        runnerAnswers({ flagged: [1, null], plain: [2, 'raw report'] });
        firstRunTakes(600_000);

        const out = await lintApply(rangesIn('src/a.php', [10, 12]));

        expect(slotExecs().map((c) => c[1])).toEqual([expect.stringMatching(FLAGGED)]);
        expect(out.lint).toEqual({
          ran: false,
          passed: false,
          command: 'ddev exec vendor/bin/phpcs',
          output: 'console report',
          note: 'phpcs reached its time limit — lint not verified',
        });
      });

      it('reports the runner as unavailable without measuring the change or making a directory', async () => {
        ensureAppServing.mockResolvedValue({ mode: 'none', url: null });

        const out = await lintApply(rangesIn('src/a.php', [10, 12]));

        expect(out.lint).toEqual({
          ran: false,
          passed: false,
          command: PHPCS.label,
          output: UNAVAILABLE,
          note: 'DDEV runner unavailable — lint not run',
        });
        expect(collectChangedLineMap).not.toHaveBeenCalled();
        expect(await readdir(workspace)).toEqual([]);
      });
    });
  });
});
