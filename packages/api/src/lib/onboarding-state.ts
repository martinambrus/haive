import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { schema } from '@haive/database';
import type { Database } from '../db.js';

/**
 * Task statuses an onboarding run can hold while it is still going to do more work.
 *
 * The complement of the terminal three (`completed` / `failed` / `cancelled`), written out
 * rather than derived so a new status added to the enum has to be classified here on purpose.
 * `waiting_user` is in the LIVE set deliberately: a run parked on a form is the normal state
 * of onboarding for most of its life, and it is exactly the state the repo was misread in.
 */
export const LIVE_TASK_STATUSES = [
  'created',
  'queued',
  'running',
  'paused',
  'waiting_user',
  'waiting_pr',
] as const;

/**
 * The newest `generated_at` among the LIVE `onboarding_artifacts` rows of each repository.
 *
 * Only `12-post-onboarding` inserts those rows, so this dates the last time a run reached step 12
 * of 27 — the evidence `mark-onboarded` needs and a completion date cannot give it, since the run
 * that route exists for failed at a LATER step and has no `completed_at` at all.
 *
 * A LIVE row is NOT on its own evidence of a run since the reset, which is the trap here: a
 * PARTIAL reset deliberately preserves the rows for paths it could not remove
 * (`resolveKeptArtifactPaths`), so rows predating the epoch legitimately survive un-superseded.
 * Reading their mere existence as "a run reached step 12 since the reset" would let a partial
 * reset — whose markers also survive, by definition — hand back the stamp with no run at all.
 * The caller compares this date against that repository's own epoch; the timestamp is returned
 * rather than a boolean so the comparison happens where the epoch already is, instead of as a
 * per-repository predicate inside one query.
 *
 * One query for the whole page, like `loadOnboardingTaskFacts` beside it.
 */
export async function loadNewestLiveArtifactAt(
  db: Database,
  userId: string,
  repositoryIds: string[],
): Promise<Map<string, Date>> {
  const newest = new Map<string, Date>();
  if (repositoryIds.length === 0) return newest;

  const rows = await db
    .select({
      repositoryId: schema.onboardingArtifacts.repositoryId,
      generatedAt: schema.onboardingArtifacts.generatedAt,
    })
    .from(schema.onboardingArtifacts)
    .where(
      and(
        eq(schema.onboardingArtifacts.userId, userId),
        inArray(schema.onboardingArtifacts.repositoryId, repositoryIds),
        isNull(schema.onboardingArtifacts.supersededAt),
      ),
    );

  for (const row of rows) {
    if (!row.repositoryId || row.generatedAt === null) continue;
    const seen = newest.get(row.repositoryId);
    if (seen === undefined || row.generatedAt > seen) newest.set(row.repositoryId, row.generatedAt);
  }
  return newest;
}

/** Whether a repository holds artifact rows written AFTER its reset epoch — the one reading of
 *  `loadNewestLiveArtifactAt` that is safe, shared so the list route, the status route and
 *  `mark-onboarded` cannot drift apart on it. */
export function hasArtifactsSinceReset(
  newestArtifactAt: Date | undefined,
  onboardingResetAt: Date | null,
): boolean {
  if (newestArtifactAt === undefined) return false;
  // Never reset: there is no epoch to be after, and nothing consults this in that case anyway.
  if (onboardingResetAt === null) return true;
  return newestArtifactAt > onboardingResetAt;
}

/** What the tasks table knows about onboarding for one repository. */
export interface OnboardingTaskFacts {
  /** The newest onboarding task still in flight, or null. */
  liveTaskId: string | null;
  /** An onboarding run has finished successfully at some point. */
  hasCompleted: boolean;
  /** WHEN the newest such run finished, so the verdict can tell a completion that predates a
   *  reset from one that followed it. Null when none completed, and also when the completed
   *  rows carry no `completed_at` — kept separate from `hasCompleted` rather than replacing it,
   *  because a legacy row with a null timestamp must not read as "never completed". */
  newestCompletedAt: Date | null;
  /** An onboarding run was ever STARTED here, whatever became of it. Distinguishes a repo
   *  that arrived already onboarded (cloned in with `.claude/` and the KB committed) from
   *  one whose only run was cancelled — the markers look identical for both. */
  hasAny: boolean;
}

export const NO_ONBOARDING_TASKS: OnboardingTaskFacts = {
  liveTaskId: null,
  hasCompleted: false,
  newestCompletedAt: null,
  hasAny: false,
};

/**
 * Onboarding task facts for a set of repositories, in one query.
 *
 * Rows are selected and folded in JS rather than aggregated in SQL: a repository holds one
 * or two onboarding tasks in practice, and the fold also has to pick the newest LIVE id,
 * which a count aggregate cannot carry. Mirrors the repos list route's existing task-count
 * fold.
 */
