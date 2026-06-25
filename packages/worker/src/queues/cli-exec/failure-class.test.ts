import { describe, it, expect } from 'vitest';
import {
  classifyProviderFatal,
  isFatalProviderFailure,
  PROVIDER_FATAL_HEADLINES,
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
