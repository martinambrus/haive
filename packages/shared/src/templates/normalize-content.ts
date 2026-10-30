/** A line without its trailing spaces and tabs, in one pass: `/[ \t]+$/` backtracks quadratically on a
 *  long run of them, and a checkout file the sync reads is up to 1 MiB of one line. */
function trimLineEnd(line: string): string {
  let end = line.length;
  while (end > 0) {
    const c = line.charCodeAt(end - 1);
    if (c !== 0x20 && c !== 0x09) break;
    end--;
  }
  return end === line.length ? line : line.slice(0, end);
}

/** Canonicalize content for hashing/comparison. Normalizes CRLF to LF, strips
 *  trailing whitespace per line, collapses runs of 3+ blank lines to 2, and
 *  ensures exactly one trailing newline. Mirrors the semantics the existing
 *  file writers expect so disk/hash comparisons stay stable across platforms. */
export function normalizeContent(input: string): string {
  const unixified = input.replace(/\r\n/g, '\n');
  const trimmedLines = unixified.split('\n').map(trimLineEnd).join('\n');
  const collapsed = trimmedLines.replace(/\n{3,}/g, '\n\n');
  const trimmed = collapsed.replace(/\n+$/, '');
  return `${trimmed}\n`;
}
