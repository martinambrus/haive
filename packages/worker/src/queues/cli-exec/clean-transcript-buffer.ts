/** Bounded accumulator for the Clean-tab transcript persisted to
 *  `cli_invocations.clean_transcript`.
 *
 *  Sibling of `stream-log-buffer.ts` and bounded for the same reason: the replay endpoint
 *  ships the whole column to the browser. It bounds a LIST rather than a string, which is the
 *  one substantive difference — whole SEGMENTS are dropped, because half a turn reads as a
 *  complete one and the Clean tab renders each segment as markdown.
 *
 *  Sizing, MEASURED on the dev install before this shipped: across 3,174 rows carrying a
 *  `raw_output` the median is 5,782 characters, the 99th percentile 65,877, and the largest
 *  ever recorded 199,202. The budget below is five times that worst case, so nothing observed
 *  working is trimmed; it exists because "prose is smaller than a raw transcript" is not a
 *  bound and a long agentic run emits a text block per turn.
 *
 *  User turns are already bounded by the api's own `STEER_TEXT_MAX` (8 KiB), so there is no
 *  per-turn clamp here — a steer is never cut. */
import type { CleanTranscript, CleanTranscriptSegment } from '@haive/shared';

export const CLEAN_TRANSCRIPT_MAX_CHARS = 1024 * 1024;

export interface CleanTranscriptBuffer {
  /** One assistant text block. Extends a trailing `model` segment rather than opening a new
   *  one, so a 40-delta turn is one body for the markdown renderer — the same concatenation
   *  the live Clean tab does with `text` frames. */
  pushModel(text: string): void;
  /** One human steer, at the moment it was written to the CLI's stdin. */
  pushUser(text: string, steerId: string): void;
  /** The model drained the steer with this id at a tool-call boundary. Unknown ids are
   *  ignored: the soft-timeout wind-down and a legacy bare-string steer both carry none. */
  markConsumed(steerId: string): void;
  /** The value to persist, or null when there is nothing worth persisting.
   *
   *  Null unless at least one MODEL segment exists. A transcript is the only thing the
   *  viewer renders once it is present, so one holding user turns alone would HIDE the
   *  answer: on the gemini and plain-text paths the prose never travels through
   *  `onProseText` and `raw_output` is its only copy. The steers are not lost in that case —
   *  they are still `steering.nudge` task events, which is what the viewer's legacy restore
   *  reads. */
  toTranscript(): CleanTranscript | null;
}

export function createCleanTranscriptBuffer(
  opts: { maxChars?: number } = {},
): CleanTranscriptBuffer {
  const maxChars = opts.maxChars ?? CLEAN_TRANSCRIPT_MAX_CHARS;

  const segments: CleanTranscriptSegment[] = [];
  let chars = 0;
  let elidedSegments = 0;
  let elidedChars = 0;

  /** Drop whole segments until the budget is met. Keeps the HEAD (how the run started) and
   *  the recent tail (how it ended) and eats the middle, as stream-log-buffer does; within
   *  that, `model` segments go before `user` ones, because a steer is at most 8 KiB and is
   *  the entire reason this column exists. A lone oversized segment is left whole — one turn
   *  is never cut. */
  const enforceBudget = (): void => {
    while (chars > maxChars && segments.length > 1) {
      let victim = segments.findIndex((s, i) => i > 0 && s.kind === 'model');
      if (victim === -1) victim = 1;
      if (victim >= segments.length) break;
      const [dropped] = segments.splice(victim, 1);
      if (!dropped) break;
      chars -= dropped.text.length;
      elidedChars += dropped.text.length;
      elidedSegments += 1;
    }
  };

  return {
    pushModel(text: string): void {
      if (!text) return;
      const last = segments[segments.length - 1];
      if (last?.kind === 'model') {
        // Same separator rule the live Clean tab applies to consecutive `text` frames, so
        // two turns render as two markdown blocks rather than one run-on paragraph.
        const sep = last.text.endsWith('\n\n') ? '' : last.text.endsWith('\n') ? '\n' : '\n\n';
        last.text += sep + text;
        chars += sep.length + text.length;
      } else {
        segments.push({ kind: 'model', text, at: Date.now() });
        chars += text.length;
      }
      enforceBudget();
    },

    pushUser(text: string, steerId: string): void {
      if (!text) return;
      const seg: CleanTranscriptSegment = { kind: 'user', text, at: Date.now() };
      if (steerId) seg.steerId = steerId;
      segments.push(seg);
      chars += text.length;
      enforceBudget();
    },

    markConsumed(steerId: string): void {
      if (!steerId) return;
      for (const seg of segments) {
        if (seg.kind === 'user' && seg.steerId === steerId) seg.consumed = true;
      }
    },

    toTranscript(): CleanTranscript | null {
      if (!segments.some((s) => s.kind === 'model')) return null;
      if (elidedSegments === 0) return { segments };
      return {
        segments,
        elided: { segments: elidedSegments, chars: elidedChars, afterIndex: 0 },
      };
    },
  };
}
