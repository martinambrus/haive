const FLAG_LINE_PATTERN = /^(--?[A-Za-z][A-Za-z0-9-]*)\s+(.+)$/s;

function stripOuterMatchingQuotes(s: string): string {
  if (s.length < 2) return s;
  const first = s[0];
  const last = s[s.length - 1];
  if ((first === '"' || first === "'") && first === last) {
    return s.slice(1, -1);
  }
  return s;
}

/**
 * Normalize textarea lines into argv tokens.
 *
 * Each non-empty line becomes one or two argv elements:
 *
 * 1. If the line matches `--flag <rest>` or `-f <rest>` (a flag-shaped head
 *    followed by whitespace and a non-empty tail), emit two elements:
 *    the flag and the tail, verbatim. A single pair of outer matching
 *    quotes on the tail is stripped, so `--mcp-config ".claude/mcp.json"`
 *    becomes `['--mcp-config', '.claude/mcp.json']`.
 *
 * 2. Otherwise the whole line is a single argument, verbatim. A single
 *    pair of outer matching quotes is stripped.
 *
 * The tail is never tokenized, so embedded quotes, backslashes, and any
 * other characters survive unchanged. This is appropriate for prose
 * values like `--append-system-prompt 'long text with "quotes"'` where
 * shell escaping rules would be hostile.
 */
export function normalizeCliArgsArray(raw: string[]): string[] {
  const out: string[] = [];
  for (const entry of raw) {
    const trimmed = entry?.trim();
    if (!trimmed) continue;
    const match = FLAG_LINE_PATTERN.exec(trimmed);
    if (match) {
      out.push(match[1]!);
      out.push(stripOuterMatchingQuotes(match[2]!.trim()));
      continue;
    }
    out.push(stripOuterMatchingQuotes(trimmed));
  }
  return out;
}
