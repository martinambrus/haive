import { describe, expect, it } from 'vitest';
import {
  formatCliErrorMessage,
  interpretCliFailure,
  type ExecutionOutcome,
} from '../src/queues/cli-exec-queue.js';

function outcome(partial: Partial<ExecutionOutcome>): ExecutionOutcome {
  return {
    exitCode: 1,
    rawOutput: null,
    parsedOutput: null,
    errorMessage: null,
    ...partial,
  };
}

describe('interpretCliFailure', () => {
  it('returns existing message unchanged on exit 0', () => {
    expect(interpretCliFailure(outcome({ exitCode: 0, errorMessage: 'x' }), 'claude-code')).toBe(
      'x',
    );
  });

  it('detects 401 in raw stdout and suggests claude /login', () => {
    const result = outcome({
      rawOutput:
        'Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error"}}',
    });
    const msg = interpretCliFailure(result, 'claude-code');
    expect(msg).toMatch(/CLI authentication failed/);
    expect(msg).toMatch(/claude \/login/);
  });

  it('detects "Invalid authentication credentials"', () => {
    const result = outcome({ errorMessage: 'Invalid authentication credentials' });
    const msg = interpretCliFailure(result, 'codex');
    expect(msg).toMatch(/codex login/);
  });

  it('points gemini at the GEMINI_API_KEY secret instead of a CLI login', () => {
    const result = outcome({ rawOutput: 'Unauthorized 401' });
    const msg = interpretCliFailure(result, 'gemini');
    expect(msg).toMatch(/CLI authentication failed/);
    expect(msg).toMatch(/GEMINI_API_KEY/);
    expect(msg).not.toMatch(/gemini auth login/);
  });

  it('falls back to generic hint when provider name is null', () => {
    const result = outcome({ rawOutput: 'Unauthorized' });
    const msg = interpretCliFailure(result, null);
    expect(msg).toMatch(/re-authenticate/);
  });

  it('headlines a rate-limit / quota failure as a fatal provider error', () => {
    const result = outcome({ errorMessage: 'rate limit exceeded' });
    const msg = interpretCliFailure(result, 'claude-code');
    expect(msg).toMatch(/Provider rate limit or quota exhausted/);
    expect(msg).toMatch(/rate limit exceeded/); // original detail preserved in the excerpt
  });

  it('headlines a 5xx server outage as a fatal provider error', () => {
    const result = outcome({ rawOutput: 'API Error: 503 Service Unavailable' });
    const msg = interpretCliFailure(result, 'claude-code');
    expect(msg).toMatch(/Provider server error/);
  });

  it('leaves an ordinary (non-fatal) failure untouched', () => {
    const result = outcome({ errorMessage: 'TypeError: x is not a function' });
    expect(interpretCliFailure(result, 'claude-code')).toBe('TypeError: x is not a function');
  });

  it('treats a killed process (exit 137) as stopped, not auth — even with auth-looking output', () => {
    const result = outcome({
      exitCode: 137,
      rawOutput: 'analysis: the CMS login flow returns 401 Unauthorized when the token is invalid',
    });
    const msg = interpretCliFailure(result, 'claude-code');
    expect(msg).toMatch(/stopped before it finished/);
    expect(msg).not.toMatch(/authentication failed/i);
    expect(msg).not.toMatch(/claude \/login/);
  });

  it('treats a null exit code (timeout/abort) as stopped', () => {
    const result = outcome({ exitCode: null, rawOutput: 'please login again' });
    expect(interpretCliFailure(result, 'claude-code')).toMatch(/stopped before it finished/);
  });

  it('treats SIGTERM (exit 143) as stopped', () => {
    expect(interpretCliFailure(outcome({ exitCode: 143 }), 'codex')).toMatch(/stopped/);
  });

  it('caps the auth detail excerpt instead of dumping the whole blob', () => {
    const result = outcome({
      exitCode: 1,
      errorMessage: 'authentication_error ' + 'y'.repeat(2000),
    });
    const msg = interpretCliFailure(result, 'claude-code');
    expect(msg).toMatch(/CLI authentication failed/);
    expect(msg!.length).toBeLessThan(500);
  });
});

describe('formatCliErrorMessage', () => {
  it('returns null on exit 0 without spawn error', () => {
    expect(formatCliErrorMessage(0, '', '', undefined)).toBeNull();
  });

  it('returns spawn error regardless of exit code', () => {
    expect(formatCliErrorMessage(0, 'ignored', 'ignored', 'timeout')).toBe('timeout');
    expect(formatCliErrorMessage(1, 'ignored', 'ignored', 'crash')).toBe('crash');
  });

  it('prefers trimmed stderr when non-empty', () => {
    expect(formatCliErrorMessage(1, '  bad stuff\n', 'ignored', undefined)).toBe('bad stuff');
  });

  it('falls back to stdout tail when stderr is empty (API error on stdout)', () => {
    const stdout =
      'API Error: {"type":"error","error":{"message":"Operation failed","code":"500"}}';
    expect(formatCliErrorMessage(1, '   \n', stdout, undefined)).toBe(stdout);
  });

  it('falls back to generic message when both streams empty', () => {
    expect(formatCliErrorMessage(137, '', '', undefined)).toBe('cli exited with code 137');
  });

  it('handles null exit code (killed/timeout with no spawn error)', () => {
    expect(formatCliErrorMessage(null, '', '', undefined)).toBe('cli exited with code unknown');
  });

  it('caps stderr tail at 2000 chars', () => {
    const big = 'x'.repeat(3000);
    const out = formatCliErrorMessage(1, big, '', undefined);
    expect(out).not.toBeNull();
    expect(out!.length).toBe(2000);
  });
});
