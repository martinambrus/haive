/** Keep index descriptions on one line and inside one Markdown table cell. */
export function markdownTableCell(text: string): string {
  // Backslashes escape first: otherwise an input `\|` becomes `\\|`,
  // an escaped backslash followed by a live cell separator.
  return text
    .replace(/[\u0000-\u001F\u007F-\u009F\u2028\u2029]/g, ' ')
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .replace(/\s+/g, ' ')
    .trim();
}
