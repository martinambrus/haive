import { BaseCliAdapter } from './base-adapter.js';
import type { CliCommandSpec, CliProviderRecord, EnvInjection, InvokeOpts } from './types.js';

// In-stack daemon default; remote/cloud providers override via
// provider.envVars.ANTHROPIC_BASE_URL (a remote host, or https://ollama.com).
const OLLAMA_DEFAULT_BASE_URL = 'http://ollama:11434';

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
  readonly supportsPlugins = false;
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

  buildCliInvocation(
    provider: CliProviderRecord,
    prompt: string,
    opts: InvokeOpts,
  ): CliCommandSpec {
    const env = this.mergedEnv(provider, opts);
    env.ANTHROPIC_BASE_URL = env.ANTHROPIC_BASE_URL ?? OLLAMA_DEFAULT_BASE_URL;
    // Local Ollama accepts any non-empty token; cloud/remote inject a real key
    // via a secret named ANTHROPIC_AUTH_TOKEN (merged in after this runs).
    const token = env.ANTHROPIC_AUTH_TOKEN ?? env.ANTHROPIC_API_KEY ?? 'ollama';
    env.ANTHROPIC_AUTH_TOKEN = token;
    env.ANTHROPIC_API_KEY = token;
    // The attribution header invalidates the KV cache on local models (~90%
    // slower); suppress it since the backend is not Anthropic.
    env.CLAUDE_CODE_ATTRIBUTION_HEADER = '0';
    const model = opts.modelOverride ?? provider.model ?? this.defaultModel;
    if (!model) {
      throw new Error('ollama provider requires a model (set the provider model field)');
    }
    env.ANTHROPIC_MODEL = model;
    return {
      command: this.resolveExecutable(provider),
      args: this.mergedArgs(provider, [
        '--dangerously-skip-permissions',
        '-p',
        prompt,
        '--output-format',
        'stream-json',
        '--verbose',
        '--model',
        model,
      ]),
      env,
      cwd: opts.cwd,
      outputFormat: 'claude-stream-json',
    };
  }

  override buildShellEnv(
    provider: CliProviderRecord,
    secrets: Record<string, string>,
    extraEnv: Record<string, string> = {},
  ): Record<string, string> {
    const env = super.buildShellEnv(provider, secrets, extraEnv);
    env.ANTHROPIC_BASE_URL = env.ANTHROPIC_BASE_URL ?? OLLAMA_DEFAULT_BASE_URL;
    const token = env.ANTHROPIC_AUTH_TOKEN ?? env.ANTHROPIC_API_KEY ?? 'ollama';
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
}
