import { beforeEach, describe, it, expect, vi } from 'vitest';

const { ensureAppServing } = vi.hoisted(() => ({ ensureAppServing: vi.fn() }));

// withDdevProgress must be a real passthrough, not a stub: runSlot wraps every check in it,
// so a mock that omits it makes the module throw the moment a test reaches a slot.
vi.mock('./_app-runtime.js', () => ({
  ensureAppServing,
  withDdevProgress: <T>(_ctx: unknown, _label: string, run: (onLine: (l: string) => void) => T) =>
    run(() => {}),
}));

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