export async function loadOnboardingTaskFacts(
  db: Database,
  userId: string,
  repositoryIds: string[],
): Promise<Map<string, OnboardingTaskFacts>> {
  const byRepo = new Map<string, OnboardingTaskFacts>();
  if (repositoryIds.length === 0) return byRepo;

  const rows = await db
    .select({
      id: schema.tasks.id,
      repositoryId: schema.tasks.repositoryId,
      status: schema.tasks.status,
      completedAt: schema.tasks.completedAt,
    })
    .from(schema.tasks)
    .where(
      and(
        eq(schema.tasks.userId, userId),
        eq(schema.tasks.type, 'onboarding'),
        inArray(schema.tasks.repositoryId, repositoryIds),
      ),
    )
    .orderBy(desc(schema.tasks.createdAt));

  for (const row of rows) {
    if (!row.repositoryId) continue;
    const entry = byRepo.get(row.repositoryId) ?? { ...NO_ONBOARDING_TASKS };
    entry.hasAny = true;
    if (row.status === 'completed') {
      entry.hasCompleted = true;
      // Rows arrive newest-first by `created_at`, which is not the same order as `completed_at`,
      // so take the maximum rather than the first one seen.
      if (
        row.completedAt !== null &&
        (entry.newestCompletedAt === null || row.completedAt > entry.newestCompletedAt)
      ) {
        entry.newestCompletedAt = row.completedAt;
      }
    }
    // Rows arrive newest-first, so the first live one seen is the newest.
    if (!entry.liveTaskId && (LIVE_TASK_STATUSES as readonly string[]).includes(row.status)) {
      entry.liveTaskId = row.id;
    }
    byRepo.set(row.repositoryId, entry);
  }
  return byRepo;
}

export interface OnboardingVerdict {
  onboarded: boolean;
  /** Set while an onboarding run is in flight. The repo is NOT onboarded then, and this is
   *  what lets the UI say which of the two reasons applies. */
  inProgressTaskId: string | null;
  /** The markers are all on disk but the run that wrote them never finished here — the one
   *  case POST /repos/:id/mark-onboarded exists for. */
  canMarkOnboarded: boolean;
}

/**
 * Is this repository onboarded?
 *
 * The four on-disk markers say a run reached 07-generate-files (the 8th of 27 steps), not
 * that it finished — a cancelled run and a live one leave the same files. The verdict is the
 * TASK's, with the markers kept as a gate rather than as the evidence:
 *
 *   onboarded = markers present
 *               AND no live onboarding run
 *               AND (onboarded_at set OR a completed run OR no run was ever started here)
 *
 * The last clause is what keeps a repository cloned in already onboarded — and every repo
 * onboarded before this column existed — reading exactly as it did, so nothing needs a
 * backfill and no boot-time migration can re-stamp a repo whose artifacts were just reset.
 *
 * EVERY piece of evidence is read against `onboarding_reset_at`, not just the column. Blocking
 * the `onboarded_at` write alone was cosmetic: the completed onboarding task row lives forever,
 * so `hasCompleted` kept answering yes and the repo went on reading `onboarded` across a reset
 * whatever the stamp did. With no epoch every term below is byte-identical to what it was, which
 * is what makes this deployable with no backfill.
 *
 * Pure, so the table above is unit-testable without a database or a filesystem.
 */
export function resolveOnboardingVerdict(input: {
  /** Markers absent from disk; empty means all four are present. */
  missing: string[];
  onboardedAt: Date | null;
  /** `repositories.onboarding_reset_at`. Null on every repo nobody has reset. */
  onboardingResetAt?: Date | null;
  /** Whether this repository holds artifact rows written AFTER its reset epoch — from
   *  `hasArtifactsSinceReset`, never from the mere existence of a live row, which a PARTIAL reset
   *  preserves for the paths it could not remove. Only `12-post-onboarding` writes them, so one
   *  dated after the epoch is proof a run reached step 12 of 27 since the reset. Omitted defaults
   *  to false, which is exactly the behaviour before this existed. */
  hasArtifactsSinceReset?: boolean;
  facts: OnboardingTaskFacts;
}): OnboardingVerdict {
  const { missing, onboardedAt, facts } = input;
  const onboardingResetAt = input.onboardingResetAt ?? null;
  const hasArtifactsSinceReset = input.hasArtifactsSinceReset ?? false;
  const markersPresent = missing.length === 0;
  const inProgressTaskId = facts.liveTaskId;

  // A run that finished BEFORE the reset says nothing about the tree the reset left behind. A
  // completed run carrying no `completed_at` cannot be placed on either side of the epoch, so it
  // fails closed — the safe direction, and unreachable in practice since `markTaskCompleted`
  // writes that column in the same UPDATE as the status.
  const completedSinceReset =
    facts.hasCompleted &&
    (onboardingResetAt === null ||
      (facts.newestCompletedAt !== null && facts.newestCompletedAt > onboardingResetAt));
  // "No run was ever started here" is evidence only until someone resets: a reset IS a run
  // having been started and then taken back.
  const neverStarted = !facts.hasAny && onboardingResetAt === null;

  const onboarded =
    markersPresent &&
    inProgressTaskId === null &&
    (onboardedAt !== null || completedSinceReset || neverStarted);

  // Marking by hand must not undo a reset — but it must still WORK for the case it exists for.
  //
  // Requiring a post-reset COMPLETION made this route dead on every reset repository, and in
  // exactly its documented case: a run that "did the work and then failed at a late step"
  // (13-onboarding-push against a repo with no remote) never writes `completed_at` at all, while
  // a run that DID complete is already stamped by `stampRepositoryOnboarded` and needs no button.
  // So the condition that was meant to guard the hatch closed it.
  //
  // A live artifact row is the evidence that separates the two. The reset supersedes every row,
  // and only `12-post-onboarding` writes them, so a live one means a run reached step 12 of 27
  // SINCE the reset — which is what "did the work" means here. A repo whose markers are merely
  // leftovers the reset could not remove has no such row and is still refused.
  const resetUnanswered =
    onboardingResetAt !== null && !completedSinceReset && !hasArtifactsSinceReset;

  return {
    onboarded,
    inProgressTaskId,
    canMarkOnboarded: markersPresent && !onboarded && inProgressTaskId === null && !resetUnanswered,
  };
}
