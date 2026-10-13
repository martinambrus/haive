import { siblingOrderAfterDrop } from './sidebar-tree';

export function moveStep(ids: string[], from: number, to: number): string[] {
  if (from === to || from < 0 || from >= ids.length || to < 0 || to >= ids.length) return ids;
  const next = [...ids];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved!);
  return next;
}

export function removeStep(ids: string[], index: number): string[] {
  if (index < 0 || index >= ids.length) return ids;
  return ids.filter((_, i) => i !== index);
}

export function insertStep(ids: string[], index: number, stepId: string): string[] {
  const at = Math.min(Math.max(index, 0), ids.length);
  return [...ids.slice(0, at), stepId, ...ids.slice(at)];
}

/** Rows are addressed by index: a list with a duplicate step must still move the row that was dragged. */
export function dropMove(
  ids: string[],
  from: number,
  ref: number,
  intent: 'before' | 'after',
): string[] {
  if (from === ref || from < 0 || ref < 0 || from >= ids.length || ref >= ids.length) return ids;
  const keys = ids.map((_, i) => String(i));
  const order = siblingOrderAfterDrop(keys, String(from), String(ref), intent).map(
    (k) => ids[Number(k)]!,
  );
  return order.every((id, i) => id === ids[i]) ? ids : order;
}

export function pruneLoopLimits(
  limits: Record<string, number>,
  stepIds: readonly string[],
): Record<string, number> {
  const listed = new Set(stepIds);
  const kept = Object.entries(limits).filter(([id]) => listed.has(id));
  return kept.length === Object.keys(limits).length ? limits : Object.fromEntries(kept);
}
