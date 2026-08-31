/**
 * How a prompt reaches a CLI: as an argument, or over stdin.
 *
 * Linux caps a SINGLE argv entry at `MAX_ARG_STRLEN` — 32 pages, 128 KiB on
 * every platform this runs on — and exceeding it fails the spawn outright with
 * `E2BIG` before the process exists. MEASURED: a Codex plan build lost 26 of 47
 * agents that way, 12 of 12 in two consecutive waves, because plan-expansion
 * prompts embed the rendered plan and grow with it.
 *
 * Claude never hit it, but not by design: its steering path emits `-p` with no
 * prompt argument and sends the text through stdin. Its own non-steering branch
 * is exposed exactly like the others — which is the part that makes this worth a
 * shared helper rather than a fix in one adapter.
 */

/** Linux `MAX_ARG_STRLEN`. Not configurable, not per-distro: 32 * 4096. */
export const MAX_ARG_BYTES = 131_072;

/**
 * Where argv stops being safe. Half the kernel limit, because the same argv
 * carries every other flag and the environment block is charged against a
 * related budget — a prompt at 127 KiB would "fit" and still fail once the rest
 * is added.
 */
export const PROMPT_ARGV_LIMIT_BYTES = 65_536;

/** Raised instead of letting the spawn fail with a bare `E2BIG`, which names
 *  neither the adapter, the size, nor the limit. */
export class PromptTooLargeError extends Error {
  constructor(
    readonly adapter: string,
    readonly bytes: number,
  ) {
    super(
      `prompt is ${bytes} bytes, over the ${PROMPT_ARGV_LIMIT_BYTES}-byte limit for passing it as a command-line argument, and the ${adapter} CLI has no documented way to read a prompt from stdin. Shorten the prompt, or teach the adapter that CLI's stdin form.`,
    );
    this.name = 'PromptTooLargeError';
  }
}

export interface PromptDelivery {
  /** Push into `args` where the prompt belongs. Empty when it travels another way. */
  argv: string[];
  /** Set on the spec; the runner writes it and CLOSES stdin. */
  stdinPrompt?: string;
  /** Written into the sandbox for a CLI that reads its prompt from a PATH. */
  promptFile?: { containerPath: string; content: string };
}

/** Where a prompt file is placed inside the sandbox. Under /tmp because it is
 *  scratch for one invocation, and outside the mounted worktree so it can never
 *  be mistaken for part of the repository or picked up by a git status. */
export const PROMPT_FILE_PATH = '/tmp/haive-prompt.txt';

/**
 * Decide how one prompt travels.
 *
 * Threshold rather than "always stdin": this is the smallest change that fixes
 * the crash, and the large branch is not a rare path that can rot — a single
 * build took it 27 times.
 *
 * Sized in BYTES. The kernel counts bytes and a JS string counts UTF-16 units,
 * so `.length` under-reports every em-dash and curly quote in a document — the
 * exact content these prompts carry.
 */
export function deliverPrompt(
  prompt: string,
  opts: {
    adapter: string;
    stdin: boolean;
    /** The flag that takes a PATH to read the prompt from, for a CLI that offers
     *  one — grok's `--prompt-file`. Verified against the real binary: a file
     *  has no size limit at all, so it beats stdin where both exist. */
    fileFlag?: string;
  },
): PromptDelivery {
  if (Buffer.byteLength(prompt, 'utf8') <= PROMPT_ARGV_LIMIT_BYTES) {
    return { argv: [prompt] };
  }
  if (opts.fileFlag) {
    return {
      argv: [opts.fileFlag, PROMPT_FILE_PATH],
      promptFile: { containerPath: PROMPT_FILE_PATH, content: prompt },
    };
  }
  if (!opts.stdin) {
    throw new PromptTooLargeError(opts.adapter, Buffer.byteLength(prompt, 'utf8'));
  }
  return { argv: [], stdinPrompt: prompt };
}
