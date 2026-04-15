import { BaseCliAdapter } from './base-adapter.js';
import type { CliCommandSpec, CliProviderRecord, EnvInjection, InvokeOpts } from './types.js';

export class AmpAdapter extends BaseCliAdapter {
  readonly providerName = 'amp' as const;
  readonly defaultExecutable = 'amp';
  readonly supportsSubagents = false;
  readonly supportsApi = false;
  readonly supportsCliAuth = true;
  readonly defaultAuthMode = 'subscription' as const;
  readonly apiKeyEnvName = null;
  readonly defaultModel = null;

  buildCliInvocation(
    provider: CliProviderRecord,
    prompt: string,
    opts: InvokeOpts,
  ): CliCommandSpec {
    return {
      command: this.resolveExecutable(provider),
      args: this.mergedArgs(provider, [prompt]),
      env: this.mergedEnv(provider, opts.extraEnv),
      cwd: opts.cwd,
    };
  }

  envInjection(_provider: CliProviderRecord): EnvInjection {
    return {
      envVars: {},
      copyPaths: [
        { src: '~/.config/amp', dest: '/root/.config/amp', mode: 'dir', optional: true },
        { src: '~/.amp', dest: '/root/.amp', mode: 'dir', optional: true },
      ],
      extraArgs: [],
    };
  }
}
