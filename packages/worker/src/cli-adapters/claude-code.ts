import { buildLspMarketplaceCommands } from './_lsp-marketplace.js';
import { BaseCliAdapter } from './base-adapter.js';
import { claudeFamilyOutputTokenEnv } from './model-capabilities.js';
import { CLAUDE_FAMILY_SKILLS_ENV, claudeFamilyArgs, steeringUserMessageLine } from './steering.js';
import type {
  CliCommandSpec,
  CliProviderRecord,
  EffortScale,
  InvokeOpts,
  PluginInstallCommand,
  PluginInstallOpts,
} from './types.js';

// Mirrors shared/catalog's CLAUDE_CODE_EFFORT_SCALE. `xhigh` sits between
// `high` and `max`; keep the two in sync when levels change.
const CLAUDE_EFFORT_SCALE: EffortScale = {
  values: ['low', 'medium', 'high', 'xhigh', 'max'],
  max: 'max',
};

export class ClaudeCodeAdapter extends BaseCliAdapter {
  readonly providerName = 'claude-code' as const;
  readonly defaultExecutable = 'claude';
  readonly supportsSubagents = true;
  readonly supportsCliAuth = true;
  readonly supportsMcp = true;
  readonly supportsPlugins = true;
  override readonly supportsLsp = true;
  readonly defaultAuthMode = 'subscription' as const;
  readonly apiKeyEnvName = 'ANTHROPIC_API_KEY';
  readonly defaultModel = 'claude-sonnet-4-20250514';
  readonly rulesFile = 'CLAUDE.md';
  readonly rulesFileMode = 'import' as const;
  override readonly effortScale = CLAUDE_EFFORT_SCALE;
  override readonly defaultEgressDomains = ['api.anthropic.com'];
  override readonly supportsSteering = true;
  override readonly supportsDisableTools = true;

  buildCliInvocation(
    provider: CliProviderRecord,
    prompt: string,
    opts: InvokeOpts,
  ): CliCommandSpec {
    const steering = opts.steeringMode === true;
    const invocation = claudeFamilyArgs({
      steering,
      prompt,
      disallowedTools: opts.disallowedTools,
      disableTools: opts.disableTools,
    });
    const spec: CliCommandSpec = {
      command: this.resolveExecutable(provider),
      args: this.mergedArgs(provider, invocation.args),
      env: {
        // Claude Code caps a single response at 32000 output tokens by default and
        // hard-fails when a step exceeds it (skill generation emits many sub-skill
        // bodies in one JSON blob and blows past 32K). This adapter's declared
        // starting ceiling is 128000 — onboarding runs Claude Code on Opus
        // (verified: claude-opus-4-8[1m]), whose 128K output ceiling it matches. It
        // is a ceiling, not a target, so smaller-output steps are unaffected. The
        // value (and the ladder that raises it after an observed overflow) lives in
        // model-capabilities.ts. NOTE: 128K is Opus-only — if Claude Code is
        // switched to a 64K model (Sonnet 4.6 / Haiku 4.5) every request would 400;
        // drop it to 64000 via the provider's envVars then (it wins because
        // mergedEnv spreads last).
        ...CLAUDE_FAMILY_SKILLS_ENV,
        ...claudeFamilyOutputTokenEnv(provider),
        ...this.mergedEnv(provider, opts),
      },
      cwd: opts.cwd,
      outputFormat: 'claude-stream-json',
      // Set only when the prompt was too large for argv; steering never sets it
      // because it delivers the prompt as a stdin user-message instead.
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

  override buildPluginInstallCommands(
    provider: CliProviderRecord,
    opts: PluginInstallOpts,
  ): PluginInstallCommand[] {
    return buildLspMarketplaceCommands({ exec: this.resolveExecutable(provider), opts });
  }
}
