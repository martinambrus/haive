import { z } from 'zod';
import { isConflictUnit, isPlanUnit } from './project-state/conflicts.js';
import type { PlanMergeConflict } from './constants/index.js';

export const haiveDataSaveRequestSchema = z.object({
  push: z.boolean().optional().default(false),
  commitMessage: z
    .string()
    .trim()
    .min(1)
    .max(500)
    .refine((value) => !value.includes('\0'))
    .optional(),
});
export type HaiveDataSaveRequest = z.infer<typeof haiveDataSaveRequestSchema>;

export interface HaiveDataSavePayload extends HaiveDataSaveRequest {
  repositoryId: string;
  userId: string;
}

/** Read-only status and the worker's locked check use this same policy. Switches which govern
 * observation or new plan tasks deliberately do not govern an explicit Save. */
export interface HaiveDataFacts {
  readHolds?: readonly HaiveDataReadHold[];
  checkout: 'ready' | 'missing' | 'not_git';
  rootClaimLive: boolean;
  holdingTaskIds: readonly string[];
  writeIntent: boolean;
  gitOperation: boolean;
  planMergeTaskId: string | null;
  pendingUnits: readonly string[];
  /** Dirty projections are flushed by Save; they do not disable the action. */
  stateDirty: boolean;
  mirrorDirty: boolean;
  push: boolean;
  branch: string | null;
  origin: boolean;
}

export type HaiveDataReadHold =
  | { code: 'checkout_unreadable' | 'branch_unreadable' | 'origin_unreadable' }
  | { code: 'git_operation_unreadable'; file?: string };
export type HaiveDataFailure = {
  code:
    | 'save_failed'
    | 'branch_unreadable'
    | 'origin_unreadable'
    | 'integration_failed'
    | 'branch_tip_unreadable'
    | 'push_failed';
};
export type HaiveDataHold =
  | HaiveDataReadHold
  | {
      code: 'checkout_missing' | 'not_git_checkout' | 'root_claim' | 'detached_head' | 'no_origin';
    }
  | { code: 'write_pending' | 'git_operation'; file?: string }
  | { code: 'checkout_held'; taskIds: string[] }
  | { code: 'plan_merge'; taskId: string }
  | { code: 'project_state_questions'; units: string[] };

export type HaiveDataRefusal =
  | HaiveDataHold
  | {
      code:
        | 'invalid_request'
        | 'record_absent'
        | 'record_unreadable'
        | 'record_refused'
        | 'render_context_refused'
        | 'checkout_changed'
        | 'projections_changing'
        | 'plan_mirror_held'
        | 'integration_refused'
        | 'resync_failed';
    }
  | { code: 'integration_held'; count: number }
  | { code: 'unowned_malformed_rtk'; file: string }
  | {
      code: 'projection_not_owned' | 'projection_rewritten';
      file: string;
    };

/** Stable precedence, with details from structural state only, never diagnostic message text. */
export function holdsFor(facts: HaiveDataFacts): HaiveDataHold[] {
  const holds: HaiveDataHold[] = [...(facts.readHolds ?? [])];
  // A checkout that could not be read says nothing about what it is: only the read hold stands.
  const checkoutUnreadable = facts.readHolds?.some((h) => h.code === 'checkout_unreadable');
  if (facts.checkout === 'missing' && !checkoutUnreadable) holds.push({ code: 'checkout_missing' });
  if (facts.checkout === 'not_git' && !checkoutUnreadable) holds.push({ code: 'not_git_checkout' });
  if (facts.rootClaimLive) holds.push({ code: 'root_claim' });
  if (facts.holdingTaskIds.length)
    holds.push({ code: 'checkout_held', taskIds: [...facts.holdingTaskIds].sort() });
  if (facts.writeIntent) holds.push({ code: 'write_pending' });
  if (facts.gitOperation) holds.push({ code: 'git_operation' });
  if (facts.planMergeTaskId) holds.push({ code: 'plan_merge', taskId: facts.planMergeTaskId });
  const units = [
    ...new Set(facts.pendingUnits.filter((unit) => isConflictUnit(unit) && !isPlanUnit(unit))),
  ].sort();
  if (units.length) holds.push({ code: 'project_state_questions', units });
  if (
    facts.checkout === 'ready' &&
    facts.push &&
    !facts.branch &&
    !facts.readHolds?.some(
      (h) => h.code === 'branch_unreadable' || h.code === 'checkout_unreadable',
    )
  )
    holds.push({ code: 'detached_head' });
  if (
    facts.checkout === 'ready' &&
    facts.push &&
    !facts.origin &&
    !facts.readHolds?.some(
      (h) => h.code === 'origin_unreadable' || h.code === 'checkout_unreadable',
    )
  )
    holds.push({ code: 'no_origin' });
  return holds;
}

export interface HaiveDataSaveResult {
  outcome: 'saved' | 'unchanged' | 'refused' | 'conflict' | 'failed';
  committed: boolean;
  commitSha: string | null;
  files: string[];
  skipped: string[];
  pushed: boolean;
  branch: string | null;
  refusal: HaiveDataRefusal | null;
  failure?: HaiveDataFailure;
  indexSynced: boolean;
  conflict?: PlanMergeConflict;
}

export type HaiveDataFileChange = 'unchanged' | 'modified' | 'added' | 'deleted' | 'untracked';

/** One path under `.haive-data/plan.json`, `.haive-data/plan.md` or `.haive-data/state/`, tracked or
 *  not. `change` is how the working copy differs from HEAD; `staged` is whether the index does. */
export interface HaiveDataFile {
  path: string;
  change: HaiveDataFileChange;
  staged: boolean;
}

/** What the Haive data page shows. It queues nothing: `holds.save` and `holds.push` are `holdsFor`
 *  over the facts a Save without and with a push would meet, so the page never disagrees with the
 *  worker's check. `checkout` is `unreadable` when the checkout could not be read, which the holds
 *  then say alone; `files` is null unless the checkout is ready and git listed them. */
export interface HaiveDataStatus {
  checkout: HaiveDataFacts['checkout'] | 'unreadable';
  branch: string | null;
  files: HaiveDataFile[] | null;
  record: {
    dirty: boolean;
    writePending: boolean;
    lastError: string | null;
    syncError: string | null;
    syncedHead: string | null;
  };
  snapshot: { dirty: boolean; lastError: string | null };
  holds: { save: HaiveDataHold[]; push: HaiveDataHold[] };
}
