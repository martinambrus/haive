import { describe, it, expect } from 'vitest';
import {
  capabilityClassFromMessage,
  classifyAntigravityDiagnostic,
  classifyModelCapability,
  classifyProviderFatal,
  CLI_PREEMPTED_HEADLINE,
  CLI_TIMEOUT_HEADLINE,
  cliTimeoutBudgetMinutes,
  fatalClassFromMessage,
  isCliPreemptionFailure,
  isCliTimeoutFailure,
  isFatalProviderFailure,
  isTransientCliFailure,
  withoutPreemptions,
  MODEL_CAPABILITY_HEADLINES,
  PROVIDER_FATAL_HEADLINES,
  type ModelCapabilityClass,
  type ProviderFatalClass,
} from './failure-class.js';

// The EXACT errorMessage values captured from the production incident (task
// 7780da14, step 07-phase-2-implement, ollama/deepseek-v4-flash:cloud). Both were
// surfaced raw and failed the task. Verifies the fix against the original failing
// input — every other assertion here is downstream of these two strings.
const INCIDENT_NO_VISION =
  'API Error: 400 this model does not support image input ' +
  '(ref: 0c523fbc-d82b-4cba-a5e7-aa8530c019b4)';
const INCIDENT_OUTPUT_CAP =
  "API Error: Claude's response exceeded the 32000 output token maximum. To configure " +
  'this behavior, set the CLAUDE_CODE_MAX_OUTPUT_TOKENS environment variable.';
// Anthropic's shape for a max_tokens above the model's own ceiling — the rollback
// trigger for a rung we set too high.
const MAX_TOKENS_REJECTED =
  'API Error: 400 max_tokens: 131072 > 64000, which is the maximum allowed number of ' +
  'output tokens for claude-sonnet-4-20250514';

// The EXACT message createSandboxSpawner stamps on a budget SIGKILL.
const TIMEOUT_45M = `${CLI_TIMEOUT_HEADLINE} (45m).`;

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

// The EXACT pair captured from the production incident (task dd682d32, step
// 08c2-code-audit, invocation 2d97813a): a MODEL error from grok, plus the stream-json
// tail that reaches the classifier as providerErrorScan. The `usage` block's
// `input_tokens` keys are what a bare `token.*invalid` matched, so a dead model slug was
// reported as an auth failure telling the user to check XAI_API_KEY. Every claude-family
// CLI emits the same terminal line, so this is not a grok-only shape.
const INCIDENT_GROK_MODEL_ID = `Couldn't set model 'grok-build-0.1': Invalid params: "unknown model id". Run 'grok models' to see available models.`;
const INCIDENT_GROK_MODEL_ID_SCAN =
  `{"type":"result","subtype":"error_during_execution","is_error":true,"duration_ms":0,` +
  `"num_turns":0,"stop_reason":null,"total_cost_usd":0.0,"usage":{"input_tokens":0,` +
  `"output_tokens":0,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,` +
  `"server_tool_use":{"web_search_requests":0}},"modelUsage":{},"errors":["Couldn't set ` +
  `model 'grok-build-0.1': Invalid params: \\"unknown model id\\". Run 'grok models' to ` +
  `see available models."],"session_id":"01a00fe6-4db1-7b72-b500-9b5f6f6c1dbc"}`;

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
    // grok's wording for a rejected/absent credential — the only signal it emits.
    'Not signed in. To authenticate without a browser, run:\n  grok login --device-code',
    // Bare token-state wording, with no other auth marker to fall back on.
    'refresh token invalid',
    'the access token expired',
    'token has been revoked',
  ])('classifies %s as auth', (msg) => {
    expect(classifyProviderFatal(1, msg, null)).toBe('auth');
  });

  // The original failing input. A model-id rejection is NOT an auth failure: the CLI
  // authenticated fine (the session_id in the scan proves it) and the user was told to
  // check a credential that was never the problem. Guards the `\btoken\b` boundary in
  // AUTH_RE against the stream-json `usage` block.
  it('does NOT classify a model-id rejection as auth despite the stream-json usage block', () => {
    expect(classifyProviderFatal(1, INCIDENT_GROK_MODEL_ID, INCIDENT_GROK_MODEL_ID_SCAN)).toBe(
      null,
    );
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

  it('still transient for a budget timeout — the re-dispatch path must stay open', () => {
    // The ladder raises the BUDGET on re-dispatch; it does not change the fact that a
    // timeout is recoverable infrastructure, not a model failure.
    expect(isTransientCliFailure({ exitCode: null, errorMessage: TIMEOUT_45M })).toBe(true);
    expect(isTransientCliFailure({ exitCode: 0, errorMessage: TIMEOUT_45M })).toBe(true);
  });
});

