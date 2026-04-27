import { BaseCliAdapter } from './base-adapter.js';
import type {
  ApiCallSpec,
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

export class ZaiAdapter extends BaseCliAdapter {
  readonly providerName = 'zai' as const;
  readonly defaultExecutable = 'claude';
  readonly supportsSubagents = true;
  readonly supportsApi = true;
  // Z.AI ships no standalone login subcommand — auth is API-key-only via
  // Z_AI_API_KEY → ANTHROPIC_API_KEY env mapping. Marking supportsCliAuth=true
  // misled the dispatcher and the auth-volume guard into demanding a login
  // flow that does not exist.
  readonly supportsCliAuth = false;
  readonly supportsMcp = true;
  readonly supportsPlugins = true;
  readonly defaultAuthMode = 'api_key' as const;
  // Z.AI distributes auth as a bearer token, not a long-lived API key. The
  // claude binary and the Anthropic SDK both accept ANTHROPIC_AUTH_TOKEN as
  // the credential variable for that flow.
  readonly apiKeyEnvName = 'ANTHROPIC_AUTH_TOKEN';
  // Z.AI exposes GLM models. `zai-latest` is not a real model code at the API
  // layer — sending it returns "Unknown Model". `glm-4.6` is the documented
  // default; users can override per-task or via ANTHROPIC_DEFAULT_*_MODEL.
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
    provider: CliProviderRecord,
    prompt: string,
    opts: InvokeOpts,
  ): ApiCallSpec {
    const env = provider.envVars ?? {};
    const baseUrl = env.ANTHROPIC_BASE_URL ?? env.Z_AI_API_URL ?? 'https://api.z.ai/api/anthropic';
    // claude-binary-style env overrides: surface the same knobs in API mode so
    // a Z.AI provider configured for the CLI (where the binary translates the
    // Sonnet/Opus/Haiku tier names into glm-* codes) keeps working when the
    // dispatcher picks the API path.
    const envModel =
      env.Z_AI_MODEL ??
      env.ANTHROPIC_DEFAULT_SONNET_MODEL ??
      env.ANTHROPIC_DEFAULT_OPUS_MODEL ??
      env.ANTHROPIC_DEFAULT_HAIKU_MODEL ??
      env.CLAUDE_MODEL;
    return {
      sdkPackage: '@anthropic-ai/sdk',
      defaultModel: envModel ?? this.defaultModel,
      apiKeyEnvName: this.apiKeyEnvName,
      baseUrl,
      prompt,
      model: opts.modelOverride ?? envModel ?? this.defaultModel,
      maxOutputTokens: this.effectiveMaxTokens(opts),
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
