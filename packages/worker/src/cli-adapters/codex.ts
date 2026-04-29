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
// one constant. Keep the two in sync when adding/removing levels.
const CODEX_EFFORT_SCALE: EffortScale = {
  values: ['minimal', 'low', 'medium', 'high', 'xhigh'],
  max: 'xhigh',
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
      args: this.mergedArgs(provider, ['exec', ...reasoningArgs, '--skip-git-repo-check', prompt]),
      env: this.mergedEnv(provider, opts),
      cwd: opts.cwd,
    };
  }

  envInjection(_provider: CliProviderRecord): EnvInjection {
    return {
      envVars: {},
      extraArgs: [],
    };
  }
}