describe('isCliTimeoutFailure', () => {
  it('matches only the budget-timeout headline', () => {
    expect(isCliTimeoutFailure({ errorMessage: TIMEOUT_45M })).toBe(true);
  });

  it('does NOT match the other transient kinds', () => {
    // These never spent their budget, so escalating for them would hand a bigger
    // timeout to a run that was merely interrupted.
    for (const msg of [
      'CLI invocation orphaned by a worker restart (worker exited mid-run)',
      'CLI process was stopped before it finished (cancelled or timed out).',
      STREAM_PREMATURE_END,
      null,
      undefined,
    ]) {
      expect(isCliTimeoutFailure({ errorMessage: msg })).toBe(false);
    }
  });

  it('does NOT match the headline buried mid-message', () => {
    // Prefix-anchored: a model that happens to discuss time budgets in its output
    // must never be read as having timed out.
    expect(
      isCliTimeoutFailure({ errorMessage: `the agent said ${CLI_TIMEOUT_HEADLINE} (45m).` }),
    ).toBe(false);
  });
});

describe('cliTimeoutBudgetMinutes', () => {
  it('recovers the budget the run was killed at', () => {
    expect(cliTimeoutBudgetMinutes(TIMEOUT_45M)).toBe(45);
    expect(cliTimeoutBudgetMinutes(`${CLI_TIMEOUT_HEADLINE} (120m).`)).toBe(120);
  });

  it('returns null for anything that is not a timeout headline', () => {
    expect(cliTimeoutBudgetMinutes('CLI process was stopped before it finished')).toBeNull();
    expect(cliTimeoutBudgetMinutes(null)).toBeNull();
  });

  it('returns null for a timeout headline with no parseable budget', () => {
    expect(cliTimeoutBudgetMinutes(CLI_TIMEOUT_HEADLINE)).toBeNull();
  });
});

describe('classifyModelCapability', () => {
  it('classifies both production incident messages', () => {
    expect(classifyModelCapability(1, INCIDENT_NO_VISION, null)).toBe('no_image_support');
    expect(classifyModelCapability(1, INCIDENT_OUTPUT_CAP, null)).toBe('output_cap_reached');
  });

  it('classifies a rejected max_tokens ceiling, not an output cap', () => {
    // Opposite remedy (lower the ceiling, not raise it), so the ordering matters.
    expect(classifyModelCapability(1, MAX_TOKENS_REJECTED, null)).toBe('max_tokens_too_large');
  });

  it('reads the raw-output tail when the CLI printed the error only to stdout', () => {
    expect(classifyModelCapability(1, null, `...\n${INCIDENT_NO_VISION}\n`)).toBe(
      'no_image_support',
    );
  });

  it('ignores success and termination exit codes', () => {
    for (const exitCode of [0, null, 130, 137, 143]) {
      expect(classifyModelCapability(exitCode, INCIDENT_OUTPUT_CAP, null)).toBeNull();
    }
  });

  it('returns null for unrelated failures', () => {
    expect(classifyModelCapability(1, 'API Error: 401 Unauthorized', null)).toBeNull();
    expect(classifyModelCapability(1, 'ENOENT: no such file or directory', null)).toBeNull();
    // Ordinary truncation wording mentions max_tokens without the rejection qualifier.
    expect(classifyModelCapability(1, 'stopped with stop_reason max_tokens', null)).toBeNull();
  });

  it('does not steal the incident messages from the provider-fatal classifier', () => {
    // Both must stay OUT of auth / rate_limit / server_error: those fail the task fast
    // and would suppress the remediation retry entirely.
    expect(classifyProviderFatal(1, INCIDENT_NO_VISION, null)).toBeNull();
    expect(classifyProviderFatal(1, INCIDENT_OUTPUT_CAP, null)).toBeNull();
    expect(classifyProviderFatal(1, MAX_TOKENS_REJECTED, null)).toBeNull();
  });
});

