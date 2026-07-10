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
  // agy's inference/auth endpoints aren't derivable from the CLI's flags; the
  // user must add them per provider (Settings → network) to run under
  // allowlist/none. Empty default keeps the base behavior explicit.
  override readonly defaultEgressDomains: readonly string[] = [];

  buildCliInvocation(
    provider: CliProviderRecord,
    prompt: string,
    opts: InvokeOpts,
  ): CliCommandSpec {
    return {
      command: this.resolveExecutable(provider),
      // agy has no --output-format/stream-json (plain text print), so this
      // mirrors gemini's plain -p. --dangerously-skip-permissions keeps tool
      // use non-interactive during autonomous step execution. --log-file is placed
      // BEFORE -p so a greedy -p can't swallow it; agy writes provider-fatal errors
      // ONLY to that log (exiting 0), which the runner reads back via captureFile.
      args: this.mergedArgs(provider, [
        '--dangerously-skip-permissions',
        '--log-file',
        `${AGY_LOG_DIR}/${AGY_LOG_FILE}`,
        '-p',
        prompt,
      ]),
      env: this.mergedEnv(provider, opts),
      cwd: opts.cwd,
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
