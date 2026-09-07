import { and, desc, eq, inArray } from 'drizzle-orm';
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
const LIVE_TASK_STATUSES = [
  'created',
  'queued',
  'running',
  'paused',
  'waiting_user',
  'waiting_pr',
] as const;

/** What the tasks table knows about onboarding for one repository. */
export interface OnboardingTaskFacts {
  /** The newest onboarding task still in flight, or null. */
  liveTaskId: string | null;
  /** An onboarding run has finished successfully at some point. */
  hasCompleted: boolean;
  /** An onboarding run was ever STARTED here, whatever became of it. Distinguishes a repo
   *  that arrived already onboarded (cloned in with `.claude/` and the KB committed) from
   *  one whose only run was cancelled — the markers look identical for both. */
  hasAny: boolean;
}

export const NO_ONBOARDING_TASKS: OnboardingTaskFacts = {
  liveTaskId: null,
  hasCompleted: false,
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
    if (row.status === 'completed') entry.hasCompleted = true;
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
 * Pure, so the table above is unit-testable without a database or a filesystem.
 */
export function resolveOnboardingVerdict(input: {
  /** Markers absent from disk; empty means all four are present. */
  missing: string[];
  onboardedAt: Date | null;
  facts: OnboardingTaskFacts;
}): OnboardingVerdict {
  const { missing, onboardedAt, facts } = input;
  const markersPresent = missing.length === 0;
  const inProgressTaskId = facts.liveTaskId;

  const onboarded =
    markersPresent &&
    inProgressTaskId === null &&
    (onboardedAt !== null || facts.hasCompleted || !facts.hasAny);

  return {
    onboarded,
    inProgressTaskId,
    canMarkOnboarded: markersPresent && !onboarded && inProgressTaskId === null,
  };
}
