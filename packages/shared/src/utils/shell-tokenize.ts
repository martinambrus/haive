/**
 * Shell-style argument tokenizer. Splits a string into argv-style tokens
 * respecting double-quoted, single-quoted, and bare spans. Strips outer
 * quotes so the result is ready to hand to child_process.spawn.
 *
 * - `--flag "value with spaces"` -> `['--flag', 'value with spaces']`
 * - `'already quoted'` -> `['already quoted']`
 * - `"escaped \\"inner\\""` -> `['escaped "inner"']`
 * - empty / whitespace-only input -> `[]`
 */
export function tokenizeShellArgs(input: string): string[] {
  const trimmed = input?.trim();
  if (!trimmed) return [];

  const tokens: string[] = [];
  let i = 0;
  const len = trimmed.length;

  while (i < len) {
    const ch = trimmed[i];

    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i += 1;
      continue;
    }

    let token = '';
    while (i < len) {
      const c = trimmed[i];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') break;

      if (c === '"' || c === "'") {
        const quote = c;
        i += 1;
        while (i < len) {
          const q = trimmed[i];
          if (q === '\\' && i + 1 < len && quote === '"') {
            token += trimmed[i + 1];
            i += 2;
            continue;
          }
          if (q === quote) {
            i += 1;
            break;
          }
          token += q;
          i += 1;
        }
        continue;
      }

      if (c === '\\' && i + 1 < len) {
        token += trimmed[i + 1];
        i += 2;
        continue;
      }

      token += c;
      i += 1;
    }

    if (token.length > 0) tokens.push(token);
  }

  return tokens;
}

/**
 * Apply tokenizer across every entry of a string[] (the shape the API route
 * receives from the form) and flatten. Idempotent for already-clean arrays.
 */
export function normalizeCliArgsArray(raw: string[]): string[] {
  return raw.flatMap((entry) => tokenizeShellArgs(entry));
}
