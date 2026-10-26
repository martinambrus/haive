import { and, desc, eq, gt, inArray, isNull, max, or } from 'drizzle-orm';
import {
  checkRevive,
  LIVE_TASK_STATUSES,
  schema,
  type Database,
  type DbTx,
  type ReviveRefusal,
  type ReviveTask,
} from '@haive/database';
import { CLI_PROVIDER_LIST } from './cli-providers/index.js';
import { lstatNoFollow } from './fs-safe.js';
import { lockPlanMerge } from './plan/merge-lock.js';
import { KB_DIR } from './knowledge-paths.js';
import {
  blocksUpgrade,
  isImportMarker,
  PROJECT_STATE_IMPORT_STEP_ID,
  readRenderContextColumn,
  recordedCliTargets,
  recoverCliMembership,
  completeRecordedCliMembership,
  deriveRenderTargets,
  hasLegacyAgentFallback,
} from './project-state/index.js';

/**
 * The newest date among the LIVE `onboarding_artifacts` rows of each repository that stand for a
 * run of step 12: an onboarding row's `generated_at`, or an import marker's `imported_at`.
 *
 * `12-post-onboarding` inserts the onboarding rows, so this dates the last time a run reached step
 * 12 of 27 — the evidence `mark-onboarded` needs and a completion date cannot give it, since the run
 * that route exists for failed at a LATER step and has no `completed_at` at all. An import marker is
 * another install's step-12 output arriving through the project state, which is the same evidence.
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
 * One query for the whole page.
 */
export async function loadNewestLiveArtifactAt(
  db: Database | DbTx,
  userId: string,
  repositoryIds: string[],
): Promise<Map<string, Date>> {
  return newestLive(db, userId, repositoryIds, false);
}

/** The newest `imported_at` among the LIVE import markers of each repository: the one reading of a
 *  marker that answers a reset without a task. Compare it with `importedSinceReset`. */
export async function loadNewestLiveImportAt(
  db: Database | DbTx,
  userId: string,
  repositoryIds: string[],
): Promise<Map<string, Date>> {
  return newestLive(db, userId, repositoryIds, true);
}

async function newestLive(
  db: Database | DbTx,
  userId: string,
  repositoryIds: string[],
  markersOnly: boolean,
): Promise<Map<string, Date>> {
  const newest = new Map<string, Date>();
  if (repositoryIds.length === 0) return newest;

  const rows = await db
    .select({
      repositoryId: schema.onboardingArtifacts.repositoryId,
      source: schema.onboardingArtifacts.source,
      sourceStepId: schema.onboardingArtifacts.sourceStepId,
      generatedAt: schema.onboardingArtifacts.generatedAt,
      importedAt: schema.onboardingArtifacts.importedAt,
    })
    .from(schema.onboardingArtifacts)
    .where(
      and(
        eq(schema.onboardingArtifacts.userId, userId),
        inArray(schema.onboardingArtifacts.repositoryId, repositoryIds),
        isNull(schema.onboardingArtifacts.supersededAt),
        // ONBOARDING writes and import markers only. `02-upgrade-apply` and the rollback path write
        // through these same rows with `source` 'upgrade'/'rollback', and an upgrade is reachable on
        // a repo that was reset: its gate accepts a COMPLETED onboarding task, and that row outlives
        // the reset. Such a row proves an upgrade ran, never that onboarding reached step 12 —
        // and taking it as proof would restore the stamp with no onboarding run behind it.
        or(
          eq(schema.onboardingArtifacts.source, 'onboarding'),
          and(
            eq(schema.onboardingArtifacts.source, 'backfill'),
            eq(schema.onboardingArtifacts.sourceStepId, PROJECT_STATE_IMPORT_STEP_ID),
          ),
        ),
      ),
    );

  for (const row of rows) {
    const marker = isImportMarker(row);
    if (markersOnly && !marker) continue;
    const at = marker ? row.importedAt : row.generatedAt;
    if (!row.repositoryId || at === null) continue;
    const seen = newest.get(row.repositoryId);
    if (seen === undefined || at > seen) newest.set(row.repositoryId, at);
  }
  return newest;
}

/** Whether a live import marker is dated after the reset epoch: the project state of another
 *  install answered the reset, with no task here. False with no epoch, where nothing was taken back. */
