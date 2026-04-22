import { BaseCliAdapter } from './base-adapter.js';
import type {
  ApiCallSpec,
  CliCommandSpec,
  CliProviderRecord,
  EnvInjection,
  InvokeOpts,
} from './types.js';

export class CodexAdapter extends BaseCliAdapter {
  readonly providerName = 'codex' as const;
  readonly defaultExecutable = 'codex';
  readonly supportsSubagents = false;
  readonly supportsApi = true;
  readonly supportsCliAuth = true;
  readonly supportsMcp = true;
  readonly supportsPlugins = false;
  readonly defaultAuthMode = 'subscription' as const;
  readonly apiKeyEnvName = 'OPENAI_API_KEY';
  readonly defaultModel = 'o3';
  readonly rulesFile = 'AGENTS.md';
  readonly rulesFileMode = 'native' as const;

  buildCliInvocation(
    provider: CliProviderRecord,
    prompt: string,
    opts: InvokeOpts,
  ): CliCommandSpec {
    return {
      command: this.resolveExecutable(provider),
      args: this.mergedArgs(provider, ['exec', '--skip-git-repo-check', prompt]),
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
      prompt,
      model: this.effectiveModel(opts),
      maxOutputTokens: this.effectiveMaxTokens(opts),
    };
  }

  envInjection(_provider: CliProviderRecord): EnvInjection {
    return {
      envVars: {},
      extraArgs: [],
    };
  }
}
