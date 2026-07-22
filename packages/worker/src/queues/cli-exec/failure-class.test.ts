import { describe, it, expect } from 'vitest';
import {
  classifyAntigravityDiagnostic,
  classifyProviderFatal,
  fatalClassFromMessage,
  isFatalProviderFailure,
  isTransientCliFailure,
  PROVIDER_FATAL_HEADLINES,
  type ProviderFatalClass,
} from './failure-class.js';

// The EXACT errorMessage captured from the production incident (task 2cac9e07,
// Ollama cloud over its weekly limit). Verifies the fix against the original
// failing input.
const INCIDENT_429 =
  'API Error: Request rejected (429) · you (martinambrusbb) have reached your weekly usage limit, ' +
  'upgrade for higher limits: https://ollama.com/upgrade or add extra usage: https://ollama.com/settings ' +
  '(ref: 5b1a30c1-5faf-4cce-a66f-97e5b47aa462)';

// stream.ts messages — the structured rate-limit block vs the ambiguous
// premature-stream-end (timeout/abort/quota) that must NOT be treated as fatal.
const STREAM_RATE_LIMIT = 'LLM blocked by rate limit (overage rejected)';
const STREAM_PREMATURE_END =
  'LLM emitted no result event (stream ended prematurely — likely timeout, session abort, or quota rejection)';

describe('classifyProviderFatal', () => {
  it('classifies the production 429 weekly-limit message as rate_limit', () => {
    expect(classifyProviderFatal(1, INCIDENT_429, null)).toBe('rate_limit');
  });

  it('classifies the stream rate-limit block as rate_limit', () => {
    expect(classifyProviderFatal(1, STREAM_RATE_LIMIT, null)).toBe('rate_limit');
  });

  it.each([
    'Error: 429 Too Many Requests',
    'quota exceeded for this billing period',
    'monthly usage limit reached',
    // Claude subscription session-limit wording (original failing input) — no 429/quota
    // in the CLI output, so it must match on the "session limit" prose or the allowance
    // watch never arms and the user is not notified when the window resets.
    "You've hit your session limit · resets 8:50am (UTC)",
  ])('classifies %s as rate_limit', (msg) => {
    expect(classifyProviderFatal(1, msg, null)).toBe('rate_limit');
  });

  it.each([
    'API Error: 401 Unauthorized',
    'authentication_error: invalid x-api-key',
    'Error 403: permission_error',
    'your token has expired, please log in',
  ])('classifies %s as auth', (msg) => {
    expect(classifyProviderFatal(1, msg, null)).toBe('auth');
  });

  it.each([
    'HTTP 503 Service Unavailable',
    'API Error: 500 Internal Server Error',
    'upstream returned 502 Bad Gateway',
    'Error (529): the model is overloaded',
    'gateway timeout while contacting the provider',
  ])('classifies %s as server_error', (msg) => {
    expect(classifyProviderFatal(1, msg, null)).toBe('server_error');
  });

  it('detects a fatal error in the rawOutput tail when errorMessage is empty', () => {
    const raw = `${'noise '.repeat(2000)}\nfatal: API Error: Request rejected (429) usage limit`;
    expect(classifyProviderFatal(1, null, raw)).toBe('rate_limit');
  });

  it('classifies the real codex usage-limit turn.failed event (original failing input) as rate_limit', () => {
    // Exact provider error from task 9759446e / step 08c2 — reachable via
    // providerErrorScan (raw stdout+stderr) because rawOutput is sanitized for Clean.
    const scan =
      '{"type":"turn.failed","error":{"message":"You\'ve hit your usage limit. ' +
      'Upgrade to Pro (https://chatgpt.com/explore/pro), visit ' +
      'https://chatgpt.com/codex/settings/usage to purchase more credits."}}';
    expect(classifyProviderFatal(1, 'Reading additional input from stdin...', scan)).toBe(
      'rate_limit',
    );
  });

  it('cannot classify when the scan is empty (the regression an emptied rawOutput causes)', () => {
    expect(classifyProviderFatal(1, 'Reading additional input from stdin...', '')).toBe(null);
  });

  // --- Negatives: must NOT fail the task fast --------------------------------

  it('returns null for a successful run even if the output mentions a status code', () => {
    expect(
      classifyProviderFatal(0, null, 'wrote handler for HTTP 500 and rate limit retries'),
    ).toBe(null);
  });

  it('returns null for cancellation / termination exit codes', () => {
    expect(classifyProviderFatal(137, INCIDENT_429, null)).toBe(null);
    expect(classifyProviderFatal(130, 'unauthorized', null)).toBe(null);
    expect(classifyProviderFatal(143, '503 service unavailable', null)).toBe(null);
  });

  it('returns null for a null exit code (killed/timed out by the spawner)', () => {
    expect(classifyProviderFatal(null, INCIDENT_429, null)).toBe(null);
  });

  it('returns null for the ambiguous premature-stream-end message (not a confirmed quota hit)', () => {
    expect(classifyProviderFatal(1, STREAM_PREMATURE_END, null)).toBe(null);
  });

  it('returns null for an ordinary code failure (should still escalate/retry)', () => {
    expect(classifyProviderFatal(1, 'TypeError: x is not a function\n  at build.ts:42', null)).toBe(
      null,
    );
  });

  it('does not treat a bare number like "500ms" / "$500" in failed output as a server error', () => {
    expect(classifyProviderFatal(1, 'build failed after 500ms; budget was $500', null)).toBe(null);
  });
});

