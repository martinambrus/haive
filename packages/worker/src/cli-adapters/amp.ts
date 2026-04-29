import { BaseCliAdapter } from './base-adapter.js';
import type { CliCommandSpec, CliProviderRecord, EnvInjection, InvokeOpts } from './types.js';

export class AmpAdapter extends BaseCliAdapter {
  readonly providerName = 'amp' as const;
  readonly defaultExecutable = 'amp';
  readonly supportsSubagents = false;
  readonly supportsCliAuth = true;
  readonly supportsMcp = false;
  readonly supportsPlugins = false;
  readonly defaultAuthMode = 'subscription' as const;
  readonly apiKeyEnvName = null;
  readonly defaultModel = null;
  readonly rulesFile = 'AGENTS.md';
  readonly rulesFileMode = 'native' as const;

  buildCliInvocation(
    provider: CliProviderRecord,
    prompt: string,
    opts: InvokeOpts,
  ): CliCommandSpec {
    return {
      command: this.resolveExecutable(provider),
      // amp auto-promotes to execute mode when stdout is redirected, but
      // requires the prompt to arrive via `-x <message>` or stdin — a bare
      // positional is treated as the REPL's initial user message, which
      // doesn't work under non-TTY exec. `--dangerously-allow-all` mirrors
      // claude's `--dangerously-skip-permissions` so tool calls don't block.
      // `--stream-json` emits the Claude Code-compatible NDJSON stream that
      // cli-exec-queue's shared collector parses (tool-use progress + final
      // result event); plain `-x` returned empty stdout for some prompts.
      args: this.mergedArgs(provider, [
        '--dangerously-allow-all',
        // Blanket allow baked into base image so stream-json mode doesn't
        // abort on librarian/tool approval requests.
        '--settings-file',
        '/etc/haive-amp-settings.json',
        '-x',
        prompt,
        '--stream-json',
      ]),
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
