import { BaseCliAdapter } from './base-adapter.js';
import type { CliCommandSpec, CliProviderRecord, InvokeOpts } from './types.js';
import { deliverPrompt } from './prompt-delivery.js';

/** A headless gemini run has to be told the workspace is trusted AND that its tools are
 *  pre-approved. MEASURED on 0.60.0 against a zero-token recorder: without the env var every run
 *  exits 55 before its first request ("Gemini CLI is not running in a trusted directory"); with it
 *  but no approval flag, non-interactive mode drops every tool that needs one, leaving 8 read-only
 *  tools — no `activate_skill`, `write_file`, `replace` or `run_shell_command`. `--yolo` (the flag
 *  the auth probe already passes) brings all of them back. */
const GEMINI_HEADLESS_ENV: Readonly<Record<string, string>> = {
  GEMINI_CLI_TRUST_WORKSPACE: 'true',
};

export class GeminiAdapter extends BaseCliAdapter {
  readonly providerName = 'gemini' as const;
  readonly defaultExecutable = 'gemini';
  readonly supportsSubagents = false;
  // Gemini is BYOK/API-key only (no subscription CLI login). Like zai, the
  // dispatcher's CLI path is gated on supportsCliAuth and assertUserAuthReady
  // short-circuits when authMode is 'api_key', so keeping this true keeps
  // gemini dispatchable without forcing a login. defaultAuthMode='api_key'
  // (below) is what removes the subscription option from the UI/API.
  readonly supportsCliAuth = true;
  readonly supportsMcp = true;
  readonly supportsPlugins = false;
  readonly defaultAuthMode = 'api_key' as const;
  readonly apiKeyEnvName = 'GEMINI_API_KEY';
  readonly defaultModel = 'gemini-2.5-pro';
  readonly rulesFile = 'GEMINI.md';
  readonly rulesFileMode = 'import' as const;
  override readonly defaultEgressDomains = [
    'generativelanguage.googleapis.com',
    'oauth2.googleapis.com',
  ];

  buildCliInvocation(
    provider: CliProviderRecord,
    prompt: string,
    opts: InvokeOpts,
  ): CliCommandSpec {
    return {
      command: this.resolveExecutable(provider),
      // JSON output mode wraps the answer in {response, stats}; exec-core
      // unwraps `response` for the step parsers and reads token usage from
      // `stats.models`. Older binaries that ignore the flag fall back to the
      // plain-text path.
      //
      // KNOWN LIMITATION (max output tokens): the Gemini CLI has no flag or env to
      // raise the model's output cap, so the API default (8192) applies and long
      // single responses truncate silently (finishReason MAX_TOKENS in the
      // gemini-json envelope). The only lever is a settings.json
      // `modelConfigs.aliases.<alias>.modelConfig.generateContentConfig.maxOutputTokens`
      // override that must ALSO be explicitly selected — version-bound, and a wrong
      // key silently no-ops (google-gemini/gemini-cli#23081), so it is deliberately
      // NOT injected here. Mitigation is the same as for any capped CLI: keep
      // per-invocation output small (e.g. the 09_5 skill loop emits one skill per
      // call). If a large-output gemini step truncates, add the override in the
      // runtime settings.json writer and VERIFY it against the pinned CLI version.
      // No stdin form documented by `gemini --help`, so an oversized prompt
      // refuses by name here instead of failing as a bare E2BIG in spawn.
      args: this.mergedArgs(provider, [
        '-p',
        ...deliverPrompt(prompt, { adapter: 'gemini', stdin: false }).argv,
        '--output-format',
        'json',
        '--yolo',
      ]),
      env: { ...GEMINI_HEADLESS_ENV, ...this.mergedEnv(provider, opts) },
      cwd: opts.cwd,
      outputFormat: 'gemini-json',
    };
  }
}
