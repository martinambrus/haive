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

  it('falls back to generic hint when provider name is null', () => {
    const result = outcome({ rawOutput: 'Unauthorized' });
    const msg = interpretCliFailure(result, null);
    expect(msg).toMatch(/re-authenticate/);
  });

  it('leaves non-auth failures untouched', () => {
    const result = outcome({ errorMessage: 'rate limit exceeded' });
    expect(interpretCliFailure(result, 'claude-code')).toBe('rate limit exceeded');
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