describe('classifyAntigravityDiagnostic', () => {
  // The EXACT agy quota line captured from a real exhausted-quota run (glog-prefixed,
  // and agy doubles the error text). Verifies the fix against the original input.
  const AGY_QUOTA_LINE =
    'E0710 16:10:20.298253    10 log.go:398] agent executor error: RESOURCE_EXHAUSTED (code 429): ' +
    'Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 167h1m31s.: ' +
    'RESOURCE_EXHAUSTED (code 429): Individual quota reached. Resets in 167h1m31s.';

  it('classifies the real agy quota line as rate_limit and strips the glog prefix', () => {
    const r = classifyAntigravityDiagnostic(
      `I0710 16:10:11 10 server_oauth.go:1] info\n${AGY_QUOTA_LINE}\n`,
    );
    expect(r?.class).toBe('rate_limit');
    expect(r?.detail.startsWith('agent executor error:')).toBe(true);
    expect(r?.detail).toContain('Resets in 167h1m31s.');
  });

  it('maps agy gRPC auth / server statuses to their classes', () => {
    expect(
      classifyAntigravityDiagnostic(
        'E0710 1 10 log.go:1] agent executor error: UNAUTHENTICATED (code 401): bad',
      )?.class,
    ).toBe('auth');
    expect(
      classifyAntigravityDiagnostic(
        'E0710 1 10 log.go:1] agent executor error: PERMISSION_DENIED (code 403): no',
      )?.class,
    ).toBe('auth');
    expect(
      classifyAntigravityDiagnostic(
        'E0710 1 10 log.go:1] agent executor error: UNAVAILABLE (code 503): down',
      )?.class,
    ).toBe('server_error');
  });

  it('does NOT match a gRPC token in logged repo content (no executor-error / (code N) line shape)', () => {
    // A source file the agent read that discusses rate limiting — must not fail a healthy run.
    const log =
      'I0710 1 10 tool.go:1] read file: // RESOURCE_EXHAUSTED means back off on 429 rate limit';
    expect(classifyAntigravityDiagnostic(log)).toBe(null);
  });

  it('does NOT match a (code N) line that carries no gRPC fatal status', () => {
    const log = 'I0710 1 10 tool.go:1] read file: return http.Error(w, "busy", (code 429))';
    expect(classifyAntigravityDiagnostic(log)).toBe(null);
  });

  it('returns null for empty/absent log and a clean run', () => {
    expect(classifyAntigravityDiagnostic(null)).toBe(null);
    expect(classifyAntigravityDiagnostic('')).toBe(null);
    expect(classifyAntigravityDiagnostic('I0710 1 10 server.go:1] conversation done')).toBe(null);
  });
});

describe('isFatalProviderFailure', () => {
  it('detects a message built with any fatal headline', () => {
    for (const headline of Object.values(PROVIDER_FATAL_HEADLINES)) {
      expect(isFatalProviderFailure(`${headline} — retry later. (detail)`)).toBe(true);
    }
  });

  it('is false for a non-headlined message and for null/undefined', () => {
    expect(isFatalProviderFailure('cli invocation failed: TypeError')).toBe(false);
    expect(isFatalProviderFailure(null)).toBe(false);
    expect(isFatalProviderFailure(undefined)).toBe(false);
  });
});

describe('fatalClassFromMessage', () => {
  it('round-trips each headline back to its class', () => {
    for (const cls of Object.keys(PROVIDER_FATAL_HEADLINES) as ProviderFatalClass[]) {
      expect(fatalClassFromMessage(`${PROVIDER_FATAL_HEADLINES[cls]} — detail (x)`)).toBe(cls);
    }
  });

  it('returns null for a non-headlined message and for null/undefined', () => {
    expect(fatalClassFromMessage('TypeError: x is not a function')).toBe(null);
    expect(fatalClassFromMessage(null)).toBe(null);
    expect(fatalClassFromMessage(undefined)).toBe(null);
  });

  it('does NOT match a headline that is only embedded mid-message (must be the prefix)', () => {
    // The single-terminal path stores the step error as "cli invocation failed: <headline>",
    // so handleResult reads the raw invocation message (prefix = headline) instead.
    expect(
      fatalClassFromMessage(`cli invocation failed: ${PROVIDER_FATAL_HEADLINES.rate_limit}`),
    ).toBe(null);
  });
});

describe('isTransientCliFailure', () => {
  it.each([null, 130, 137, 143])('transient for a killed/terminated exit code: %s', (exitCode) => {
    expect(isTransientCliFailure({ exitCode, errorMessage: null })).toBe(true);
  });

  it.each([
    'CLI invocation orphaned by a worker restart (worker exited mid-run)',
    'CLI process was stopped before it finished (cancelled or timed out).',
    STREAM_PREMATURE_END,
  ])('transient for an orphan/stop/premature marker even with a 0 exit: %s', (errorMessage) => {
    expect(isTransientCliFailure({ exitCode: 0, errorMessage })).toBe(true);
  });

  it('transient from the marker alone when no exit signal is available (undefined exit)', () => {
    expect(isTransientCliFailure({ errorMessage: 'the run was cancelled or timed out' })).toBe(
      true,
    );
  });

  it('NOT transient for a clean success (exit 0, no error)', () => {
    expect(isTransientCliFailure({ exitCode: 0, errorMessage: null })).toBe(false);
  });

  it('NOT transient for a genuine code failure (exit 1 + real error)', () => {
    expect(
      isTransientCliFailure({
        exitCode: 1,
        errorMessage: 'TypeError: x is not a function at build.ts:42',
      }),
    ).toBe(false);
  });

  it('NOT transient for a non-termination failure with no kill marker', () => {
    expect(isTransientCliFailure({ exitCode: 1, errorMessage: null })).toBe(false);
    expect(isTransientCliFailure({ errorMessage: 'plain failure, no kill marker' })).toBe(false);
  });
});
