import { diffLines } from 'diff';

/** One half-row of a side-by-side diff: a real line (with its line number) or an
 *  empty padding cell that keeps the two columns aligned across a modification. */
export type DiffCell =
  | { kind: 'equal' | 'remove' | 'add'; num: number; text: string }
  | { kind: 'empty' };

export interface DiffRow {
  left: DiffCell;
  right: DiffCell;
}

function splitLines(value: string): string[] {
  const lines = value.split('\n');
  // jsdiff chunk values keep a trailing newline; drop the empty tail it produces.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Line-level side-by-side diff rows for a before/after pair. Removed lines sit on
 *  the left (red), added on the right (green), unchanged on both; the shorter side
 *  of a modification is padded with empty cells so the columns stay aligned. */
export function buildDiffRows(before: string, after: string): DiffRow[] {
  const parts = diffLines(before, after);
  const rows: DiffRow[] = [];
  let leftNum = 1;
  let rightNum = 1;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (!part) continue;
    if (!part.added && !part.removed) {
      for (const text of splitLines(part.value)) {
        rows.push({
          left: { kind: 'equal', num: leftNum++, text },
          right: { kind: 'equal', num: rightNum++, text },
        });
      }
      continue;
    }
    if (part.removed) {
      const removed = splitLines(part.value);
      // A removed chunk immediately followed by an added chunk is a modification;
      // pair them line-for-line so the change reads across the two columns.
      const next = parts[i + 1];
      const added = next && next.added ? splitLines(next.value) : [];
      if (added.length > 0) i++; // consume the paired added chunk
      const max = Math.max(removed.length, added.length);
      for (let j = 0; j < max; j++) {
        const rl = removed[j];
        const al = added[j];
        rows.push({
          left: rl !== undefined ? { kind: 'remove', num: leftNum++, text: rl } : { kind: 'empty' },
          right: al !== undefined ? { kind: 'add', num: rightNum++, text: al } : { kind: 'empty' },
        });
      }
      continue;
    }
    // Standalone addition (a preceding removal would have consumed it above).
    for (const text of splitLines(part.value)) {
      rows.push({ left: { kind: 'empty' }, right: { kind: 'add', num: rightNum++, text } });
    }
  }
  return rows;
}
