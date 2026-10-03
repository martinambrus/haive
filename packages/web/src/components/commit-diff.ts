import { diffLines, diffWordsWithSpace, type Change } from 'diff';

export interface DiffSpan {
  text: string;
  changed: boolean;
}

export interface DiffCell {
  no: number;
  text: string;
  spans?: DiffSpan[];
}

export interface InlineRow {
  kind: 'add' | 'remove' | 'context';
  cell: DiffCell;
  oldNo: number | null;
  newNo: number | null;
}

export interface SplitRow {
  left: DiffCell | null;
  right: DiffCell | null;
  changed: boolean;
}

function splitNoTrail(value: string): string[] {
  const lines = value.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

/** Project a word diff back onto each side's original lines, keeping every byte
 * (including whitespace). Comparing the whole replacement run keeps an inserted
 * comment from shifting the text highlights onto the wrong neighbouring line. */
function lineSpans(parts: Change[], side: 'old' | 'new', source: string): DiffSpan[][] {
  const lines: DiffSpan[][] = [[]];
  for (const part of parts) {
    if (side === 'old' ? part.added : part.removed) continue;
    const pieces = part.value.split('\n');
    for (let i = 0; i < pieces.length; i++) {
      if (i > 0) lines.push([]);
      const text = pieces[i]!;
      if (text) lines[lines.length - 1]!.push({ text, changed: !!(part.added || part.removed) });
    }
  }
  if (source.endsWith('\n')) lines.pop();
  return lines;
}

export function buildDiffRows(
  oldContent: string,
  newContent: string,
): {
  inlineRows: InlineRow[];
  splitRows: SplitRow[];
} {
  const parts = diffLines(oldContent, newContent);
  const inlineRows: InlineRow[] = [];
  const splitRows: SplitRow[] = [];
  let oldNo = 1;
  let newNo = 1;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    if (!part.added && !part.removed) {
      for (const text of splitNoTrail(part.value)) {
        const left = { no: oldNo++, text };
        const right = { no: newNo++, text };
        inlineRows.push({ kind: 'context', cell: right, oldNo: left.no, newNo: right.no });
        splitRows.push({ left, right, changed: false });
      }
      continue;
    }

    const next = parts[i + 1];
    const oldText = part.removed ? part.value : '';
    const newText = part.added ? part.value : next?.added ? next.value : '';
    // Text highlights are supplementary. Bound their cost for large replacements;
    // whole-line colours and navigation still work when this comparison gives up.
    const words =
      oldText && newText && oldText.length + newText.length <= 100_000
        ? diffWordsWithSpace(oldText, newText, { maxEditLength: 1_000 })
        : undefined;
    const oldSpans = words ? lineSpans(words, 'old', oldText) : undefined;
    const newSpans = words ? lineSpans(words, 'new', newText) : undefined;
    const removes = splitNoTrail(oldText).map((text, j): DiffCell => ({
      no: oldNo++,
      text,
      spans: oldSpans?.[j],
    }));
    const adds = splitNoTrail(newText).map((text, j): DiffCell => ({
      no: newNo++,
      text,
      spans: newSpans?.[j],
    }));
    for (const cell of removes)
      inlineRows.push({ kind: 'remove', cell, oldNo: cell.no, newNo: null });
    for (const cell of adds) inlineRows.push({ kind: 'add', cell, oldNo: null, newNo: cell.no });
    for (let j = 0; j < Math.max(removes.length, adds.length); j++) {
      splitRows.push({ left: removes[j] ?? null, right: adds[j] ?? null, changed: true });
    }
    if (part.removed && next?.added) i++;
  }
  return { inlineRows, splitRows };
}

export interface ChangeMarker {
  kind: 'add' | 'remove';
  start: number;
  end: number;
  firstLine: number;
  lastLine: number;
}

/** Separate lanes preserve both colours when a split row has an old and new line. */
export function buildChangeMarkers(rows: SplitRow[]): ChangeMarker[] {
  const markers: ChangeMarker[] = [];
  for (const kind of ['remove', 'add'] as const) {
    let run: ChangeMarker | undefined;
    rows.forEach((row, i) => {
      const cell = kind === 'remove' ? row.left : row.right;
      if (!row.changed || !cell) {
        run = undefined;
      } else if (run) {
        run.end = i;
        run.lastLine = cell.no;
      } else {
        run = { kind, start: i, end: i, firstLine: cell.no, lastLine: cell.no };
        markers.push(run);
      }
    });
  }
  return markers;
}

export function inlineMarkerRows(rows: InlineRow[]): SplitRow[] {
  return rows.map((row) => ({
    left: row.kind === 'remove' ? row.cell : null,
    right: row.kind === 'add' ? row.cell : null,
    changed: row.kind !== 'context',
  }));
}
