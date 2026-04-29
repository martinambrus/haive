import { BaseCliAdapter } from './base-adapter.js';
import type {
  CliCommandSpec,
  CliProviderRecord,
  EffortScale,
  EnvInjection,
  InvokeOpts,
  PluginInstallCommand,
  PluginInstallOpts,
} from './types.js';

const ZAI_EFFORT_SCALE: EffortScale = {
  values: ['low', 'medium', 'high', 'max'],
  max: 'max',
};

const ZAI_LSP_PLUGINS: Record<string, string> = {
  typescript: 'vtsls',
  python: 'pyright',
  go: 'gopls',
  rust: 'rust-analyzer',
  php: 'phpactor',
  java: 'jdtls',
};
const ZAI_LSP_MARKETPLACE_REF = 'Piebald-AI/claude-code-lsps';
const ZAI_LSP_MARKETPLACE_ID = 'claude-code-lsps';

const ZAI_DEFAULT_BASE_URL = 'https://api.z.ai/api/anthropic';

export class ZaiAdapter extends BaseCliAdapter {
  readonly providerName = 'zai' as const;
  readonly defaultExecutable = 'claude';
  readonly supportsSubagents = true;
  // Z.AI ships no `claude /login` flow — credentials arrive via env vars
  // (Z_AI_API_KEY / ANTHROPIC_AUTH_TOKEN). The dispatcher's CLI path is gated
  // on supportsCliAuth, but assertUserAuthReady short-circuits when authMode
  // is 'api_key', so re-enabling this no longer forces a login.
  readonly supportsCliAuth = true;
  readonly supportsMcp = true;
  readonly supportsPlugins = true;
  readonly defaultAuthMode = 'api_key' as const;
  // Z.AI distributes auth as a bearer token; the claude binary accepts it via
  // ANTHROPIC_AUTH_TOKEN (preferred) or ANTHROPIC_API_KEY (fallback for older
  // binaries). buildCliInvocation writes both.
  readonly apiKeyEnvName = 'ANTHROPIC_AUTH_TOKEN';
  // Z.AI exposes GLM models. `glm-4.6` is the documented default; users can
  // override per-task or via ANTHROPIC_DEFAULT_*_MODEL.
  readonly defaultModel = 'glm-4.6';
  readonly rulesFile = 'CLAUDE.md';
  readonly rulesFileMode = 'import' as const;
  override readonly effortScale = ZAI_EFFORT_SCALE;

  buildCliInvocation(
    provider: CliProviderRecord,
    prompt: string,
    opts: InvokeOpts,
  ): CliCommandSpec {
    const env = this.mergedEnv(provider, opts);
    const baseUrl = env.Z_AI_API_URL ?? env.ANTHROPIC_BASE_URL ?? ZAI_DEFAULT_BASE_URL;
    env.ANTHROPIC_BASE_URL = baseUrl;
    const token = env.Z_AI_API_KEY ?? env.ANTHROPIC_AUTH_TOKEN ?? env.ANTHROPIC_API_KEY;
    if (token) {
      env.ANTHROPIC_AUTH_TOKEN = token;
      env.ANTHROPIC_API_KEY = token;
    }
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

  override effortEnv(level: string): Record<string, string> {
    return { CLAUDE_CODE_EFFORT_LEVEL: level };
  }

  envInjection(_provider: CliProviderRecord): EnvInjection {
    return {
      envVars: {},
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
