/** Deterministic, LLM-free condensing of a markdown document down to its structure:
 *  every heading survives, each section keeps a bounded lead, the verbose tail is
 *  dropped. The caller pairs the result with a pointer to the full document on disk so
 *  an agent can read back anything omitted.
 *
 *  Document-shaped on purpose (markdown in, `{ text, dropped }` out) rather than
 *  spec-shaped: the same navigation view serves any long structured document. */

/** Body lines kept under each heading before the section tail is dropped. */
export const DEFAULT_HEAD_LINES = 8;

export interface DocumentView {
  /** The condensed text, or the input verbatim when nothing was trimmed. */
  text: string;
  /** True when at least one line was dropped. False means `text === input`, so the
   *  caller can skip writing an artifact and appending a pointer to it. */
  dropped: boolean;
}

export function condenseDocument(text: string, opts: { headLines?: number } = {}): DocumentView {
  const headLines = opts.headLines ?? DEFAULT_HEAD_LINES;
  const out: string[] = [];
  let bodyKept = 0;
  let dropped = false;
  for (const line of text.split('\n')) {
    if (/^#{1,6}\s/.test(line)) {
      out.push(line);
      bodyKept = 0;
    } else if (bodyKept < headLines) {
      out.push(line);
      bodyKept++;
    } else {
      dropped = true;
    }
  }
  if (!dropped) return { text, dropped: false };
  return { text: out.join('\n').trim(), dropped: true };
}