describe('capabilityClassFromMessage', () => {
  it.each(Object.keys(MODEL_CAPABILITY_HEADLINES) as ModelCapabilityClass[])(
    'round-trips the %s headline',
    (cls) => {
      expect(capabilityClassFromMessage(`${MODEL_CAPABILITY_HEADLINES[cls]} — detail.`)).toBe(cls);
    },
  );

  it('returns null for a non-capability message', () => {
    expect(capabilityClassFromMessage(PROVIDER_FATAL_HEADLINES.auth)).toBeNull();
    expect(capabilityClassFromMessage('cli invocation failed: something else')).toBeNull();
    expect(capabilityClassFromMessage(null)).toBeNull();
  });

  it('requires the headline at the START, not merely present', () => {
    expect(
      capabilityClassFromMessage(`the agent said ${MODEL_CAPABILITY_HEADLINES.no_image_support}`),
    ).toBeNull();
  });
});

describe('preemption classification', () => {
  const PREEMPTED = `${CLI_PREEMPTED_HEADLINE}. The step re-runs automatically.`;

  it('is TRANSIENT, so the existing recovery path re-dispatches it', () => {
    expect(isTransientCliFailure({ exitCode: 137, errorMessage: PREEMPTED })).toBe(true);
    // …and from the text alone, with no exit signal to lean on.
    expect(isTransientCliFailure({ exitCode: undefined, errorMessage: PREEMPTED })).toBe(true);
  });

  it('is NOT a timeout — a preempted run never spent its budget', () => {
    // If this ever flips true, every eviction would climb the escalating timeout ladder and a
    // step would silently be handed a bigger budget it never needed.
    expect(isCliTimeoutFailure({ errorMessage: PREEMPTED })).toBe(false);
    expect(cliTimeoutBudgetMinutes(PREEMPTED)).toBeNull();
  });

  it('recognises only its own headline, at the START', () => {
    expect(isCliPreemptionFailure({ errorMessage: PREEMPTED })).toBe(true);
    expect(isCliPreemptionFailure({ errorMessage: null })).toBe(false);
    expect(
      isCliPreemptionFailure({ errorMessage: 'CLI process was stopped before it finished' }),
    ).toBe(false);
    expect(
      isCliPreemptionFailure({ errorMessage: `the agent said ${CLI_PREEMPTED_HEADLINE}` }),
    ).toBe(false);
  });

  it('a timeout is not mistaken for a preemption', () => {
    expect(isCliPreemptionFailure({ errorMessage: `${CLI_TIMEOUT_HEADLINE} (30m).` })).toBe(false);
  });
});

