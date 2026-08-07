import { BaseCliAdapter } from './base-adapter.js';
import { claudeFamilyOutputTokenEnv } from './model-capabilities.js';
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

// Mirrors shared/catalog's MUSE_EFFORT_SCALE; keep the two in sync when levels
// change. The mirror image of ZAI_EFFORT_SCALE: Muse HAS `xhigh` but has no
// `max`, so neither the claude-code nor the zai scale fits.
//
// MEASURED, not copied from Meta's docs. Probing api.meta.ai /v1/messages with
// muse-spark-1.2 accepts low/medium/high/xhigh and rejects `max` and `minimal`
// with the same 400 an unknown value gets. Meta's docs page does list
// `none`/`minimal`, but that documents the OpenAI-compatible `reasoning_effort`
// parameter; the claude binary sends the Anthropic-compatible
// `output_config.effort`, where `minimal` is not accepted. Re-probe rather than
// "correcting" this list against that page.
//
// This scale is the whole reason muse is its own adapter: on claude-code an
// unset effort_level falls back to scale.max = 'max', so every Muse run 400'd.
const MUSE_EFFORT_SCALE: EffortScale = {
  values: ['low', 'medium', 'high', 'xhigh'],
  max: 'xhigh',
};

// PHP intentionally absent — see the CLAUDE_LSP_PLUGINS note in claude-code.ts.
// Haive installs no phpactor binary; PHP LSP is intelephense via the local
// drupal-php-lsp plugin, so php must not map to the marketplace phpactor plugin.
const MUSE_LSP_PLUGINS: Record<string, string> = {
  typescript: 'vtsls',
  python: 'pyright',
  go: 'gopls',
  rust: 'rust-analyzer',
  java: 'jdtls',
};
const MUSE_LSP_MARKETPLACE_REF = 'Piebald-AI/claude-code-lsps';
const MUSE_LSP_MARKETPLACE_ID = 'claude-code-lsps';

// Meta Model API root. Anthropic-wire-compatible, so the claude binary drives it
// unchanged once ANTHROPIC_BASE_URL points here.
const MUSE_DEFAULT_BASE_URL = 'https://api.meta.ai';

export class MuseAdapter extends BaseCliAdapter {
  readonly providerName = 'muse' as const;
  readonly defaultExecutable = 'claude';
  readonly supportsSubagents = true;
  // Meta ships no `claude /login` flow — credentials arrive as an env var. The
  // dispatcher's CLI path is gated on supportsCliAuth, but assertUserAuthReady
  // short-circuits when authMode is 'api_key', so this does not force a login.
  readonly supportsCliAuth = true;
  readonly supportsMcp = true;
  readonly supportsPlugins = true;
  override readonly supportsLsp = true;
  readonly defaultAuthMode = 'api_key' as const;
  // Meta issues a Model API key; the claude binary reads it from
  // ANTHROPIC_AUTH_TOKEN (preferred) or ANTHROPIC_API_KEY (older binaries).
  // buildCliInvocation writes both.
  readonly apiKeyEnvName = 'ANTHROPIC_AUTH_TOKEN';
  // Meta exposes muse-spark-1.1, muse-spark-1.2 and muse-spark-1.2-contributor;
  // users override per provider via the model field or ANTHROPIC_MODEL.
  readonly defaultModel = 'muse-spark-1.2';
  readonly rulesFile = 'CLAUDE.md';
  readonly rulesFileMode = 'import' as const;
  override readonly effortScale = MUSE_EFFORT_SCALE;
  override readonly defaultEgressDomains = ['api.meta.ai'];
  override readonly supportsSteering = true;

  buildCliInvocation(
    provider: CliProviderRecord,
    prompt: string,
    opts: InvokeOpts,
  ): CliCommandSpec {
    // No declared output-token ceiling: the claude binary's own 32000 default applies
    // until an overflow teaches us the model can do more (model-capabilities.ts). The
    // provider's envVars still win — mergedEnv spreads last.
    const env = { ...claudeFamilyOutputTokenEnv(provider), ...this.mergedEnv(provider, opts) };
    env.ANTHROPIC_BASE_URL = env.ANTHROPIC_BASE_URL ?? MUSE_DEFAULT_BASE_URL;
    const token = env.ANTHROPIC_AUTH_TOKEN ?? env.ANTHROPIC_API_KEY;
    if (token) {
      env.ANTHROPIC_AUTH_TOKEN = token;
      env.ANTHROPIC_API_KEY = token;
    }
    // The provider's model field wins over a stored ANTHROPIC_MODEL so the UI
    // picker is actually authoritative (the catalog advertises model selection).
    const model = provider.model ?? env.ANTHROPIC_MODEL ?? this.defaultModel;
    if (model) env.ANTHROPIC_MODEL = model;
    const steering = opts.steeringMode === true;
    const spec: CliCommandSpec = {
      command: this.resolveExecutable(provider),
      args: this.mergedArgs(
        provider,
        claudeFamilyArgs({
          steering,
          prompt,
          disallowedTools: opts.disallowedTools,
          disableTools: opts.disableTools,
        }),
      ),
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
    env.ANTHROPIC_BASE_URL = env.ANTHROPIC_BASE_URL ?? MUSE_DEFAULT_BASE_URL;
    // Interactive `claude` warns when both ANTHROPIC_AUTH_TOKEN and
    // ANTHROPIC_API_KEY are present. Set only AUTH_TOKEN here; the
    // non-interactive orchestrator path (buildCliInvocation) still sets both
    // for compat with older claude binaries.
    const token = env.ANTHROPIC_AUTH_TOKEN ?? env.ANTHROPIC_API_KEY;
    if (token) {
      env.ANTHROPIC_AUTH_TOKEN = token;
    }
    delete env.ANTHROPIC_API_KEY;
    const model = provider.model ?? env.ANTHROPIC_MODEL ?? this.defaultModel;
    if (model) env.ANTHROPIC_MODEL = model;
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
      .map((lang) => MUSE_LSP_PLUGINS[lang === 'php-extended' ? 'php' : lang])
      .filter((v): v is string => !!v);
    const uniqueLsp = [...new Set(lspPlugins)];
    if (uniqueLsp.length > 0) {
      cmds.push({
        description: `Add ${MUSE_LSP_MARKETPLACE_REF} marketplace`,
        command: exec,
        args: ['plugin', 'marketplace', 'add', MUSE_LSP_MARKETPLACE_REF],
      });
      for (const name of uniqueLsp) {
        cmds.push({
          description: `Install LSP plugin ${name}`,
          command: exec,
          args: ['plugin', 'install', `${name}@${MUSE_LSP_MARKETPLACE_ID}`],
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
