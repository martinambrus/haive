import { BaseCliAdapter } from './base-adapter.js';
import type { CliCommandSpec, CliProviderRecord, EnvInjection, InvokeOpts } from './types.js';

export class KiroAdapter extends BaseCliAdapter {
  readonly providerName = 'kiro' as const;
  readonly defaultExecutable = 'kiro';
  readonly supportsSubagents = false;
  readonly supportsApi = false;
  readonly supportsCliAuth = true;
  readonly supportsMcp = false;
  readonly supportsPlugins = false;
  readonly defaultAuthMode = 'subscription' as const;
  readonly apiKeyEnvName = null;
  readonly defaultModel = null;
  readonly rulesFile = 'AGENTS.md';
  readonly rulesFileMode = 'native' as const;

  buildCliInvocation(
    provider: CliProviderRecord,
    prompt: string,
    opts: InvokeOpts,
  ): CliCommandSpec {
    return {
      command: this.resolveExecutable(provider),
      args: this.mergedArgs(provider, [prompt]),
      env: this.mergedEnv(provider, opts),
      cwd: opts.cwd,
    };
  }

  envInjection(_provider: CliProviderRecord): EnvInjection {
    return {
      envVars: {},
      copyPaths: [{ src: '~/.kiro', dest: '/root/.kiro', mode: 'dir', optional: true }],
      extraArgs: [],
    };
  }
}
