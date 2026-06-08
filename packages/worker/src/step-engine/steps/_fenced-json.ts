/**
 * Robust extraction of JSON emitted by CLI agents inside ```json fenced blocks.
 *
 * Agents wrap their JSON in a ```json fence, but a string field in that JSON can
 * carry free-form markdown or code (a spec body, a KB article, a skill body) which
 * itself contains nested ``` code fences. A non-greedy /```json([\s\S]*?)```/ stops
 * at the FIRST inner fence and truncates the JSON, so JSON.parse throws. These
 * helpers brace-match instead: they anchor on the fence then balance-scan the
 * brackets with string/escape awareness, so nested fences and any trailing prose
 * after the value are ignored. They also recover fence-less raw JSON.
 *
 * The helpers return STRINGS; callers run JSON.parse and their own shape guards.
 */

/**
 * Index of the bracket that closes the `{` or `[` at `openIdx`, or -1 if the value
 * never closes. String- and escape-aware so brackets inside string values are
 * ignored. Tracks only the open char's bracket type; the other bracket type is
 * always balanced within a valid JSON value, so it can be skipped.
 */
export function findBalancedEnd(text: string, openIdx: number): number {
  const open = text[openIdx];
  const close = open === '[' ? ']' : '}';
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = openIdx; i < text.length; i++) {
    const c = text[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (inString) {
      if (c === '\\') escape = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Extract a single top-level JSON value (object OR array) from agent text. Anchors
 * on the first ```json fence (falls back to offset 0 when there is no fence), finds
 * the first `{` or `[`, and balance-matches to its partner. Returns the JSON slice,
 * or null when no balanced value is found. Immune to nested ``` fences inside string
 * values and to trailing prose after the value.
 */
export function extractFencedJson(text: string): string | null {
  const fence = /```json\s*/i.exec(text);
  const start = fence ? fence.index + fence[0].length : 0;
  let open = -1;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (c === '{' || c === '[') {
      open = i;
      break;
    }
  }
  if (open < 0) return null;
  const end = findBalancedEnd(text, open);
  if (end < 0) return null;
  return text.slice(open, end + 1);
}

/**
 * Extract every top-level balanced `{...}` object from agent text. Use for payloads
 * that emit several separate objects (multiple ```json blocks) or a top-level array
 * of objects that should be salvaged element by element. Each candidate starts at a
 * `{` followed by a quoted key. Returns the object slices in order.
 */
export function extractFencedJsonObjects(text: string): string[] {
  const out: string[] = [];
  const candidateRe = /\{\s*"/g;
  let cursor = 0;
  while (cursor < text.length) {
    candidateRe.lastIndex = cursor;
    const m = candidateRe.exec(text);
    if (!m) break;
    const end = findBalancedEnd(text, m.index);
    if (end < 0) break;
    out.push(text.slice(m.index, end + 1));
    cursor = end + 1;
  }
  return out;
}