describe('withoutPreemptions', () => {
  const row = (errorMessage: string | null) => ({ errorMessage });
  const PREEMPTED = `${CLI_PREEMPTED_HEADLINE}.`;
  const ORPHAN = 'CLI invocation orphaned by a worker restart';

  it('removes preemption rows and leaves everything else untouched', () => {
    expect(withoutPreemptions([row(ORPHAN), row(PREEMPTED), row(null)])).toEqual([
      row(ORPHAN),
      row(null),
    ]);
  });

  it('keeps real orphans ADJACENT so an interrupted crash loop still counts', () => {
    // Three genuine orphans with evictions interleaved must still read as three in a row —
    // otherwise repeated preemption would mask a crash-looping worker forever.
    const history = [
      row(ORPHAN),
      row(PREEMPTED),
      row(ORPHAN),
      row(PREEMPTED),
      row(PREEMPTED),
      row(ORPHAN),
    ];
    expect(withoutPreemptions(history)).toEqual([row(ORPHAN), row(ORPHAN), row(ORPHAN)]);
  });

  it('an all-preemption history collapses to nothing, so no budget is spent', () => {
    expect(withoutPreemptions([row(PREEMPTED), row(PREEMPTED), row(PREEMPTED)])).toEqual([]);
  });

  it('preserves order', () => {
    expect(
      withoutPreemptions([row('a'), row(PREEMPTED), row('b')]).map((r) => r.errorMessage),
    ).toEqual(['a', 'b']);
  });
});

/** The rule the live run disproved: keeping preemptions out of a COUNT is not the same as
 *  keeping them from TRIGGERING an exhausted-budget failure. Both call sites must pass.
 *
 *  Modelled exactly as the gates are written:
 *      preempted || countTrailingOrphans(...) < MAX
 *  against the real history that failed task 38f02dee — a timeout plus three worker-restart
 *  orphans, i.e. a budget already spent before the eviction ever arrived. */
describe('a preemption re-dispatches regardless of the transient budget', () => {
  const MAX_ORPHAN_REDISPATCH = 3;
  const PREEMPTED = `${CLI_PREEMPTED_HEADLINE}.`;
  const ORPHAN = 'CLI invocation orphaned by a worker restart';
  const TIMEOUT = `${CLI_TIMEOUT_HEADLINE} (45m).`;

  /** countTrailingOrphans, in miniature: drop preemptions, then count leading transients. */
  const trailingOrphans = (messages: (string | null)[]): number => {
    let n = 0;
    for (const r of withoutPreemptions(messages.map((errorMessage) => ({ errorMessage })))) {
      if (!isTransientCliFailure({ exitCode: null, errorMessage: r.errorMessage })) break;
      n++;
    }
    return n;
  };

  const redispatches = (history: (string | null)[]): boolean => {
    const [newest] = history;
    return (
      isCliPreemptionFailure({ errorMessage: newest }) ||
      trailingOrphans(history) < MAX_ORPHAN_REDISPATCH
    );
  };

  it('the eviction is excluded from the count', () => {
    expect(trailingOrphans([PREEMPTED, TIMEOUT, ORPHAN, ORPHAN, ORPHAN])).toBe(4);
    expect(trailingOrphans([PREEMPTED, PREEMPTED, PREEMPTED])).toBe(0);
  });

  it('re-dispatches on the exact history that failed 38f02dee', () => {
    // Budget spent 4/3 by genuine failures — the eviction must still not be what kills it.
    expect(redispatches([PREEMPTED, TIMEOUT, ORPHAN, ORPHAN, ORPHAN])).toBe(true);
  });

  it('re-dispatches an all-preemption history forever', () => {
    expect(redispatches([PREEMPTED, PREEMPTED, PREEMPTED, PREEMPTED, PREEMPTED])).toBe(true);
  });

  it('still FAILS on a genuine crash loop, evictions interleaved or not', () => {
    expect(redispatches([ORPHAN, ORPHAN, ORPHAN])).toBe(false);
    // The interleaving must not rescue it: that is why withoutPreemptions removes rather than
    // short-circuits — the real orphans stay adjacent and still count to 3.
    expect(redispatches([ORPHAN, PREEMPTED, ORPHAN, PREEMPTED, ORPHAN])).toBe(false);
  });

  it('still re-dispatches a genuine orphan while its budget lasts', () => {
    expect(redispatches([ORPHAN, ORPHAN])).toBe(true);
  });
});
