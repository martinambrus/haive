import { BaseCliAdapter } from './base-adapter.js';
import { claudeFamilyArgs, steeringUserMessageLine } from './steering.js';
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

// PHP intentionally absent — see the CLAUDE_LSP_PLUGINS note in claude-code.ts.
// Haive installs no phpactor binary; PHP LSP is intelephense via the local
// drupal-php-lsp plugin, so php must not map to the marketplace phpactor plugin.
const ZAI_LSP_PLUGINS: Record<string, string> = {
  typescript: 'vtsls',
  python: 'pyright',
  go: 'gopls',
  rust: 'rust-analyzer',
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
  // Default Z.AI host; a custom Z_AI_API_URL/ANTHROPIC_BASE_URL is added per
  // provider via egressDomains.
  override readonly defaultEgressDomains = ['api.z.ai'];
  override readonly supportsSteering = true;

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
    const steering = opts.steeringMode === true;
    const spec: CliCommandSpec = {
      command: this.resolveExecutable(provider),
      args: this.mergedArgs(provider, claudeFamilyArgs({ steering, prompt })),
      env,
      cwd: opts.cwd,
      outputFormat: 'claude-stream-json',
    };
    if (steering) {
      spec.stdinInitial = steeringUserMessageLine(prompt);
      spec.steerable = true;
    }
    return spec;
  }

  override effortEnv(level: string): Record<string, string> {
    return { CLAUDE_CODE_EFFORT_LEVEL: level };
  }

  override buildShellEnv(
    provider: CliProviderRecord,
    secrets: Record<string, string>,
    extraEnv: Record<string, string> = {},
  ): Record<string, string> {
    const env = super.buildShellEnv(provider, secrets, extraEnv);
    const baseUrl = env.Z_AI_API_URL ?? env.ANTHROPIC_BASE_URL ?? ZAI_DEFAULT_BASE_URL;
    env.ANTHROPIC_BASE_URL = baseUrl;
    // Interactive `claude` warns when both ANTHROPIC_AUTH_TOKEN and
    // ANTHROPIC_API_KEY are present. Set only AUTH_TOKEN here; the
    // non-interactive orchestrator path (buildCliInvocation) still sets
    // both for compat with older claude binaries.
    const token = env.Z_AI_API_KEY ?? env.ANTHROPIC_AUTH_TOKEN ?? env.ANTHROPIC_API_KEY;
    if (token) {
      env.ANTHROPIC_AUTH_TOKEN = token;
    }
    delete env.ANTHROPIC_API_KEY;
    if (env.Z_AI_MODEL) env.CLAUDE_MODEL = env.Z_AI_MODEL;
    return env;
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
