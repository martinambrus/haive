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
 *  `tail` carries adapter-specific trailing flags (e.g. ollama's `--model`). */
export function claudeFamilyArgs(opts: {
  steering: boolean;
  prompt: string;
  tail?: string[];
}): string[] {
  const tail = opts.tail ?? [];
  if (opts.steering) {
    return [
      '--dangerously-skip-permissions',
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      ...tail,
    ];
  }
  return [
    '--dangerously-skip-permissions',
    '-p',
    opts.prompt,
    '--output-format',
    'stream-json',
    '--verbose',
    ...tail,
  ];
}
