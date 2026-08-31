/**
 * Helpers for Claude-family mid-run steering (claude-code / zai / ollama, all on
 * the `claude` binary). Steering uses stream-json INPUT mode: the prompt and any
 * later steer messages are newline-delimited JSON user-message lines written to
 * the CLI's stdin, which it applies at the next tool-call boundary.
 */

/** One NDJSON user-message line (newline-terminated) for claude stream-json
 *  input. Used for the initial prompt and for each mid-run steer. The text is
 *  JSON.stringify'd so embedded quotes/newlines cannot break the frame or inject
 *  extra events. */
export function steeringUserMessageLine(text: string): string {
  return (
    JSON.stringify({
      type: 'user',
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
