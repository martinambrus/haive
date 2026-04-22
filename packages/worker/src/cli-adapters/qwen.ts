import { BaseCliAdapter } from './base-adapter.js';
import type {
  ApiCallSpec,
  CliCommandSpec,
  CliProviderRecord,
  EnvInjection,
  InvokeOpts,
  PluginInstallCommand,
  PluginInstallOpts,
} from './types.js';

const QWEN_LSP_MARKETPLACE = 'Piebald-AI/claude-code-lsps';

export class QwenAdapter extends BaseCliAdapter {
  readonly providerName = 'qwen' as const;
  readonly defaultExecutable = 'qwen';
  readonly supportsSubagents = false;
  readonly supportsApi = true;
  readonly supportsCliAuth = true;
  readonly supportsMcp = false;
  readonly supportsPlugins = true;
  readonly defaultAuthMode = 'mixed' as const;
  readonly apiKeyEnvName = 'DASHSCOPE_API_KEY';
  readonly defaultModel = 'qwen-max';
  readonly rulesFile = 'QWEN.md';
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

  override buildPluginInstallCommands(
    provider: CliProviderRecord,
    opts: PluginInstallOpts,
  ): PluginInstallCommand[] {
    const exec = this.resolveExecutable(provider);
    const cmds: PluginInstallCommand[] = [];
    if (opts.lspLanguages.length > 0) {
      cmds.push({
        description: `Install LSP extensions from ${QWEN_LSP_MARKETPLACE}`,
        command: exec,
        args: ['extensions', 'install', QWEN_LSP_MARKETPLACE],
      });
    }
    if (opts.drupalLspPath) {
      cmds.push({
        description: 'Install drupal-php-lsp extension',
        command: exec,
        args: ['extensions', 'install', opts.drupalLspPath],
      });
    }
    return cmds;
  }
}
