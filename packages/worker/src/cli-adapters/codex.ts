import { BaseCliAdapter } from './base-adapter.js';
import type {
  CliCommandSpec,
  CliProviderRecord,
  EffortScale,
  EnvInjection,
  InvokeOpts,
} from './types.js';

// Mirrors shared/catalog's CODEX_EFFORT_SCALE. Duplicated here because the
// adapter layer reads the scale directly off itself (effortScale is on every
// adapter), and we don't want worker code importing shared/catalog just for
// one constant. Keep the two in sync when adding/removing levels. `minimal` is
// omitted (it disables web search); `max`/`ultra` are the newest, highest
// levels and are model-dependent, so an unsupported model rejects the run.
const CODEX_EFFORT_SCALE: EffortScale = {
  values: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  max: 'ultra',
};

export class CodexAdapter extends BaseCliAdapter {
  readonly providerName = 'codex' as const;
  readonly defaultExecutable = 'codex';
  readonly supportsSubagents = false;
  readonly supportsCliAuth = true;
  readonly supportsMcp = true;
  readonly supportsPlugins = false;
  readonly defaultAuthMode = 'subscription' as const;
  readonly apiKeyEnvName = 'OPENAI_API_KEY';
  readonly defaultModel = 'o3';
  readonly rulesFile = 'AGENTS.md';
  readonly rulesFileMode = 'native' as const;
  override readonly effortScale = CODEX_EFFORT_SCALE;
  override readonly defaultEgressDomains = ['api.openai.com', 'chatgpt.com'];

  buildCliInvocation(
    provider: CliProviderRecord,
    prompt: string,
    opts: InvokeOpts,
  ): CliCommandSpec {
    // Codex expects reasoning effort as a `codex exec -c key=value` override,
    // not as an environment variable. TOML string values require quotes, so
    // we wrap the level (e.g. `model_reasoning_effort="high"`). Emitting
    // nothing when resolveEffortLevel returns null keeps the CLI at its own
    // configured default.
    const level = this.resolveEffortLevel(provider, opts);
    const reasoningArgs = level ? ['-c', `model_reasoning_effort="${level}"`] : [];
    return {
      command: this.resolveExecutable(provider),
      // Haive runs every CLI inside an isolated per-task Docker container, so
      // Codex's own bwrap/Landlock sandbox is both redundant and unable to
      // start: nested unprivileged user namespaces are blocked, so it fails
      // every `bash -lc` with "No permissions to create a new namespace" and
      // degrades to read-only MCP. Bypass it — the container is the boundary.
      // `--json` switches stdout to a JSONL event stream so token usage
      // (turn.completed events) can be captured; the final answer text is the
      // last agent_message item. Placed right after `exec` so it binds to the
      // subcommand.
      args: this.mergedArgs(provider, [
        'exec',
        '--json',
        '--dangerously-bypass-approvals-and-sandbox',
        // Disable Codex's own multi-agent/subagent system (features.multi_agent_v2,
        // whose MultiAgentMode can proactively spawn Collab subagents). Haive never
        // uses Codex's native subagents (supportsSubagents=false — the sub-agent
        // emulator emits a sequential script instead), so a mining agent spawning
        // its own agents only duplicates work and burns tokens. `--disable <feature>`
        // == `-c features.<name>=false`; unknown features are ignored (no
        // --strict-config), so this fails safe if the feature is renamed upstream.
        '--disable',
        'multi_agent_v2',
        ...reasoningArgs,
        '--skip-git-repo-check',
        prompt,
      ]),
      env: this.mergedEnv(provider, opts),
      cwd: opts.cwd,
      outputFormat: 'codex-jsonl',
    };
  }

  envInjection(_provider: CliProviderRecord): EnvInjection {
    return {
      envVars: {},
      extraArgs: [],
    };
  }
}
