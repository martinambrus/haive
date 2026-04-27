/**
 * Line-level delta summary for an upgrade plan entry. Backend returns
 * added/removed counts + full old/new content; the web UI renders the actual
 * unified diff with react-diff-view (client-side). Keeping the heavy rendering
 * out of the backend avoids shipping a diff library on the worker image.
 */
export interface LineDelta {
  added: number;
  removed: number;
}

/** Naive line delta suitable for summary badges. Not a merge algorithm —
 *  computes set-symmetric difference on normalized lines, so same line reordered
 *  doesn't count as added/removed, matching how a reader typically perceives
 *  change volume for the upgrade-plan UI. */
export function computeLineDelta(oldText: string, newText: string): LineDelta {
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);
  const oldSet = new Map<string, number>();
  const newSet = new Map<string, number>();
  for (const line of oldLines) oldSet.set(line, (oldSet.get(line) ?? 0) + 1);
  for (const line of newLines) newSet.set(line, (newSet.get(line) ?? 0) + 1);
  let added = 0;
  let removed = 0;
  for (const [line, count] of newSet.entries()) {
    const prior = oldSet.get(line) ?? 0;
    if (count > prior) added += count - prior;
  }
  for (const [line, count] of oldSet.entries()) {
    const next = newSet.get(line) ?? 0;
    if (count > next) removed += count - next;
  }
  return { added, removed };
}

function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  return text.replace(/\r\n/g, '\n').split('\n');
}
