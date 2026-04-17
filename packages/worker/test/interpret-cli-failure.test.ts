import { describe, expect, it } from 'vitest';
import { interpretCliFailure, type ExecutionOutcome } from '../src/queues/cli-exec-queue.js';

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
