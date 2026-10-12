/** A cancel can leave a merge open in a directory the task merged in. `merge.left_open` reports it
 *  and `merge.left_open_settled` closes the report. A merge is keyed by its directory and the
 *  commit being merged, so a settled event closes exactly the report it names. */
export const MERGE_LEFT_OPEN_EVENT = 'merge.left_open';
export const MERGE_LEFT_OPEN_SETTLED_EVENT = 'merge.left_open_settled';

export type MergeLeftOpenOutcome = 'aborted' | 'moved' | 'refused' | 'aborted-by-next';

export interface LeftOpenEventRow {
  eventType: string;
  payload: Record<string, unknown> | null;
}

export interface LeftOpenMerge {
  dir: string;
  ref: string;
  head: string;
  mergeHead: string;
  settled: { outcome: MergeLeftOpenOutcome; reason: string } | null;
}

const OUTCOMES: readonly string[] = ['aborted', 'moved', 'refused', 'aborted-by-next'];

function text(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

/** Every reported merge in event order, once per directory and merge head, with its settled outcome
 *  when one was recorded (the first, if a double click settled it twice). Events not shaped as written are skipped. */
export function leftOpenMerges(events: readonly LeftOpenEventRow[]): LeftOpenMerge[] {
  const merges = new Map<string, LeftOpenMerge>();
  const key = (dir: string, mergeHead: string) => JSON.stringify([dir, mergeHead]);
  for (const e of events) {
    if (e.eventType !== MERGE_LEFT_OPEN_EVENT) continue;
    const dir = text(e.payload?.dir);
    const ref = text(e.payload?.ref);
    const head = text(e.payload?.head);
    const mergeHead = text(e.payload?.mergeHead);
    if (dir === null || ref === null || head === null || mergeHead === null) continue;
    const k = key(dir, mergeHead);
    if (!merges.has(k)) merges.set(k, { dir, ref, head, mergeHead, settled: null });
  }
  for (const e of events) {
    if (e.eventType !== MERGE_LEFT_OPEN_SETTLED_EVENT) continue;
    const dir = text(e.payload?.dir);
    const mergeHead = text(e.payload?.mergeHead);
    const outcome = text(e.payload?.outcome);
    if (dir === null || mergeHead === null || outcome === null || !OUTCOMES.includes(outcome)) {
      continue;
    }
    const merge = merges.get(key(dir, mergeHead));
    if (merge && merge.settled === null) {
      merge.settled = {
        outcome: outcome as MergeLeftOpenOutcome,
        reason: text(e.payload?.reason) ?? '',
      };
    }
  }
  return [...merges.values()];
}
