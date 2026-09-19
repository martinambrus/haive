/**
 * Helpers for mid-run steering. The Claude-family adapters (claude-code / zai / ollama /
 * muse / openrouter, all on the `claude` binary) use stream-json INPUT mode: the prompt and
 * any later steer messages are newline-delimited JSON user-message lines written to the
 * CLI's stdin, which it applies at the next tool-call boundary.
 *
 * amp reads the same line shape under `--stream-json-input` and shares the message helper
 * below; only its `steer` marker differs. Its argv is built in its own adapter, since it is
 * not a `claude` binary and shares none of the flags.
 */

/** One NDJSON user-message line (newline-terminated) for stream-json input. Used for the
 *  initial prompt and for each mid-run steer. The text is JSON.stringify'd so embedded
 *  quotes/newlines cannot break the frame or inject extra events.
 *
 *  `steer` is amp's queue marker — "handle this at the next interruption point while the
 *  agent is busy". The claude binary has no such field, so it is opt-in and OMITTED by
 *  default, which keeps the claude-family line byte-identical to what shipped. It is also
 *  never set on an INITIAL message: there is no turn in progress to interrupt. */
export function steeringUserMessageLine(text: string, opts: { steer?: boolean } = {}): string {
  return (
    JSON.stringify({
      type: 'user',
      ...(opts.steer === true ? { steer: true } : {}),
      message: { role: 'user', content: [{ type: 'text', text }] },
    }) + '\n'
  );
}

/** Base argv (before the provider cliArgs merge) for a claude-family invocation.
 *  Steering mode drops the `-p` positional prompt (it goes to stdin as NDJSON)
 *  and adds `--input-format stream-json`; one-shot keeps the positional prompt.
 *  `tail` carries adapter-specific trailing flags (e.g. ollama's `--model`).
 *  `disallowedTools` denies specific tools (e.g. `Agent` for onboarding mining,
 *  to stop a mining agent spawning its own sub-agents); honored even under
 *  `--dangerously-skip-permissions` (deny beats allow). `disableTools` removes
 *  ALL built-in tools (`--tools ""`) so the model answers from the prompt alone —
 *  for enrichment steps (e.g. 01-env-detect) whose full input is already in the
 *  prompt, stopping a high-effort model from burning the timeout crawling the repo.
 *  Shared by every claude-binary adapter (claude-code / zai / ollama) so the
 *  behavior is uniform. */
import { deliverPrompt } from './prompt-delivery.js';

/** The argv for a claude-family run, plus the prompt when it was too large to
 *  travel in argv and must go over stdin instead. */
export interface ClaudeFamilyInvocation {
  args: string[];
  stdinPrompt?: string;
}

export function claudeFamilyArgs(opts: {
  steering: boolean;
  prompt: string;
  tail?: string[];
  disallowedTools?: string[];
  disableTools?: boolean;
}): ClaudeFamilyInvocation {
  const tail = opts.tail ?? [];
  // Placed before `tail`: a trailing flag like ollama's `--model` terminates
  // each variadic tool list so `--disallowedTools Agent --model X` and
  // `--tools '' --model X` both parse correctly.
  const deny =
    opts.disallowedTools && opts.disallowedTools.length > 0
      ? ['--disallowedTools', ...opts.disallowedTools]
      : [];
  // `--tools ''` (empty value) is claude's documented "disable all built-in
  // tools". The empty-string argv element survives the whole pipeline —
  // mergedArgs spreads it verbatim; exec-core/docker-runner never filter it.
  const noTools = opts.disableTools ? ['--tools', ''] : [];
  if (opts.steering) {
    // Steering already sends the prompt over stdin as an NDJSON user message,
    // so it never reaches argv and needs no delivery decision.
    return {
      args: [
        '--dangerously-skip-permissions',
        '-p',
        '--input-format',
        'stream-json',
        '--output-format',
        'stream-json',
        '--verbose',
        ...deny,
        ...noTools,
        ...tail,
      ],
    };
  }
  // The non-steering branch passes the prompt as argv and is exposed to the
  // same 128 KiB kernel limit as every other adapter — steering escapes it only
  // because it sends the text over stdin. `claude -p` with no positional reads
  // stdin, which is exactly what the steering path already relies on, so the
  // large case takes a route this binary is known to serve.
  const delivery = deliverPrompt(opts.prompt, { adapter: 'claude', stdin: true });
  return {
    args: [
      '--dangerously-skip-permissions',
      '-p',
      ...delivery.argv,
      '--output-format',
      'stream-json',
      '--verbose',
      ...deny,
      ...noTools,
      ...tail,
    ],
    stdinPrompt: delivery.stdinPrompt,
  };
}

/** Env every claude-family run carries. Spread BEFORE the provider's own envVars, so a provider
 *  can set `CLAUDE_CODE_DISABLE_BUNDLED_SKILLS=0` to undo it.
 *
 *  The binary lists skills to the model under a character budget of context window x 4 x 1%
 *  (8,000 chars on a 200K model) and charges its OWN bundled skills first: they always keep
 *  their full descriptions, while project skills share what is left and the rest arrive as a
 *  bare name. MEASURED on 2.1.270 with Haive's argv: 1 of 18 repo skills kept its description
 *  (the largest set a real workflow run loaded) and 3 of 9 on another repo; with bundled skills
 *  off, 18 of 18 and 9 of 9. The bundled set (dataviz, loop, update-config, claude-api, …) is
 *  dead weight in a headless sandbox, and the switch leaves `.claude/skills`, `.claude/commands`
 *  and plugins alone. The budget logic is version-bound: re-measure after a CLI bump. */
export const CLAUDE_FAMILY_SKILLS_ENV: Readonly<Record<string, string>> = {
  CLAUDE_CODE_DISABLE_BUNDLED_SKILLS: '1',
};
