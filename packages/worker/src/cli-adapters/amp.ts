import { BaseCliAdapter } from './base-adapter.js';
import type { CliCommandSpec, CliProviderRecord, EnvInjection, InvokeOpts } from './types.js';
import { deliverPrompt } from './prompt-delivery.js';
import { steeringUserMessageLine } from './steering.js';

export class AmpAdapter extends BaseCliAdapter {
  readonly providerName = 'amp' as const;
  readonly defaultExecutable = 'amp';
  readonly supportsSubagents = false;
  // amp reads NDJSON user-messages from stdin under `--stream-json-input` and honours a
  // top-level `steer: true` as "apply at the next interruption point while the agent is
  // busy" — the same affordance the claude binary gives at a tool-call boundary. It is the
  // only non-claude-family CLI here with one: codex has it solely in its app-server protocol,
  // grok solely over ACP, gemini not at all, and antigravity's stream-json input is
  // sequential turns (its docs say to wait for `result` before writing again), which is a
  // queued follow-up and not a steer.
  //
  // MEASURED against amp 0.0.1789200043-gdb3b35 in the shipped sandbox image, not taken from
  // the docs. Two things had to hold before this flag could be true:
  //   - its stream emits `{"type":"user", content:[{"type":"tool_result"}]}`, which is what
  //     stream.ts keys onBoundary on. Without that event `steer_consumed` would never
  //     publish, and every amp steer would sit at "queued" until exit relabelled it "the run
  //     ended before this was applied" — telling the user their steer was ignored when it was
  //     not. Observed sequence for a one-tool run: system, user, assistant, user, assistant,
  //     result.
  //   - a `steer: true` line written 6s INTO a run is received and applied: the agent
  //     abandoned its original task and answered the steer verbatim. amp then exited 0 once
  //     stdin closed, which is what makes the forwarder's onResult latch plus its grace the
  //     right shutdown for it.
  // amp also echoes each stdin message back as a text-only `user` event. That is harmless in
  // both directions: onBoundary ignores a user event with no tool_result (pinned by
  // stream-onboundary.test.ts) and onText reads assistant blocks only, so it neither fakes a
  // boundary nor duplicates the turn in the Clean tab.
  override readonly supportsSteering = true;
  readonly supportsCliAuth = true;
  readonly supportsMcp = false;
  readonly supportsPlugins = false;
  readonly defaultAuthMode = 'subscription' as const;
  readonly apiKeyEnvName = null;
  readonly defaultModel = null;
  readonly rulesFile = 'AGENTS.md';
  readonly rulesFileMode = 'native' as const;
  override readonly defaultEgressDomains = ['ampcode.com', '*.ampcode.com'];

  buildCliInvocation(
    provider: CliProviderRecord,
    prompt: string,
    opts: InvokeOpts,
  ): CliCommandSpec {
    if (opts.steeringMode === true) {
      return {
        command: this.resolveExecutable(provider),
        // amp's own --help: `--stream-json-input` "Read JSON Lines user messages from stdin.
        // Requires both --execute and --stream-json." It holds the session open until stdin
        // CLOSES and the assistant is done — which is exactly what the forwarder's onResult
        // latch plus its grace already do.
        //
        // `-x` stays but carries no value: `-x, --execute [message]` takes an OPTIONAL one,
        // and bare `-x` with the message on stdin is not a new shape here — it is what this
        // adapter has shipped all along for a prompt over the argv limit (delivery.argv is
        // empty there, see the one-shot branch below).
        args: this.mergedArgs(provider, [
          '--dangerously-allow-all',
          '--settings-file',
          '/etc/haive-amp-settings.json',
          '-x',
          '--stream-json',
          '--stream-json-input',
        ]),
        env: this.mergedEnv(provider, opts),
        cwd: opts.cwd,
        outputFormat: 'claude-stream-json',
        steerable: true,
        // Unflagged, like the claude family: `steer: true` means "apply at the next
        // interruption point while the agent is busy", and at the initial message there is no
        // turn to interrupt.
        stdinInitial: steeringUserMessageLine(prompt),
        // Every LATER stdin message IS mid-turn, and amp needs the marker to queue it there
        // rather than treat it as the next turn.
        steerFlag: true,
      };
    }
    // amp's own --help: the prompt arrives "as an argument, or via stdin".
    const delivery = deliverPrompt(prompt, { adapter: 'amp', stdin: true });
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
        ...delivery.argv,
        '--stream-json',
      ]),
      env: this.mergedEnv(provider, opts),
      cwd: opts.cwd,
      outputFormat: 'claude-stream-json',
      // Set only when the prompt was too large for argv; `-x` then carries no
      // value and amp reads the message from stdin, which its --help documents.
      ...(delivery.stdinPrompt ? { stdinPrompt: delivery.stdinPrompt } : {}),
    };
  }

  envInjection(_provider: CliProviderRecord): EnvInjection {
    return {
      envVars: {},
      extraArgs: [],
    };
  }
}
