import { BaseCliAdapter } from './base-adapter.js';
import type {
  ApiCallSpec,
  CliCommandSpec,
  CliProviderRecord,
  EnvInjection,
  InvokeOpts,
  SubAgentInvocation,
  SubAgentSpec,
} from './types.js';

export class ClaudeCodeAdapter extends BaseCliAdapter {
  readonly providerName = 'claude-code' as const;
  readonly defaultExecutable = 'claude';
  readonly supportsSubagents = true;
  readonly supportsApi = true;
  readonly supportsCliAuth = true;
  readonly defaultAuthMode = 'subscription' as const;
  readonly apiKeyEnvName = 'ANTHROPIC_API_KEY';
  readonly defaultModel = 'claude-sonnet-4-20250514';

  buildCliInvocation(
    provider: CliProviderRecord,
    prompt: string,
    opts: InvokeOpts,
  ): CliCommandSpec {
    return {
      command: this.resolveExecutable(provider),
      args: this.mergedArgs(provider, ['-p', prompt, '--output-format', 'json']),
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
      sdkPackage: '@anthropic-ai/sdk',
      defaultModel: this.defaultModel,
      apiKeyEnvName: this.apiKeyEnvName,
      prompt,
      model: this.effectiveModel(opts),
      maxOutputTokens: this.effectiveMaxTokens(opts),
    };
  }

  override buildSubAgentInvocation(
    _provider: CliProviderRecord,
    spec: SubAgentSpec,
    _opts: InvokeOpts,
  ): SubAgentInvocation {
    return {
      mode: 'native',
      steps: spec.subAgents.map((sub) => ({
        id: sub.name,
        prompt: sub.prompt,
        expectJsonOutput: true,
        collectInto: sub.outputKey,
      })),
      synthesis: {
        id: 'synthesis',
        prompt: spec.synthesisPrompt,
        expectJsonOutput: true,
      },
    };
  }

  envInjection(_provider: CliProviderRecord): EnvInjection {
    return {
      envVars: {},
      copyPaths: [
        { src: '~/.config/claude', dest: '/root/.config/claude', mode: 'dir', optional: true },
        { src: '~/.claude', dest: '/root/.claude', mode: 'dir', optional: true },
      ],
      extraArgs: [],
    };
  }
}
