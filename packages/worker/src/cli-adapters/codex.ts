import { BaseCliAdapter } from './base-adapter.js';
import type {
  CliCommandSpec,
  CliProviderRecord,
  EffortScale,
  EnvInjection,
  InvokeOpts,
  SteeringTransportContext,
} from './types.js';
import { deliverPrompt } from './prompt-delivery.js';
import { isCodexAppServerSupported } from './codex-app-server-verdict.js';

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

/** `codex app-server` takes the same feature switch as `codex exec` (see execBaseArgs) — verified
 *  in its own --help on 0.154.0. Approvals, sandbox, model, effort and the prompt are NOT flags
 *  here: they travel in the JSON-RPC requests (cli-executor/codex-app-server.ts). */
const CODEX_APP_SERVER_ARGS: readonly string[] = ['app-server', '--disable', 'multi_agent_v2'];

export class CodexAdapter extends BaseCliAdapter {
  readonly providerName = 'codex' as const;
  readonly defaultExecutable = 'codex';
  readonly supportsSubagents = false;
  readonly supportsCliAuth = true;
  readonly supportsMcp = true;
  readonly supportsPlugins = false;
  readonly defaultAuthMode = 'subscription' as const;
  readonly apiKeyEnvName = 'OPENAI_API_KEY';
  readonly defaultModel = 'gpt-5.6-sol';
  readonly rulesFile = 'AGENTS.md';
  readonly rulesFileMode = 'native' as const;
  override readonly effortScale = CODEX_EFFORT_SCALE;
  override readonly defaultEgressDomains = ['api.openai.com', 'chatgpt.com'];
  /** Steerable through codex's [experimental] app-server protocol: `codex exec` reads its prompt
   *  to EOF and never listens again. Whether a given run may use it is decided per task, by
   *  steeringTransportReady below. */
  override readonly supportsSteering = true;

  /** Only for a provider whose binary passed the zero-token app-server probe in this task, and
   *  while that verdict still matches its CLI version. Everything else keeps `codex exec`. */
  override steeringTransportReady(
    provider: CliProviderRecord,
    ctx: SteeringTransportContext,
  ): boolean {
    return isCodexAppServerSupported(ctx.codexAppServer, provider);
  }

  buildCliInvocation(
    provider: CliProviderRecord,
    prompt: string,
    opts: InvokeOpts,
  ): CliCommandSpec {
    const effort = this.resolveEffortLevel(provider, opts);
    if (opts.steeringMode) {
      return {
        command: this.resolveExecutable(provider),
        args: this.mergedArgs(provider, [...CODEX_APP_SERVER_ARGS]),
        env: this.mergedEnv(provider, opts),
        cwd: opts.cwd,
        outputFormat: 'codex-app-server',
        steerable: true,
        codexAppServer: {
          prompt,
          model: provider.model ?? null,
          effort,
          execArgs: this.mergedArgs(provider, this.execBaseArgs(provider, effort)),
        },
      };
    }
    // `codex exec` reads instructions from stdin when no PROMPT argument is
    // given (its own --help says so), which is the only way a plan prompt over
    // 128 KiB can reach it at all.
    const delivery = deliverPrompt(prompt, { adapter: 'codex', stdin: true });
    return {
      command: this.resolveExecutable(provider),
      args: this.mergedArgs(provider, [...this.execBaseArgs(provider, effort), ...delivery.argv]),
      ...(delivery.stdinPrompt ? { stdinPrompt: delivery.stdinPrompt } : {}),
      env: this.mergedEnv(provider, opts),
      cwd: opts.cwd,
      outputFormat: 'codex-jsonl',
    };
  }

  /** The `codex exec` argv up to, and not including, the prompt. One builder for the one-shot run
   *  and for the app-server spec's fallback, so the two cannot drift. */
  private execBaseArgs(provider: CliProviderRecord, effort: string | null): string[] {
    // Codex expects reasoning effort as a `codex exec -c key=value` override,
    // not as an environment variable. TOML string values require quotes, so
    // we wrap the level (e.g. `model_reasoning_effort="high"`). Emitting
    // nothing when resolveEffortLevel returns null keeps the CLI at its own
    // configured default.
    const reasoningArgs = effort ? ['-c', `model_reasoning_effort="${effort}"`] : [];
    // Same contract as the effort override: emit nothing when the provider has
    // no model set, so the CLI keeps whatever its own config selects. Until this
    // existed the stored model could not reach the run at all, which made the
    // field look configurable while doing nothing. The long form is the one
    // requestedFromSpec reads: while this passed `-m`, not one codex exec run
    // recorded the model it asked for (MEASURED, 0 of 624 on the dev install).
    const modelArgs = provider.model ? ['--model', provider.model] : [];
    // Haive runs every CLI inside an isolated per-task Docker container, so
    // Codex's own bwrap/Landlock sandbox is both redundant and unable to
    // start: nested unprivileged user namespaces are blocked, so it fails
    // every `bash -lc` with "No permissions to create a new namespace" and
    // degrades to read-only MCP. Bypass it — the container is the boundary.
    // `--json` switches stdout to a JSONL event stream so token usage
    // (turn.completed events) can be captured; the final answer text is the
    // last agent_message item. Placed right after `exec` so it binds to the
    // subcommand.
    return [
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
      ...modelArgs,
      '--skip-git-repo-check',
    ];
  }

  envInjection(_provider: CliProviderRecord): EnvInjection {
    return {
      envVars: {},
      extraArgs: [],
    };
  }
}

/** The `codex exec` form of an app-server invocation. The executor runs it when the app-server
 *  could not even accept the turn, so no work was done and nothing is repeated. The prompt goes
 *  over stdin — the route this adapter already uses for a prompt too large for argv — so one form
 *  serves every size. Null for a spec that is not an app-server one. */
export function codexExecFallbackSpec(spec: CliCommandSpec): CliCommandSpec | null {
  const turn = spec.codexAppServer;
  if (!turn) return null;
  return {
    command: spec.command,
    args: turn.execArgs,
    env: spec.env,
    cwd: spec.cwd,
    outputFormat: 'codex-jsonl',
    stdinPrompt: turn.prompt,
  };
}
