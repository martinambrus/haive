/** Mermaid renders a literal `;` in message text from this entity code; a raw
 *  `;` is a statement separator that aborts the parse. This is mermaid's own
 *  text-entity form — the HTML `&#59;` form is NOT decoded by mermaid. Volatile:
 *  revisit if mermaid ever changes its `#nnn;` text-entity syntax. */
const SEMICOLON_ENTITY = '#59;';

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
  const firstMeaningful = src
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!firstMeaningful || !/^sequenceDiagram\b/.test(firstMeaningful)) return null;
  // `#\w+;` consumes an existing entity whole so its `;` is not re-escaped; a
  // bare `;` falls through to the second alternative and gets the entity.
  const repaired = src.replace(/#\w+;|;/g, (match) => (match === ';' ? SEMICOLON_ENTITY : match));
  return repaired === src ? null : repaired;
}
