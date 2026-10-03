// Every Unicode control (C0, DEL, C1) and both line separators: `\s` alone misses U+0085, and an
// ASCII-only class misses U+001C-U+001E and U+2028/U+2029.
const LINE_WHITESPACE = /[\s\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g;

/** Collapse a value onto ONE line, losslessly apart from the whitespace itself. For a
 *  field that is a single line by nature and already bounded by its column, where a cap
 *  would be the only lossy part — a task title, `varchar(512)`. */
export const collapseToLine = (s: string | null | undefined): string =>
  (s ?? '').replace(LINE_WHITESPACE, ' ').trim();
