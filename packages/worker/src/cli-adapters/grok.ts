import { BaseCliAdapter } from './base-adapter.js';
import type {
  ApiCallSpec,
  CliCommandSpec,
  CliProviderRecord,
  EnvInjection,
  InvokeOpts,
} from './types.js';

export class GrokAdapter extends BaseCliAdapter {
  readonly providerName = 'grok' as const;
  readonly defaultExecutable = 'grok';
  readonly supportsSubagents = false;
  readonly supportsApi = true;
  readonly supportsCliAuth = true;
  readonly supportsMcp = false;
  readonly supportsPlugins = false;
  readonly defaultAuthMode = 'mixed' as const;
  readonly apiKeyEnvName = 'XAI_API_KEY';
  readonly defaultModel = 'grok-3';
  readonly rulesFile = '.grok/GROK.md';
  readonly rulesFileMode = 'copy' as const;

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

  override buildApiInvocation(
    _provider: CliProviderRecord,
    prompt: string,
    opts: InvokeOpts,
  ): ApiCallSpec {
    return {
      sdkPackage: 'openai',
      defaultModel: this.defaultModel,
      apiKeyEnvName: this.apiKeyEnvName,
      baseUrl: 'https://api.x.ai/v1',
      prompt,
      model: this.effectiveModel(opts),
      maxOutputTokens: this.effectiveMaxTokens(opts),
    };
  }

  envInjection(_provider: CliProviderRecord): EnvInjection {
    return {
      envVars: {},
      copyPaths: [
        { src: '~/.config/grok', dest: '/root/.config/grok', mode: 'dir', optional: true },
        { src: '~/.grok', dest: '/root/.grok', mode: 'dir', optional: true },
      ],
      extraArgs: [],
    };
  }
}
