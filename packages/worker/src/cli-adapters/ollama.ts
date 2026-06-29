import { isOllamaCloudModel } from '@haive/shared';
import { BaseCliAdapter } from './base-adapter.js';
import { claudeFamilyArgs, steeringUserMessageLine } from './steering.js';
import { OLLAMA_THINKING_PROXY_URL } from './ollama-thinking-proxy.js';
import type {
  CliCommandSpec,
  CliProviderRecord,
  EnvInjection,
  InvokeOpts,
  PluginInstallCommand,
  PluginInstallOpts,
} from './types.js';

// In-stack daemon default; remote/cloud providers override via
// provider.envVars.ANTHROPIC_BASE_URL (a remote host, or https://ollama.com).
const OLLAMA_DEFAULT_BASE_URL = 'http://ollama:11434';
// Ollama Cloud endpoint (serves an Anthropic-compatible /v1/messages API).
// Cloud models (isOllamaCloudModel, @haive/shared) route here by default.
const OLLAMA_CLOUD_URL = 'https://ollama.com';

// LSP plugin install via the claude binary's plugin marketplace — identical to
// the claude-code/zai adapters (same backend-agnostic `plugin` subcommands).
const OLLAMA_LSP_PLUGINS: Record<string, string> = {
  typescript: 'vtsls',
  python: 'pyright',
  go: 'gopls',
  rust: 'rust-analyzer',
  php: 'phpactor',
  java: 'jdtls',
};
const OLLAMA_LSP_MARKETPLACE_REF = 'Piebald-AI/claude-code-lsps';
const OLLAMA_LSP_MARKETPLACE_ID = 'claude-code-lsps';

export class OllamaAdapter extends BaseCliAdapter {
  readonly providerName = 'ollama' as const;
  // Ollama is a model runner, not an agentic CLI; reuse the claude binary
  // pointed at Ollama's Anthropic-compatible endpoint (same trick as zai).
  readonly defaultExecutable = 'claude';
  // Sub-agents run via the claude binary's native Task() against the Ollama
  // endpoint — the same mechanism zai uses, just a different backend. Capable
  // models (cloud, large local) drive it fine; weaker local models less so, but
  // that is a model choice. Scaffolding steps are protected by the
  // unsafeForLocalModels guardrail, not by this flag.
  readonly supportsSubagents = true;
  // No `claude /login` flow; the token arrives via env (a real key for
  // cloud/remote, or the literal 'ollama' for a local daemon). supportsCliAuth
  // stays true so the dispatcher's CLI path is available; assertUserAuthReady
  // short-circuits for authMode 'api_key'.
  readonly supportsCliAuth = true;
  readonly supportsMcp = true;
  // The claude binary's `plugin marketplace add` / `plugin install` subcommands
  // are backend-agnostic — they write into .claude/plugins without a model call,
  // so they work against the Ollama endpoint exactly as for claude-code/zai.
  readonly supportsPlugins = true;
  readonly defaultAuthMode = 'api_key' as const;
  // Secrets merge into env verbatim with no remap, so a cloud/remote key must be
  // stored under the env name the claude binary reads.
  readonly apiKeyEnvName = 'ANTHROPIC_AUTH_TOKEN';
  // No universal default; the per-provider `model` field must be set.
  readonly defaultModel = null;
  readonly rulesFile = 'CLAUDE.md';
  readonly rulesFileMode = 'import' as const;
  // Ollama Cloud host only. Local in-stack models are reached over the models
  // network (not egress); an external remote host is added per provider.
  override readonly defaultEgressDomains = ['ollama.com', '*.ollama.com'];
  override readonly supportsSteering = true;

