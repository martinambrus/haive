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

const ZAI_LSP_PLUGINS: Record<string, string> = {
  typescript: 'vtsls',
  python: 'pyright',
  go: 'gopls',
  rust: 'rust-analyzer',
  php: 'phpactor',
};
const ZAI_LSP_MARKETPLACE_REF = 'Piebald-AI/claude-code-lsps';
const ZAI_LSP_MARKETPLACE_ID = 'claude-code-lsps';

export class ZaiAdapter extends BaseCliAdapter {
  readonly providerName = 'zai' as const;
  readonly defaultExecutable = 'claude';
  readonly supportsSubagents = true;
  readonly supportsApi = true;
  readonly supportsCliAuth = true;
  readonly supportsMcp = true;
  readonly supportsPlugins = true;
  readonly defaultAuthMode = 'mixed' as const;
  readonly apiKeyEnvName = 'ANTHROPIC_API_KEY';
  readonly defaultModel = 'zai-latest';

  buildCliInvocation(
    provider: CliProviderRecord,
    prompt: string,
    opts: InvokeOpts,
  ): CliCommandSpec {
    const env = this.mergedEnv(provider, opts);
    if (env.Z_AI_API_URL) env.ANTHROPIC_BASE_URL = env.Z_AI_API_URL;
    if (env.Z_AI_API_KEY) env.ANTHROPIC_API_KEY = env.Z_AI_API_KEY;
    if (env.Z_AI_MODEL) env.CLAUDE_MODEL = env.Z_AI_MODEL;
    return {
      command: this.resolveExecutable(provider),
      args: this.mergedArgs(provider, [
        '--dangerously-skip-permissions',
        '-p',
        prompt,
        '--output-format',
        'stream-json',
        '--verbose',
      ]),
      env,
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
      baseUrl: 'https://api.zai.com/v1',
      prompt,
      model: this.effectiveModel(opts),
      maxOutputTokens: this.effectiveMaxTokens(opts),
    };
  }

  override maxThinkingEnv(): Record<string, string> {
    return { CLAUDE_CODE_EFFORT_LEVEL: 'max' };
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

  override buildPluginInstallCommands(
    provider: CliProviderRecord,
    opts: PluginInstallOpts,
  ): PluginInstallCommand[] {
    const exec = this.resolveExecutable(provider);
    const cmds: PluginInstallCommand[] = [];
    const lspPlugins = opts.lspLanguages
      .map((lang) => ZAI_LSP_PLUGINS[lang === 'php-extended' ? 'php' : lang])
      .filter((v): v is string => !!v);
    const uniqueLsp = [...new Set(lspPlugins)];
    if (uniqueLsp.length > 0) {
      cmds.push({
        description: `Add ${ZAI_LSP_MARKETPLACE_REF} marketplace`,
        command: exec,
        args: ['plugin', 'marketplace', 'add', ZAI_LSP_MARKETPLACE_REF],
      });
      for (const name of uniqueLsp) {
        cmds.push({
          description: `Install LSP plugin ${name}`,
          command: exec,
          args: ['plugin', 'install', `${name}@${ZAI_LSP_MARKETPLACE_ID}`],
        });
      }
    }
    if (opts.drupalLspPath) {
      cmds.push({
        description: 'Add local drupal-lsp marketplace',
        command: exec,
        args: ['plugin', 'marketplace', 'add', opts.drupalLspPath],
      });
      cmds.push({
        description: 'Install drupal-php-lsp plugin',
        command: exec,
        args: ['plugin', 'install', 'drupal-php-lsp@drupal-lsp-marketplace'],
      });
    }
    return cmds;
  }
}