export function importedSinceReset(
  newestImportAt: Date | undefined,
  onboardingResetAt: Date | null,
): boolean {
  return (
    newestImportAt !== undefined && onboardingResetAt !== null && newestImportAt > onboardingResetAt
  );
}

/** Whether any ledger row of the repository, live or superseded, was written by an import after
 *  `since`. An upgrade completed before that import no longer describes the files, so it cannot be
 *  rolled back. */
export async function ledgerImportedSince(
  db: Database | DbTx,
  repositoryId: string,
  since: Date,
): Promise<boolean> {
  const [row] = await db
    .select({ id: schema.onboardingArtifacts.id })
    .from(schema.onboardingArtifacts)
    .where(
      and(
        eq(schema.onboardingArtifacts.repositoryId, repositoryId),
        gt(schema.onboardingArtifacts.importedAt, since),
      ),
    )
    .limit(1);
  return row !== undefined;
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
  /** Successful workflow completion, for a repository created blank. This is separate from
   *  onboarding history: a workflow must never cover for an abandoned onboarding run. */
  newestCompletedWorkflowAt?: Date | null;
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
 * Onboarding history, with optional successful workflow completion evidence for blank repositories.
 *
 * Onboarding rows are folded to pick the newest live id and completion date. Workflow history
 * is aggregated in SQL, returning at most one row per blank repository rather than transferring
 * and sorting every completed task on each poll. Callers pass the blank IDs they already loaded;
 * the SQL also verifies source and reset state. Other callers need only onboarding history.
 */
export async function loadOnboardingTaskFacts(
  db: Database | DbTx,
  userId: string,
  repositoryIds: string[],
  blankRepositoryIds: string[] = [],
): Promise<Map<string, OnboardingTaskFacts>> {
  const byRepo = new Map<string, OnboardingTaskFacts>();
  if (repositoryIds.length === 0) return byRepo;

  const [rows, workflowCompletions] = await Promise.all([
    db
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
      .orderBy(desc(schema.tasks.createdAt)),
    blankRepositoryIds.length === 0
      ? Promise.resolve([])
      : db
          .select({
            repositoryId: schema.tasks.repositoryId,
            completedAt: max(schema.tasks.completedAt),
          })
          .from(schema.tasks)
          .innerJoin(schema.repositories, eq(schema.tasks.repositoryId, schema.repositories.id))
          .where(
            and(
              eq(schema.tasks.userId, userId),
              eq(schema.repositories.userId, userId),
              eq(schema.tasks.type, 'workflow'),
              eq(schema.tasks.status, 'completed'),
              eq(schema.repositories.source, 'blank'),
              isNull(schema.repositories.onboardingResetAt),
              inArray(schema.tasks.repositoryId, blankRepositoryIds),
              inArray(schema.tasks.repositoryId, repositoryIds),
            ),
          )
          .groupBy(schema.tasks.repositoryId),
  ]);

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
  for (const row of workflowCompletions) {
    if (!row.repositoryId || row.completedAt === null) continue;
    const entry = byRepo.get(row.repositoryId) ?? { ...NO_ONBOARDING_TASKS };
    entry.newestCompletedWorkflowAt = row.completedAt;
    byRepo.set(row.repositoryId, entry);
  }
  return byRepo;
}

export const ONBOARDING_MARKERS = [
  KB_DIR,
  '.claude/agents',
  '.claude/skills',
  '.claude/workflow-config.json',
];

/** 07 and 09_5 write agents and skills only into each enabled CLI's own directory, so these two
 *  markers stand for that directory of any CLI in the catalog. */
const MARKER_CANDIDATES: Readonly<Record<string, readonly string[]>> = {
  '.claude/agents': [
    ...new Set(
      CLI_PROVIDER_LIST.flatMap((p) =>
        p.projectAgentsDir !== null && p.agentFileFormat !== null ? [p.projectAgentsDir] : [],
      ),
    ),
  ],
  '.claude/skills': [...new Set(CLI_PROVIDER_LIST.map((p) => p.projectSkillsDir))],
};

/** Physical ONBOARDING_MARKERS present and applicable categories missing. A recorded zero-target
 *  category does not block completion; a retained directory still appears in present. NOT the
 *  onboarded verdict on its own — every
 *  one of them is written by 07-generate-files, the 8th of 27 onboarding steps, so a
 *  cancelled run and a live one leave exactly the same files; `resolveOnboardingVerdict`
 *  combines this with the repo's onboarding task history. Marker checks run in parallel;
 *  results keep marker order so the detail endpoint's present/missing lists stay stable. */
export async function checkOnboardingMarkers(
  root: string,
  recordedContext?: unknown,
): Promise<{ present: string[]; missing: string[] }> {
  const read = readRenderContextColumn(recordedContext);
  const names = read.kind === 'column' ? recordedCliTargets(read.column) : undefined;
  const targets =
    names !== undefined && read.kind === 'column'
      ? deriveRenderTargets(
          names,
          read.column.lspLanguages,
          read.column.agentTargets,
          hasLegacyAgentFallback(read.column),
        )
      : undefined;
  const results = await Promise.all(
    ONBOARDING_MARKERS.map(async (rel) => {
      // Only applicability follows membership. A required category still accepts any catalog
      // directory: adding a CLI deliberately defers generated skill mirrors until a later step.
      const required = !(
        (rel === '.claude/agents' && targets?.agentTargets.length === 0) ||
        (rel === '.claude/skills' && targets?.skillDirs.length === 0)
      );
      // `pathExists` is `stat`-based: it followed a link and read a dangling one as absent, so a
      // linked `.claude/agents` counted as installed while the definitions it named lived outside
      // the tree — and these counts are what the onboarded verdict and `mark-onboarded` rest on.
      const found = await Promise.all(
        (MARKER_CANDIDATES[rel] ?? [rel]).map(async (candidate) => {
          const info = await lstatNoFollow(root, candidate);
          return info !== null && (info.kind === 'file' || info.kind === 'directory');
        }),
      );
      return [rel, found.includes(true), required] as const;
    }),
  );
  return {
    present: results.filter(([, found]) => found).map(([rel]) => rel),
    missing: results.filter(([, found, required]) => !found && required).map(([rel]) => rel),
  };
}

/** Marker facts for a page or one repository. Read strict provenance in at most two batches, only
 * when a missing CLI category could be inapplicable. List callers need no provenance when KB or
 * config already forces their verdict false; detail callers still get accurate missing labels. */
export async function checkRepositoryOnboardingMarkers(
  db: Database | DbTx,
  userId: string,
  repositories: ReadonlyArray<{ id: string; root: string }>,
  options: { verdictOnly?: boolean } = {},
): Promise<Map<string, { present: string[]; missing: string[] }>> {
  const checks = new Map(
    await Promise.all(
      repositories.map(async (repo) => [repo.id, await checkOnboardingMarkers(repo.root)] as const),
    ),
  );
  const candidates = repositories.filter(({ id }) => {
    const missing = checks.get(id)!.missing;
    return (
      missing.some((rel) => rel === '.claude/agents' || rel === '.claude/skills') &&
      (!options.verdictOnly ||
        (!missing.includes(KB_DIR) && !missing.includes('.claude/workflow-config.json')))
    );
  });
  if (candidates.length === 0) return checks;
  const columns = await db
    .select({ id: schema.repositories.id, context: schema.repositories.renderContext })
    .from(schema.repositories)
    .where(
      and(
        eq(schema.repositories.userId, userId),
        inArray(
          schema.repositories.id,
          candidates.map((r) => r.id),
        ),
      ),
    );
  const parsed = new Map(columns.map((row) => [row.id, readRenderContextColumn(row.context)]));
  const needHistory = columns
    .filter((row) => {
      const read = parsed.get(row.id)!;
      return read.kind !== 'column' || read.column.cliTargets === undefined;
    })
    .map((row) => row.id);
  const rows = needHistory.length
    ? await db
        .select({
          id: schema.onboardingArtifacts.id,
          repositoryId: schema.onboardingArtifacts.repositoryId,
          generatedAt: schema.onboardingArtifacts.generatedAt,
          formValuesSnapshot: schema.onboardingArtifacts.formValuesSnapshot,
        })
        .from(schema.onboardingArtifacts)
        .where(
          and(
            eq(schema.onboardingArtifacts.userId, userId),
            inArray(schema.onboardingArtifacts.repositoryId, needHistory),
            isNull(schema.onboardingArtifacts.supersededAt),
          ),
        )
    : [];
  const snapshots = new Map<string, typeof rows>();
  for (const row of rows) {
    const grouped = snapshots.get(row.repositoryId) ?? [];
    grouped.push(row);
    snapshots.set(row.repositoryId, grouped);
  }
  await Promise.all(
    candidates.map(async (repo) => {
      const read = parsed.get(repo.id);
      if (!read) return;
      const recovered = recoverCliMembership(snapshots.get(repo.id) ?? []);
      const context =
        read.kind === 'column'
          ? read.column
          : recovered
            ? { ...recovered.snapshot, rtkChoiceRecorded: false }
            : undefined;
      if (!context) return;
      const completed = completeRecordedCliMembership(context, recovered);
      if (recordedCliTargets(completed) === undefined) return;
      checks.set(repo.id, await checkOnboardingMarkers(repo.root, completed));
    }),
  );
  return checks;
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

export function hasCompletedSinceReset(
  facts: OnboardingTaskFacts,
  onboardingResetAt: Date | null,
): boolean {
  // A run that finished BEFORE the reset says nothing about the tree the reset left behind. A
  // completed run carrying no `completed_at` cannot be placed on either side of the epoch, so it
  // fails closed — the safe direction, and unreachable in practice since `markTaskCompleted`
  // writes that column in the same UPDATE as the status.
  return (
    facts.hasCompleted &&
    (onboardingResetAt === null ||
      (facts.newestCompletedAt !== null && facts.newestCompletedAt > onboardingResetAt))
  );
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
 *               AND (onboarded_at set OR a completed run OR no run was ever started here
 *                    OR an import marker dated after the reset)
 *
 * A repository created blank with no onboarding history or reset can instead use a completed
 * workflow, with no marker requirement. A setup-only task can generate none of
 * those artifacts; its completion still admits the next workflow.
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
  /** Only repositories created blank can complete onboarding through their first workflow. */
  source?: string;
  /** Applicable marker categories absent from disk; empty means the marker gate is satisfied. */
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
  /** A live import marker is dated after the reset epoch (`importedSinceReset`): another install's
   *  finished onboarding arrived through the project state, with no task here to say so. Unlike
   *  `hasArtifactsSinceReset` it makes the repository onboarded, since the work was done elsewhere
   *  and finished; an ordinary row written since the reset only offers the button. */
  importedSinceReset?: boolean;
  facts: OnboardingTaskFacts;
}): OnboardingVerdict {
  const { missing, onboardedAt, facts } = input;
  const onboardingResetAt = input.onboardingResetAt ?? null;
  const hasArtifactsSinceReset = input.hasArtifactsSinceReset ?? false;
  const importedSinceReset = input.importedSinceReset ?? false;
  const markersPresent = missing.length === 0;
  const inProgressTaskId = facts.liveTaskId;

  const completedSinceReset = hasCompletedSinceReset(facts, onboardingResetAt);
  // "No run was ever started here" is evidence only until someone resets: a reset IS a run
  // having been started and then taken back.
  const neverStarted = !facts.hasAny && onboardingResetAt === null;

  // A setup-only workflow (including quick_bugfix) can finish without writing KB, agents or
  // skills. Neither an explicit reset nor an actual onboarding run can be answered by this
  // shortcut. Workflow evidence lives only in task history: onboardedAt remains an onboarding
  // stamp, so it cannot cover for a later onboarding run that failed after writing its markers.
  const greenfieldCompleted =
    input.source === 'blank' && neverStarted && facts.newestCompletedWorkflowAt != null;

  const onboarded =
    inProgressTaskId === null &&
    (greenfieldCompleted ||
      (markersPresent &&
        (onboardedAt !== null || completedSinceReset || neverStarted || importedSinceReset)));

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

export interface RepositoryForUpgrade {
  id: string;
  source?: string;
  renderContext: unknown;
  status: string;
  storagePath: string | null;
  localPath: string | null;
  onboardedAt: Date | null;
  onboardingResetAt: Date | null;
}

/** Whether the render context column vouches for an upgrade no row or onboarding does, as on a
 *  clone: 01 renders from it, and the repos page shows the repository as onboarded. */
export async function renderContextAdmitsUpgrade(
  db: Database | DbTx,
  userId: string,
  repo: RepositoryForUpgrade,
): Promise<boolean> {
  if (readRenderContextColumn(repo.renderContext).kind !== 'column') return false;
  const root = repo.storagePath ?? repo.localPath;
  if (repo.status !== 'ready' || !root) return false;
  const { missing } = (
    await checkRepositoryOnboardingMarkers(db, userId, [{ id: repo.id, root }], {
      verdictOnly: true,
    })
  ).get(repo.id)!;
  const facts =
    (
      await loadOnboardingTaskFacts(db, userId, [repo.id], repo.source === 'blank' ? [repo.id] : [])
    ).get(repo.id) ?? NO_ONBOARDING_TASKS;
  return resolveOnboardingVerdict({
    source: repo.source,
    missing,
    onboardedAt: repo.onboardedAt,
    onboardingResetAt: repo.onboardingResetAt,
    importedSinceReset: importedSinceReset(
      (await loadNewestLiveImportAt(db, userId, [repo.id])).get(repo.id),
      repo.onboardingResetAt,
    ),
    facts,
  }).onboarded;
}

export type UpgradeAdmission =
  | { admitted: true }
  | { admitted: false; reason: 'live-onboarding'; taskId: string }
  | { admitted: false; reason: 'contested'; units: string[] }
  | { admitted: false; reason: 'reset' | 'none' };

/** The units of the repository's project state that a sync found changed on both installs and that
 *  nobody has answered yet, those holding an upgrade or not. */
export async function pendingConflictUnits(
  db: Database | DbTx,
  repositoryId: string,
): Promise<string[]> {
  const rows = await db
    .select({ unit: schema.projectStateConflicts.unit })
    .from(schema.projectStateConflicts)
    .where(
      and(
        eq(schema.projectStateConflicts.repositoryId, repositoryId),
        isNull(schema.projectStateConflicts.resolvedAt),
      ),
    );
  return rows.map((r) => r.unit).sort();
}

/** The rule the banner and POST /tasks share: no live onboarding, no unanswered project state
 *  conflict that holds upgrades (`blocksUpgrade`), and an onboarding finished, or a row it wrote, since the reset epoch, or the render
 *  context column of a clone. */
export async function upgradeAdmission(
  db: Database | DbTx,
  userId: string,
  repo: RepositoryForUpgrade,
): Promise<UpgradeAdmission> {
  const resetAt = repo.onboardingResetAt ?? null;
  const facts =
    (await loadOnboardingTaskFacts(db, userId, [repo.id])).get(repo.id) ?? NO_ONBOARDING_TASKS;
  if (facts.liveTaskId) {
    return { admitted: false, reason: 'live-onboarding', taskId: facts.liveTaskId };
  }
  const units = (await pendingConflictUnits(db, repo.id)).filter(blocksUpgrade);
  if (units.length > 0) return { admitted: false, reason: 'contested', units };
  if (hasCompletedSinceReset(facts, resetAt)) return { admitted: true };
  const newestArtifactAt = (await loadNewestLiveArtifactAt(db, userId, [repo.id])).get(repo.id);
  if (
    hasArtifactsSinceReset(newestArtifactAt, resetAt) ||
    (await renderContextAdmitsUpgrade(db, userId, repo))
  ) {
    return { admitted: true };
  }
  return { admitted: false, reason: resetAt === null ? 'none' : 'reset' };
}

/** What stops a failed task from reviving, null when nothing does: the creation's checks under the
 *  repository lock, then, for an upgrade or rollback, the reset admission on the locked row. Call it
 *  first in the reviving transaction; the api and the worker each word the answer their own way. */
export async function reviveRefusal(
  tx: DbTx,
  taskId: string,
): Promise<
  | { task: ReviveTask; refusal: ReviveRefusal }
  | { task: ReviveTask; admission: Exclude<UpgradeAdmission, { admitted: true }> }
  | null
> {
  // A revived merge conversation takes its scratch worktree back, so it waits for Save, Pull or a discard.
  const [revived] = await tx
    .select({ type: schema.tasks.type, repositoryId: schema.tasks.repositoryId })
    .from(schema.tasks)
    .where(eq(schema.tasks.id, taskId))
    .limit(1);
  if (revived?.type === 'plan_merge' && revived.repositoryId) {
    await lockPlanMerge(tx, revived.repositoryId);
  }
  const check = await checkRevive(tx, taskId);
  if (!check) return null;
  if (check.refusal) return { task: check.task, refusal: check.refusal };
  if (check.task.type !== 'onboarding_upgrade') return null;
  const admission = await upgradeAdmission(tx, check.task.userId, check.repo);
  return admission.admitted ? null : { task: check.task, admission };
}
