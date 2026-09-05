import { isOllamaCloudModel } from '@haive/shared';
import { BaseCliAdapter } from './base-adapter.js';
import { claudeFamilyOutputTokenEnv } from './model-capabilities.js';
import { claudeFamilyArgs, steeringUserMessageLine } from './steering.js';
import {
  OLLAMA_CLOUD_URL,
  OLLAMA_DEFAULT_BASE_URL,
  resolveOllamaBaseUrl,
} from './ollama-thinking-proxy.js';
import type {
  CliCommandSpec,
  CliProviderRecord,
  EffortScale,
  EnvInjection,
  InvokeOpts,
  PluginInstallCommand,
  PluginInstallOpts,
} from './types.js';

// Mirrors shared/catalog's OLLAMA_EFFORT_SCALE; keep the two in sync when levels
// change. The only scale in the codebase whose default is NOT its top level.
//
// MEASURED against the running daemon and the claude binary, not copied from
// Ollama's docs — those document `/api/chat`'s `think` and `/v1/chat/completions`'
// `reasoning_effort`, neither of which is the endpoint this adapter uses.
//
// How the level actually arrives: the claude binary posts `output_config.effort`
// alongside `thinking:{"type":"adaptive"}`. Ollama's Anthropic layer honors
// `thinking.type` only for the literals "enabled"/"disabled", so `adaptive` always
// falls through to the effort branch, which accepts exactly low/medium/high/max
// (`api.ThinkValue.IsValid`) and folds `xhigh` into `high`. An out-of-range level
// never 400s: it leaves the think value unset, which Ollama then forces to `true`
// for a thinking-capable model. That is also why an unset CLAUDE_CODE_EFFORT_LEVEL
// is not "no thinking" — the binary defaults to `high` on its own.
//
// `max` is exposed but is deliberately NOT the default:
//   - gpt-oss:120b-cloud does not recognise it as a harmony level. Asked to read
//     its own reasoning setting back it echoes "max", but reasons LESS than at
//     `high` (385 vs 9612 thinking chars on the same prompt).
//   - deepseek-v4-pro:cloud at `max` spent an entire 8000-token budget in the
//     thinking channel and returned empty visible text — the exact failure the
//     disable-thinking proxy exists to work around.
// `high` is additionally what the binary already sent before this scale existed,
// so it keeps every pre-existing provider on its current behaviour. Models that
// do reason harder at `max` (deepseek-v4-pro, kimi-k3) can still opt in per
// provider. Re-probe rather than "correcting" this to match ZAI_EFFORT_SCALE.
//
// Orthogonal to the level: for many LOCAL models it only toggles thinking on/off.
// Every built-in renderer in ollama 0.24.0 reads `think.Bool()` and none reads
// `ThinkLevel`, so local qwen3.5 et al. are flat across all four. Ollama Cloud
// models are rendered upstream and do honor it.
const OLLAMA_EFFORT_SCALE: EffortScale = {
  values: ['low', 'medium', 'high', 'max'],
  max: 'high',
};

// LSP plugin install via the claude binary's plugin marketplace — identical to
// the claude-code/zai adapters (same backend-agnostic `plugin` subcommands).
// PHP intentionally absent — see the CLAUDE_LSP_PLUGINS note in claude-code.ts.
// Haive installs no phpactor binary; PHP LSP is intelephense via the local
// drupal-php-lsp plugin, so php must not map to the marketplace phpactor plugin.
const OLLAMA_LSP_PLUGINS: Record<string, string> = {
  typescript: 'vtsls',
  python: 'pyright',
  go: 'gopls',
  rust: 'rust-analyzer',
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
  override readonly supportsLsp = true;
  readonly defaultAuthMode = 'api_key' as const;
  // Secrets merge into env verbatim with no remap, so a cloud/remote key must be
  // stored under the env name the claude binary reads.
  readonly apiKeyEnvName = 'ANTHROPIC_AUTH_TOKEN';
  // No universal default; the per-provider `model` field must be set.
  readonly defaultModel = null;
  readonly rulesFile = 'CLAUDE.md';
  readonly rulesFileMode = 'import' as const;
  override readonly effortScale = OLLAMA_EFFORT_SCALE;
  // Ollama Cloud host only. Local in-stack models are reached over the models
  // network (not egress); an external remote host is added per provider.
  override readonly defaultEgressDomains = ['ollama.com', '*.ollama.com'];
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
    const model = provider.model ?? this.defaultModel;
    if (!model) {
      throw new Error('ollama provider requires a model (set the provider model field)');
    }
    env.ANTHROPIC_BASE_URL = resolveOllamaBaseUrl(env, {
      model,
      disableThinking: provider.disableThinking,
    });
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
    const invocation = claudeFamilyArgs({
      steering,
      prompt,
      tail: ['--model', model],
      disallowedTools: opts.disallowedTools,
      disableTools: opts.disableTools,
    });
    const spec: CliCommandSpec = {
      command: this.resolveExecutable(provider),
      args: this.mergedArgs(provider, invocation.args),
      env,
      cwd: opts.cwd,
      outputFormat: 'claude-stream-json',
      // Only when the prompt was too large for argv; steering delivers it as a
      // stdin user-message and leaves this unset.
      ...(invocation.stdinPrompt ? { stdinPrompt: invocation.stdinPrompt } : {}),
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
