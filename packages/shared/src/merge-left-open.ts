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
  settled: { outcome: Exclude<MergeLeftOpenOutcome, 'refused'>; reason: string } | null;
  /** The latest attempt that was refused, and how many were. A refusal leaves the report open. */
  refused: { reason: string; count: number } | null;
}

const OUTCOMES: readonly string[] = ['aborted', 'moved', 'refused', 'aborted-by-next'];

function text(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

/** Every reported merge in event order, once per directory and merge head, with its settled outcome
 *  when one was recorded (the first, if a double click settled it twice). A refused attempt does not
 *  settle it: the person may try again. Events not shaped as written are skipped. */
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
    if (!merges.has(k)) merges.set(k, { dir, ref, head, mergeHead, settled: null, refused: null });
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
    if (!merge || merge.settled !== null) continue;
    const reason = text(e.payload?.reason) ?? '';
    if (outcome === 'refused') {
      merge.refused = { reason, count: (merge.refused?.count ?? 0) + 1 };
    } else {
      merge.settled = { outcome: outcome as Exclude<MergeLeftOpenOutcome, 'refused'>, reason };
    }
  }
  return [...merges.values()];
}

/** Durable step-12 facts live in task events: resetting a step never deletes them. */
export const MERGE_LANDED_EVENT = 'merge.landed';
export const MERGE_LEFT_COMMITTED_EVENT = 'merge.left_committed';
export const MERGE_LEFT_COMMITTED_SETTLED_EVENT = 'merge.left_committed_settled';
export type MergeLeftCommittedOutcome = 'undone' | 'moved' | 'refused';
export interface LandedMerge {
  baseShaBefore: string;
  baseShaAfter: string;
  landedOn: string;
  landedAt: string;
  repoPath: string;
  dir: string;
  /** Immutable feature evidence captured at landing; absent on older report-only events. */
  featureBranch?: string;
  featureSha?: string;
  mergeStage?: 'feature' | 'base-sync';
  squashMergeSha?: string;
  hostCheckout?: boolean;
  pushed?: boolean;
}
export function readLandedMerge(value: unknown): LandedMerge | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (
    ![v.baseShaBefore, v.baseShaAfter].every(
      (s) => typeof s === 'string' && /^[0-9a-f]{40}$/.test(s),
    )
  )
    return null;
  if (
    ![v.landedOn, v.landedAt, v.repoPath, v.dir].every((s) => typeof s === 'string' && s.length > 0)
  )
    return null;
  if (!Number.isFinite(Date.parse(v.landedAt as string))) return null;
  return v as unknown as LandedMerge;
}

export interface LeftCommittedMerge extends LandedMerge {
  settled: { outcome: MergeLeftCommittedOutcome; reason: string; resyncRequired?: boolean } | null;
}

/** Every attempt has one terminal outcome, including a refusal. The directory lock serializes
 * the writer; readers match the exact report, never copy or the latest branch tip. */
export function leftCommittedMerges(events: readonly LeftOpenEventRow[]): LeftCommittedMerge[] {
  const merges = new Map<string, LeftCommittedMerge>();
  const key = (dir: string, sha: string) => JSON.stringify([dir, sha]);
  for (const e of events) {
    if (e.eventType !== MERGE_LEFT_COMMITTED_EVENT) continue;
    const m = readLandedMerge(e.payload);
    if (m && !merges.has(key(m.dir, m.baseShaAfter)))
      merges.set(key(m.dir, m.baseShaAfter), { ...m, settled: null });
  }
  for (const e of events) {
    if (e.eventType !== MERGE_LEFT_COMMITTED_SETTLED_EVENT) continue;
    const dir = text(e.payload?.dir);
    const after = text(e.payload?.baseShaAfter);
    const outcome = text(e.payload?.outcome);
    if (dir === null || after === null || !['undone', 'moved', 'refused'].includes(outcome ?? ''))
      continue;
    const m = merges.get(key(dir, after));
    if (m && !m.settled)
      m.settled = {
        outcome: outcome as MergeLeftCommittedOutcome,
        reason: text(e.payload?.reason) ?? '',
        ...(e.payload?.resyncRequired === true ? { resyncRequired: true } : {}),
      };
  }
  return [...merges.values()];
}
