/** Bounded accumulator for the transcript persisted to `cli_invocations.stream_log`.
 *
 *  Bounding this changes only the historical replay behind the terminal's Raw tab.
 *  The live WS stream and the output collectors are fed on separate paths — the
 *  spawner's wrapStreamCallback publishes to Redis, and onStdoutChunk hands the same
 *  chunk to the codex/claude collector directly — so what the user watches live, what
 *  the step parsers see, and what provider-fatal classification scans are all
 *  unaffected.
 *
 *  Why a bound is needed: a codex `exec --json` run inlines every MCP tool result into
 *  its event stream, so one `filesystem.read_multiple_files` call echoes whole file
 *  contents back as a single JSON line. Measured on one task: a 25 MB transcript of
 *  which 23.7 MB was that single tool, in 92 JSON lines; worst row on the instance was
 *  90 MB. The replay endpoint ships the column whole to the browser, which then writes
 *  all of it into xterm.
 *
 *  Keeps the head (the command line and early events — how the run started) and the
 *  tail (the result and any error — how it ended), eliding the middle behind an
 *  explicit marker so a truncated transcript can never read as a complete one.
 */
export const STREAM_LOG_HEAD_CHARS = 2 * 1024 * 1024;
export const STREAM_LOG_TAIL_CHARS = 2 * 1024 * 1024;

export interface StreamLogBufferOptions {
  headChars?: number;
  tailChars?: number;
}

export interface StreamLogBuffer {
  push(chunk: string): void;
  /** The transcript to persist: the whole thing verbatim while it stayed within the
   *  bounds, otherwise head + elision marker + tail. */
  toString(): string;
}

export function createStreamLogBuffer(opts: StreamLogBufferOptions = {}): StreamLogBuffer {
  const headLimit = opts.headChars ?? STREAM_LOG_HEAD_CHARS;
  const tailLimit = opts.tailChars ?? STREAM_LOG_TAIL_CHARS;

  const head: string[] = [];
  const tail: string[] = [];
  let headLen = 0;
  let tailLen = 0;
  let elided = 0;

  return {
    push(chunk: string): void {
      if (!chunk) return;
      let rest = chunk;
      if (headLen < headLimit) {
        const room = headLimit - headLen;
        if (rest.length <= room) {
          head.push(rest);
          headLen += rest.length;
          return;
        }
        head.push(rest.slice(0, room));
        headLen = headLimit;
        rest = rest.slice(room);
      }
      tail.push(rest);
      tailLen += rest.length;
      // Drop whole chunks off the front of the tail — that front is the middle of the
      // transcript — until the tail fits again.
      while (tailLen > tailLimit && tail.length > 1) {
        const dropped = tail.shift()!;
        tailLen -= dropped.length;
        elided += dropped.length;
      }
      // One chunk on its own larger than the whole tail budget: keep its end.
      if (tailLen > tailLimit) {
        const only = tail[0]!;
        const kept = only.slice(only.length - tailLimit);
        elided += only.length - kept.length;
        tail[0] = kept;
        tailLen = kept.length;
      }
    },

    toString(): string {
      const headText = head.join('');
      const tailText = tail.join('');
      if (elided === 0) return headText + tailText;
      return (
        `${headText}\n[haive] --- ${elided} characters elided: this CLI transcript exceeded the ` +
        `${headLimit} head / ${tailLimit} tail character cap and only its start and end were ` +
        `persisted ---\n${tailText}`
      );
    },
  };
}
