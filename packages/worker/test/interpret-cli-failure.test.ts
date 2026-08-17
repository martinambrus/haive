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

  // VERBATIM tail of a real failing grok run. Its own init line reported
  // apiKeySource:"user" — the XAI_API_KEY reached the CLI and was used — and the account
  // was simply out of credits, yet grok emits the string it uses for "never logged in".
  const GROK_NOT_SIGNED_IN =
    '{"type":"result","subtype":"error_during_execution","is_error":true,"errors":' +
    '["Not signed in. To authenticate without a browser, run:\\n  grok login --device-code' +
    '\\n\\nAlternatively, set the XAI_API_KEY environment variable or run `grok login` on a ' +
    'machine with a browser."]}\n' +
    'Error: Not signed in. To authenticate without a browser, run:\n  grok login --device-code\n';

  // VERBATIM xAI billing error, from the run that actually failed this way. It arrives on a
  // 403, so AUTH_RE claims it via `\b40[13]\b` unless the billing check runs first — and
  // RATE_LIMIT_RE never matches it ("spending limit" is not "usage limit", no `quota` token).
  const GROK_OUT_OF_CREDITS =
    'Error: Internal error: {\n  "message": "API error (status 403 Forbidden): permission-denied: ' +
    'Your team 92d549b8 has either used all available credits or reached its monthly spending ' +
    'limit. To continue making API requests, please purchase more credits or raise your ' +
    'spending limit."\n}';

  it('classifies an exhausted account as a QUOTA failure, not an auth failure', () => {
    // The defect this fixes: an out-of-credits account was reported as "CLI authentication
    // failed — re-authenticate your CLI in your terminal", which is both wrong (the
    // credentials are fine) and impossible to act on. It must read as a spend problem.
    // errorMessage, not rawOutput: that is where this arrived on the real invocation, and it
    // is also what formatAuthDetail excerpts, so the provider's own "purchase more credits"
    // wording reaches the user even though the headline is generic.
    const msg = interpretCliFailure(outcome({ errorMessage: GROK_OUT_OF_CREDITS }), 'grok');
    expect(msg).toMatch(/usage limit or quota is exhausted/);
    expect(msg).not.toMatch(/authentication failed/);
    expect(msg).not.toMatch(/re-authenticate/);
    expect(msg).toMatch(/purchase more credits/);
  });

  it('still classifies a plain 403 with no billing wording as auth', () => {
    // The billing check must not swallow ordinary permission failures — it runs first only
    // to win the 403 that names credits.
    const msg = interpretCliFailure(
      outcome({ rawOutput: '403 Forbidden permission_error' }),
      'codex',
    );
    expect(msg).toMatch(/authentication failed/);
  });

  it('gives grok an ACTIONABLE auth hint, not "re-authenticate your CLI"', () => {
    // grok's other degradation: a rejected credential reported as "Not signed in". That
    // phrase previously matched nothing, so the failure carried no classification at all and
    // was passed through raw. Now it classifies as auth and gets a hint naming both routes.
    const msg = interpretCliFailure(outcome({ rawOutput: GROK_NOT_SIGNED_IN }), 'grok');
    expect(msg).toMatch(/XAI_API_KEY/);
    expect(msg).toMatch(/credits/);
    expect(msg).not.toMatch(/re-authenticate your CLI in your terminal/);
  });

  it('covers both grok auth modes, since the classifier only sees a provider name', () => {
    // grok takes either a secret or an in-Haive device login and this code path never
    // learns which the failing row used, so the hint has to name both routes.
    const msg = interpretCliFailure(outcome({ rawOutput: GROK_NOT_SIGNED_IN }), 'grok');
    expect(msg).toMatch(/Haive providers page/);
  });

  it('leaves other providers’ auth hints untouched', () => {
    // The override is keyed by name; nothing else may shift.
    expect(interpretCliFailure(outcome({ rawOutput: 'Unauthorized 401' }), 'codex')).toMatch(
      /codex login/,
    );
    expect(interpretCliFailure(outcome({ rawOutput: 'Unauthorized 401' }), 'antigravity')).toMatch(
      /Haive providers page/,
    );
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

  it('surfaces an antigravity quota failure that agy swallowed to exit 0 + empty output', () => {
    // agy reports quota/auth/5xx ONLY to its log while exiting 0 with empty output;
    // the captured log rides providerDiagnosticLog and is classified despite exit 0.
    const result = outcome({
      exitCode: 0,
      rawOutput: '',
      parsedOutput: null,
      providerDiagnosticLog:
        'I0710 16:10:11 10 server_oauth.go:212] applyAuthResult: email=x\n' +
        'E0710 16:10:20.298253 10 log.go:398] agent executor error: RESOURCE_EXHAUSTED (code 429): ' +
        'Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 167h1m31s.',
    });
    const msg = interpretCliFailure(result, 'antigravity');
    expect(msg).toMatch(/Provider rate limit or quota exhausted/);
    expect(msg).toMatch(/Resets in 167h1m31s\./); // agy's reset ETA carried into the detail
  });

  it('does NOT classify antigravity when output is non-empty (transient 429 then success)', () => {
    // agy retried past a transient 429 and produced a real answer; the log still
    // mentions 429 but the run succeeded, so it must not be failed.
    const result = outcome({
      exitCode: 0,
      rawOutput: '{"agentQuestions":[],"explicitNoQuestions":true}',
      parsedOutput: { explicitNoQuestions: true },
      providerDiagnosticLog:
        'E0710 1 10 log.go:398] agent executor error: RESOURCE_EXHAUSTED (code 429): transient',
    });
    expect(interpretCliFailure(result, 'antigravity')).toBeNull();
  });

  it('does not misclassify antigravity on a healthy empty run with no fatal log line', () => {
    const result = outcome({
      exitCode: 0,
      rawOutput: '',
      providerDiagnosticLog: 'I0710 1 10 server.go:1] conversation done',
    });
    expect(interpretCliFailure(result, 'antigravity')).toBeNull();
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
