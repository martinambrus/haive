import { BaseCliAdapter } from './base-adapter.js';
import type { CliCommandSpec, CliProviderRecord, EnvInjection, InvokeOpts } from './types.js';

// agy reports provider-fatal errors (quota 429 / auth / 5xx) ONLY to its log file
// while exiting 0 with empty stdout, so Haive redirects that log via `--log-file` to
// a fixed path inside a writable capture mount and reads it back for fatal-error
// classification. See interpretCliFailure / classifyAntigravityDiagnostic. The dir is
// a dedicated sandbox mount point (not the repo/workdir), so a fixed path is safe —
// one invocation per container.
export const AGY_LOG_DIR = '/haive/agy-log';
export const AGY_LOG_FILE = 'agy.log';

// agy caps a whole print-mode run at --print-timeout, default 5m0s, and aborts
// with `{"status":"ERROR","error":"timeout waiting for response"}`. MEASURED:
// `--print-timeout 8s` on a prompt that sleeps 25s killed the run at ~10s. That
// default silently truncated every antigravity invocation at five minutes, well
// inside Haive's own multi-hour budget. Set far above any Haive timeout so the
// CLI's internal cap never fires first and the existing timeout ladder stays the
// single authority — the same position every other adapter is in by having no
// internal cap at all.
const AGY_PRINT_TIMEOUT = '24h';

/** One NDJSON user message, the input `--input-format stream-json` consumes.
 *  VERIFIED end-to-end against the live binary: agy answered and exited 0. */
export function antigravityStdinPrompt(prompt: string): string {
  return `${JSON.stringify({ event: 'user', message: { role: 'user', content: prompt } })}\n`;
}

export class AntigravityAdapter extends BaseCliAdapter {
  readonly providerName = 'antigravity' as const;
  readonly defaultExecutable = 'agy';
  // agy is a full agentic CLI with native subagents, so Haive dispatches a
  // single native invocation (one `agy -p` call with an assembled multi-subagent
  // prompt) rather than sequential emulation. The splitter keeps a sequential
  // case for compile-completeness; it is unreachable while this is true.
  readonly supportsSubagents = true;
  // Subscription (Continue-with-Google) auth. Credentials persist as a copyable
  // file at ~/.gemini/antigravity-cli/antigravity-oauth-token (no OS keyring),
  // captured by the auth volume. Like zai/gemini, supportsCliAuth gates the
  // dispatcher's CLI execution path, so it must be true to run; assertUserAuthReady
  // short-circuits when authMode is api_key.
  readonly supportsCliAuth = true;
  readonly supportsMcp = true;
  readonly supportsPlugins = true;
  readonly defaultAuthMode = 'subscription' as const;
  // No simple API-key env var. The only non-OAuth path is GCP ADC
  // (GOOGLE_APPLICATION_CREDENTIALS + GOOGLE_CLOUD_PROJECT), out of scope for
  // the first pass — subscription only.
  readonly apiKeyEnvName = null;
  // agy uses its own default model when --model is omitted; not pinned here.
  readonly defaultModel = null;
  // Antigravity reads AGENTS.md natively (shares the repo-root AGENTS.md with
  // codex/amp; step 07 merges the rules blocks).
  readonly rulesFile = 'AGENTS.md';
  readonly rulesFileMode = 'native' as const;
  // MEASURED against the live CLI (test/egress-discover.ts, agy 2026-08-17), not
  // taken from vendor docs — an empty default here meant `none`/`allowlist` gave
  // agy no gateway at all and every run died on "auth timed out".
  //
  // The two google.com hosts are not optional extras: agy's ELIGIBILITY CHECK
  // calls www.googleapis.com/oauth2/v2/userinfo AND fetches the account's profile
  // picture from googleusercontent, and a 403 on either aborts the whole run
  // before a single token is generated ("Eligibility check failed"). Both
  // verified by removing them one at a time.
  //
  // cloudcode-pa is the model backend (loadCodeAssist / streamGenerateContent).
  // The live host carries a release-channel prefix (`daily-`), so the bare form
  // is listed alongside it; a future channel prefix squid cannot wildcard-match
  // needs a per-provider egress entry.
  //
  // Deliberately NOT included, though agy contacts them: play.googleapis.com
  // (telemetry), antigravity-unleash.goog (experiments), api.mixpanel.com. A run
  // completes with all three blocked, so they buy nothing and widen the allow-set.
  override readonly defaultEgressDomains = [
    'oauth2.googleapis.com',
    'www.googleapis.com',
    'cloudcode-pa.googleapis.com',
    'daily-cloudcode-pa.googleapis.com',
    '*.googleusercontent.com',
  ];

  buildCliInvocation(
    provider: CliProviderRecord,
    prompt: string,
    opts: InvokeOpts,
  ): CliCommandSpec {
    return {
      command: this.resolveExecutable(provider),
      // agy's own --help: `--input-format stream-json` "reads one NDJSON message
      // per line from stdin and runs a turn for each; it requires --output-format
      // stream-json". So the prompt goes over stdin and NOT in argv, which takes
      // antigravity out of the E2BIG class entirely (a 128 KiB argv entry is what
      // killed 27 agents of a plan build) rather than merely refusing loudly.
      //
      // `-p` is DELIBERATELY absent: it is a STRING flag (`--prompt` is its alias),
      // so a bare `-p` fails flag parsing with "flag needs an argument: -p" —
      // MEASURED. stream-json input is print mode on its own.
      //
      // --log-file is kept even though status/error now arrive as fields on the
      // result event: the exit-0-on-quota path (classifyAntigravityDiagnostic)
      // reads that log, and quota is the one fatal class not reproducible here.
      args: this.mergedArgs(provider, [
        '--dangerously-skip-permissions',
        '--log-file',
        `${AGY_LOG_DIR}/${AGY_LOG_FILE}`,
        '--print-timeout',
        AGY_PRINT_TIMEOUT,
        '--input-format',
        'stream-json',
        '--output-format',
        'stream-json',
      ]),
      env: this.mergedEnv(provider, opts),
      cwd: opts.cwd,
      outputFormat: 'antigravity-stream-json',
      stdinPrompt: antigravityStdinPrompt(prompt),
      captureFile: { containerDir: AGY_LOG_DIR, fileName: AGY_LOG_FILE },
    };
  }

  envInjection(_provider: CliProviderRecord): EnvInjection {
    return {
      envVars: {},
      extraArgs: [],
    };
  }
}
