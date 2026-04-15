import { BaseCliAdapter } from './base-adapter.js';
import type {
  ApiCallSpec,
  CliCommandSpec,
  CliProviderRecord,
  EnvInjection,
  InvokeOpts,
} from './types.js';

export class QwenAdapter extends BaseCliAdapter {
  readonly providerName = 'qwen' as const;
  readonly defaultExecutable = 'qwen';
  readonly supportsSubagents = false;
  readonly supportsApi = true;
  readonly supportsCliAuth = true;
  readonly defaultAuthMode = 'mixed' as const;
  readonly apiKeyEnvName = 'DASHSCOPE_API_KEY';
  readonly defaultModel = 'qwen-max';

  buildCliInvocation(
    provider: CliProviderRecord,
    prompt: string,
    opts: InvokeOpts,
  ): CliCommandSpec {
    return {
      command: this.resolveExecutable(provider),
      args: this.mergedArgs(provider, ['-p', prompt]),
      env: this.mergedEnv(provider, opts.extraEnv),
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
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      prompt,
      model: this.effectiveModel(opts),
      maxOutputTokens: this.effectiveMaxTokens(opts),
    };
  }

  envInjection(_provider: CliProviderRecord): EnvInjection {
    return {
      envVars: {},
      copyPaths: [{ src: '~/.qwen', dest: '/root/.qwen', mode: 'dir', optional: true }],
      extraArgs: [],
    };
  }
}
