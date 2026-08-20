/** Mermaid renders a literal `;` in message text from this entity code; a raw
 *  `;` is a statement separator that aborts the parse. This is mermaid's own
 *  text-entity form — the HTML `&#59;` form is NOT decoded by mermaid. Volatile:
 *  revisit if mermaid ever changes its `#nnn;` text-entity syntax. */
const SEMICOLON_ENTITY = '#59;';

/** Same text-entity form for parentheses. Volatile with SEMICOLON_ENTITY. */
const PAREN_ENTITIES: Record<string, string> = { '(': '#40;', ')': '#41;' };

function firstMeaningfulLine(src: string): string | undefined {
  return src
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0);
}

/** Repairs the one LLM-authored `sequenceDiagram` mistake that reliably aborts
 *  the strict parser: an unescaped `;` in message text, which mermaid reads as a
 *  statement separator (so `A->>B: start; open x` parses `open x` as a broken
 *  statement). Escapes every bare `;` to the mermaid `#59;` entity, leaving any
 *  existing `#…;` entity untouched (so it is idempotent).
 *
 *  Returns null when the source is not a sequence diagram or has no bare `;` to
 *  fix. Called ONLY after the original parse has already failed, so it can never
 *  alter a diagram that currently renders. Gated to `sequenceDiagram` because
 *  `;` IS a valid statement separator in flowchart/graph diagrams. */
export function repairSequenceSemicolons(src: string): string | null {
  const first = firstMeaningfulLine(src);
  if (!first || !/^sequenceDiagram\b/.test(first)) return null;
  // `#\w+;` consumes an existing entity whole so its `;` is not re-escaped; a
  // bare `;` falls through to the second alternative and gets the entity.
  const repaired = src.replace(/#\w+;|;/g, (match) => (match === ';' ? SEMICOLON_ENTITY : match));
  return repaired === src ? null : repaired;
}

function escapeParens(text: string): string {
  return text.replace(/[()]/g, (c) => PAREN_ENTITIES[c]!);
}

/** A label already wrapped in double quotes is valid as authored (mermaid takes
 *  quoted text verbatim), so it is left alone — escaping inside quotes would
 *  render the entity literally. */
function isQuoted(content: string): boolean {
  const trimmed = content.trim();
  return trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"');
}

function repairEdgeLabel(content: string): string {
  return isQuoted(content) ? content : escapeParens(content);
}

function repairNodeLabel(content: string): string {
  if (isQuoted(content)) return content;
  // `[(…)]` is the cylinder shape: those outer parens are syntax, not text.
  if (content.startsWith('(') && content.endsWith(')')) {
    return `(${escapeParens(content.slice(1, -1))})`;
  }
  return escapeParens(content);
}

/** Repairs the flowchart counterpart of the sequence-diagram mistake: a raw `(`
 *  or `)` inside a `[…]` node label or a `|…|` edge label. Mermaid reads `(` as
 *  a shape delimiter there, so `F -->|mail()| MP` and `A[php-fpm (5.6)]` both
 *  abort the parse (verified live against mermaid@11: `got 'PS'`). Escapes them
 *  to the `#40;`/`#41;` entities, which parse and render as the literal chars.
 *
 *  Returns null when the source is not a flowchart or has nothing to fix. Called
 *  ONLY after the original parse has already failed, so it can never alter a
 *  diagram that currently renders. Out of scope by design: parens nested inside
 *  a round `A(…)` or circle `A((…))` node, where the delimiters are the same
 *  character being escaped. */
export function repairFlowchartLabelParens(src: string): string | null {
  const first = firstMeaningfulLine(src);
  if (!first || !/^(graph|flowchart)\b/.test(first)) return null;
  const repaired = src
    .replace(/\|([^|\n]*)\|/g, (_m, body: string) => `|${repairEdgeLabel(body)}|`)
    .replace(/\[([^[\]\n]*)\]/g, (_m, body: string) => `[${repairNodeLabel(body)}]`);
  return repaired === src ? null : repaired;
}
