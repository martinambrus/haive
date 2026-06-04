import { BaseCliAdapter } from './base-adapter.js';
import type { CliCommandSpec, CliProviderRecord, EnvInjection, InvokeOpts } from './types.js';

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

  buildCliInvocation(
    provider: CliProviderRecord,
    prompt: string,
    opts: InvokeOpts,
  ): CliCommandSpec {
    return {
      command: this.resolveExecutable(provider),
      args: this.mergedArgs(provider, ['-p', prompt]),
      env: this.mergedEnv(provider, opts),
      cwd: opts.cwd,
    };
  }

  envInjection(_provider: CliProviderRecord): EnvInjection {
    return {
      // GEMINI_CLI_TRUST_WORKSPACE bypasses the folder-trust prompt for the
      // current session, ensuring step exec doesn't get downgraded to default
      // approval mode when running in the sandbox workdir. Belt-and-braces
      // alongside folderTrust.enabled=false in settings.json — the env var
      // covers users whose ~/.gemini/settings.json predates that change.
      envVars: { GEMINI_CLI_TRUST_WORKSPACE: 'true' },
      extraArgs: [],
    };
  }
}