  buildCliInvocation(
    provider: CliProviderRecord,
    prompt: string,
    opts: InvokeOpts,
  ): CliCommandSpec {
    const env = this.mergedEnv(provider, opts);
    const model = provider.model ?? this.defaultModel;
    if (!model) {
      throw new Error('ollama provider requires a model (set the provider model field)');
    }
    // Cloud models run on Ollama Cloud; route there by default. Other models
    // use the in-stack daemon. An explicit ANTHROPIC_BASE_URL always wins.
    // When "Disable model thinking" is on for a cloud model, route through the
    // thinking-disable proxy instead (it injects thinking:{type:"disabled"} and
    // forwards to ollama.com) so reasoning models that hide their answer in the
    // thinking channel return visible text. Only when we'd otherwise default to
    // ollama.com — a user-set base URL still wins.
    const useThinkingProxy =
      provider.disableThinking && isOllamaCloudModel(model) && !env.ANTHROPIC_BASE_URL;
    const defaultBaseUrl = useThinkingProxy
      ? OLLAMA_THINKING_PROXY_URL
      : isOllamaCloudModel(model)
        ? OLLAMA_CLOUD_URL
        : OLLAMA_DEFAULT_BASE_URL;
    env.ANTHROPIC_BASE_URL = env.ANTHROPIC_BASE_URL ?? defaultBaseUrl;
    // Token precedence: an explicit Anthropic token, else the Ollama API key
    // (cloud), else the literal 'ollama' a local daemon accepts. A key stored as
    // a SECRET named ANTHROPIC_AUTH_TOKEN overrides this after the post-build
    // merge; OLLAMA_API_KEY works when set in the provider's env vars.
    const token =
      env.ANTHROPIC_AUTH_TOKEN ?? env.ANTHROPIC_API_KEY ?? env.OLLAMA_API_KEY ?? 'ollama';
    env.ANTHROPIC_AUTH_TOKEN = token;
    env.ANTHROPIC_API_KEY = token;
    // The attribution header invalidates the KV cache on local models (~90%
    // slower); suppress it since the backend is not Anthropic.
    env.CLAUDE_CODE_ATTRIBUTION_HEADER = '0';
    env.ANTHROPIC_MODEL = model;
    const steering = opts.steeringMode === true;
    const spec: CliCommandSpec = {
      command: this.resolveExecutable(provider),
      args: this.mergedArgs(
        provider,
        claudeFamilyArgs({ steering, prompt, tail: ['--model', model] }),
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

  override buildShellEnv(
    provider: CliProviderRecord,
    secrets: Record<string, string>,
    extraEnv: Record<string, string> = {},
  ): Record<string, string> {
    const env = super.buildShellEnv(provider, secrets, extraEnv);
    const defaultBaseUrl =
      provider.model && isOllamaCloudModel(provider.model)
        ? OLLAMA_CLOUD_URL
        : OLLAMA_DEFAULT_BASE_URL;
    env.ANTHROPIC_BASE_URL = env.ANTHROPIC_BASE_URL ?? defaultBaseUrl;
    const token =
      env.ANTHROPIC_AUTH_TOKEN ?? env.ANTHROPIC_API_KEY ?? env.OLLAMA_API_KEY ?? 'ollama';
    // Interactive `claude` warns when both AUTH_TOKEN and API_KEY are set; set
    // only AUTH_TOKEN here (buildCliInvocation sets both for the non-interactive
    // path / older binaries).
    env.ANTHROPIC_AUTH_TOKEN = token;
    delete env.ANTHROPIC_API_KEY;
    env.CLAUDE_CODE_ATTRIBUTION_HEADER = '0';
    if (provider.model) env.ANTHROPIC_MODEL = provider.model;
    return env;
  }

  envInjection(_provider: CliProviderRecord): EnvInjection {
    return { envVars: {}, extraArgs: [] };
  }

  override buildPluginInstallCommands(
    provider: CliProviderRecord,
    opts: PluginInstallOpts,
  ): PluginInstallCommand[] {
    const exec = this.resolveExecutable(provider);
    const cmds: PluginInstallCommand[] = [];
    const lspPlugins = opts.lspLanguages
      .map((lang) => OLLAMA_LSP_PLUGINS[lang === 'php-extended' ? 'php' : lang])
      .filter((v): v is string => !!v);
    const uniqueLsp = [...new Set(lspPlugins)];
    if (uniqueLsp.length > 0) {
      cmds.push({
        description: `Add ${OLLAMA_LSP_MARKETPLACE_REF} marketplace`,
        command: exec,
        args: ['plugin', 'marketplace', 'add', OLLAMA_LSP_MARKETPLACE_REF],
      });
      for (const name of uniqueLsp) {
        cmds.push({
          description: `Install LSP plugin ${name}`,
          command: exec,
          args: ['plugin', 'install', `${name}@${OLLAMA_LSP_MARKETPLACE_ID}`],
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
