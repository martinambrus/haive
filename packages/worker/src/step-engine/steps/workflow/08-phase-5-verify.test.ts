import { beforeEach, describe, it, expect, vi } from 'vitest';

const { ensureAppServing } = vi.hoisted(() => ({ ensureAppServing: vi.fn() }));

vi.mock('./_app-runtime.js', () => ({ ensureAppServing }));

import {
  buildVerifyCommand,
  parseRuntimeSmokeOutput,
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
