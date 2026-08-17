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

// MEASURED against openrouter.ai/api/v1/messages, not copied from docs. Posting
// `output_config.effort` with an out-of-range value returns a 400 whose body
// enumerates the accepted set:
//   "Invalid option: expected one of \"low\"|\"medium\"|\"high\"|\"xhigh\"|\"max\""
// so this is the gateway's own contract, and it is the full five-level claude-code
// scale rather than the four-level CLAUDE_LIKE one the other wrapper adapters use.
//
// Validation is GLOBAL, not per-model: the identical enum comes back for a model
// whose `supported_parameters` has no `reasoning` at all (probed on
// ibm-granite/granite-4.1-8b). Such models accept every level with a 200 and
// normalize it away downstream, so no level can 400 on a model basis — which is
// why this adapter needs no bespoke defaulting and inherits base-adapter's
// unset -> scale.max behaviour like every other claude-family wrapper.
//
// Re-probe rather than "correcting" this list against OpenRouter's docs page.
const OPENROUTER_EFFORT_SCALE: EffortScale = {
  values: ['low', 'medium', 'high', 'xhigh', 'max'],
  max: 'max',
};

// PHP intentionally absent — see the CLAUDE_LSP_PLUGINS note in claude-code.ts.
// Haive installs no phpactor binary; PHP LSP is intelephense via the local
// drupal-php-lsp plugin, so php must not map to the marketplace phpactor plugin.
const OPENROUTER_LSP_PLUGINS: Record<string, string> = {
  typescript: 'vtsls',
  python: 'pyright',
  go: 'gopls',
  rust: 'rust-analyzer',
  java: 'jdtls',
};
const OPENROUTER_LSP_MARKETPLACE_REF = 'Piebald-AI/claude-code-lsps';
const OPENROUTER_LSP_MARKETPLACE_ID = 'claude-code-lsps';

// OpenRouter's Anthropic-compatible root ("Anthropic Skin"). NO `/v1` and no
// trailing slash: the claude binary appends `/v1/messages` itself, so anything
// more specific here produces a 404 on a path the binary built.
const OPENROUTER_DEFAULT_BASE_URL = 'https://openrouter.ai/api';

export class OpenRouterAdapter extends BaseCliAdapter {
  readonly providerName = 'openrouter' as const;
  readonly defaultExecutable = 'claude';
  readonly supportsSubagents = true;
  // OpenRouter ships no `claude /login` flow — the key arrives as an env var. The
  // dispatcher's CLI path is gated on supportsCliAuth, but assertUserAuthReady
  // short-circuits when authMode is 'api_key', so this does not force a login.
  readonly supportsCliAuth = true;
  readonly supportsMcp = true;
  readonly supportsPlugins = true;
  override readonly supportsLsp = true;
  readonly defaultAuthMode = 'api_key' as const;
  // OpenRouter issues an `sk-or-...` key. Both ANTHROPIC_AUTH_TOKEN (Authorization:
  // Bearer) and ANTHROPIC_API_KEY (x-api-key) are accepted by the endpoint, together
  // or separately — probed, see the catalog entry. buildCliInvocation writes both,
  // matching every other claude-family adapter.
  readonly apiKeyEnvName = 'ANTHROPIC_AUTH_TOKEN';
  // No universal default: OpenRouter fronts 400+ models and picking one for the user
  // would silently bill a model they never chose. The provider's model field is
  // required.
  readonly defaultModel = null;
  readonly rulesFile = 'CLAUDE.md';
  readonly rulesFileMode = 'import' as const;
  override readonly effortScale = OPENROUTER_EFFORT_SCALE;
  override readonly defaultEgressDomains = ['openrouter.ai'];
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
    env.ANTHROPIC_BASE_URL = env.ANTHROPIC_BASE_URL ?? OPENROUTER_DEFAULT_BASE_URL;
    const token = env.ANTHROPIC_AUTH_TOKEN ?? env.ANTHROPIC_API_KEY;
    if (token) {
      env.ANTHROPIC_AUTH_TOKEN = token;
      env.ANTHROPIC_API_KEY = token;
    }
    // The provider's model field wins over a stored ANTHROPIC_MODEL so the model
    // picker is actually authoritative (the catalog advertises model selection).
    // Values are OpenRouter slugs (`anthropic/claude-opus-5`), not bare model ids.
    const model = provider.model ?? env.ANTHROPIC_MODEL ?? this.defaultModel;
    if (model) env.ANTHROPIC_MODEL = model;
    // The attribution header is an Anthropic-specific hint; the backend here is a
    // gateway, so suppress it for the same reason ollama does.
    env.CLAUDE_CODE_ATTRIBUTION_HEADER = '0';
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
    env.ANTHROPIC_BASE_URL = env.ANTHROPIC_BASE_URL ?? OPENROUTER_DEFAULT_BASE_URL;
    // Interactive `claude` warns when both ANTHROPIC_AUTH_TOKEN and
    // ANTHROPIC_API_KEY are present. Set only AUTH_TOKEN here; the
    // non-interactive orchestrator path (buildCliInvocation) still sets both for
    // compat with older claude binaries.
    const token = env.ANTHROPIC_AUTH_TOKEN ?? env.ANTHROPIC_API_KEY;
    if (token) {
      env.ANTHROPIC_AUTH_TOKEN = token;
    }
    delete env.ANTHROPIC_API_KEY;
    env.CLAUDE_CODE_ATTRIBUTION_HEADER = '0';
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
      .map((lang) => OPENROUTER_LSP_PLUGINS[lang === 'php-extended' ? 'php' : lang])
      .filter((v): v is string => !!v);
    const uniqueLsp = [...new Set(lspPlugins)];
    if (uniqueLsp.length > 0) {
      cmds.push({
        description: `Add ${OPENROUTER_LSP_MARKETPLACE_REF} marketplace`,
        command: exec,
        args: ['plugin', 'marketplace', 'add', OPENROUTER_LSP_MARKETPLACE_REF],
      });
      for (const name of uniqueLsp) {
        cmds.push({
          description: `Install LSP plugin ${name}`,
          command: exec,
          args: ['plugin', 'install', `${name}@${OPENROUTER_LSP_MARKETPLACE_ID}`],
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
