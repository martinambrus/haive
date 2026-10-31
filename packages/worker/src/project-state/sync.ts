import { isUtf8 } from 'node:buffer';
import { and, eq, inArray, isNull, ne } from 'drizzle-orm';
import { isRootClaimLive, lockRepositoryTasksKey, schema, type Database } from '@haive/database';
import { CHECKOUT_HOLDING_TASK_STATUSES, logger } from '@haive/shared';
import { convergeRtkQuestion } from '@haive/shared/rtk-enabled';
import { markProjectStateDirty } from '@haive/shared/project-state-outbox';
import { isPathContainmentError, readFileNoFollow, readdirNoFollow } from '@haive/shared/fs-safe';
import {
  PORTABLE_SETTING_NAMES,
  PROJECT_STATE_DIR,
  PROJECT_STATE_LIMITS,
  ProjectStateError,
  claimFileName,
  conflictSide,
  emptyProjectState,
  environmentColumnOf,
  environmentUnitOf,
  intakeSettings,
  isClaimablePath,
  isClaimUnit,
  isEnvironmentUnit,
  isPortableSettingName,
  isRenderUnit,
  isRtkChoiceRecorded,
  isRtkQuestion,
  isSettingUnit,
  mergeProjectState,
  normalizeEnvironment,
  normalizeProjectState,
  normalizeSetting,
  parseProjectState,
  portableSettingsOf,
  settingColumnUpdate,
  settingFileName,
  settingsDifferingFrom,
  toolingUnitFrom,
  toolingUnitOf,
  TOOLING_UNIT_NAME,
  withoutUnchosenRtk,
  portableRender,
  recordedCliTargets,
  recoverCliMembership,
  deriveRenderTargets,
  hasLegacyAgentFallback,
  projectStateHash,
  gitBlobId,
  renderContextColumnSchema,
  renderProjectState,
  sameValue,
  type ProjectEnvironment,
  type ProjectRender,
  type ProjectStateBundle,
  type ProjectStateClaim,
  type ProjectStateConflict,
  type ProjectStateRecord,
} from '@haive/shared/project-state';
import {
  loadLiveArtifacts,
  pickRenderSnapshot,
  resolveRenderContext,
  unionExpandedFor,
} from '../step-engine/_upgrade-render.js';
import { readStateTree } from '../plan/projection-merge.js';
import { gitRun } from '../repo/git-exec.js';
import type { NamedCheckout } from '../repo/checkout-head.js';
import { admitWatchedCheckout } from './watch-admission.js';
import { gitOperationInProgress } from '../repo/git-operation.js';
import { updateApplicableTemplateIds } from '../step-engine/template-manifest.js';
import { claimDiskHash } from './claim-disk.js';
import { insertImportMarker, loadMarkerContext } from './import-marker.js';
import { toolingColumnFromUnit } from './tooling-import.js';
import { raiseRtkQuestionLocked } from './rtk-conflict.js';
import {
  loadPendingRenderConflicts,
  loadRecordClaims,
  lockProjectState,
  overlayRender,
} from './write.js';

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

export type ProjectStateSyncOutcome =
  'absent' | 'refused' | 'deferred' | 'superseded' | 'held' | 'unchanged' | 'applied' | 'conflict';

export interface ProjectStateSyncResult {
  code?: 'write_pending' | 'git_operation';
  outcome: ProjectStateSyncOutcome;
  /** Why the record was refused, or what conflicted, worded as `last_error` holds it. */
  reason?: string;
}

const MIB = 1024 * 1024;
// A first sync can replace a claim per file: the list is cut, settings first; `count` is the total.
const MAX_LOGGED_UNITS = 10;
const {
  maxEntries: MAX_ENTRIES,
  maxFileBytes: MAX_FILE_BYTES,
  maxTotalBytes: MAX_TOTAL_BYTES,
} = PROJECT_STATE_LIMITS;

class Refusal extends Error {}
class CheckoutMoved extends Error {}

const oneLine = (text: string): string =>
  text
    .replace(/[\s\p{Cc}]+/gu, ' ')
    .trim()
    .slice(0, 500);

const listed = (problems: readonly string[]): string =>
  oneLine(
    problems.length > 3
      ? `${problems.slice(0, 3).join('; ')}; and ${problems.length - 3} more`
      : problems.join('; '),
  );

const stateRel = (rel: string): string =>
  rel === '' ? PROJECT_STATE_DIR : `${PROJECT_STATE_DIR}/${rel}`;

const gone = (rel: string): Refusal =>
  new Refusal(`${stateRel(rel)} was removed, or its name is not valid UTF-8`);

/** Every file below the state directory, or null when there is none. The codec reads a record whole,
 *  so the whole tree is read, and the caps stop the walk as it goes: a planted tree is not read on. */
export async function readStateFiles(
  repoPath: string,
  options: { boundedDirectoryReads?: boolean } = {},
): Promise<Map<string, string> | null> {
  const files = new Map<string, string>();
  const pending = [''];
  let entries = 0;
  let bytes = 0;
  for (let dir = pending.pop(); dir !== undefined; dir = pending.pop()) {
    const listing = await readdirNoFollow(repoPath, stateRel(dir), {
      strict: true,
      ...(options.boundedDirectoryReads ? { maxEntries: MAX_ENTRIES - entries } : {}),
    });
    if (listing === null) {
      if (dir === '') return null;
      throw gone(dir);
    }
    entries += listing.length;
    if (entries > MAX_ENTRIES) {
      throw new Refusal(`the state directory holds more than ${MAX_ENTRIES} entries`);
    }
    for (const entry of listing) {
      const rel = dir === '' ? entry.name : `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        pending.push(rel);
        continue;
      }
      if (!entry.isFile()) {
        const what = entry.isSymbolicLink() ? 'a link' : 'not a regular file or directory';
        throw new Refusal(`${stateRel(rel)} is ${what}`);
      }
      const read = await readFileNoFollow(repoPath, stateRel(rel), {
        strict: true,
        maxBytes: MAX_FILE_BYTES,
      });
      if (read === null) throw gone(rel);
      if (read.truncated) {
        throw new Refusal(`${stateRel(rel)} is larger than ${MAX_FILE_BYTES / MIB} MiB`);
      }
      bytes += read.data.length;
      if (bytes > MAX_TOTAL_BYTES) {
        throw new Refusal(`the state directory holds more than ${MAX_TOTAL_BYTES / MIB} MiB`);
      }
      if (!isUtf8(read.data)) throw new Refusal(`${stateRel(rel)} is not valid UTF-8`);
      files.set(rel, read.data.toString('utf8'));
    }
  }
  return files;
}

export type Checkout =
  | { kind: 'absent'; hash: string }
  | { kind: 'refused'; reason: string }
  | {
      kind: 'record';
      hash: string;
      render: ProjectRender;
      cli: string[];
      claims: ProjectStateClaim[];
      gitDataClaims: ProjectStateClaim[];
      bundles: ProjectStateBundle[];
      settings: Record<string, unknown>;
      environment: ProjectEnvironment | null;
    };

const notRead = (detail: string): Checkout => ({
  kind: 'refused',
  reason: `the checkout's record was not read: ${oneLine(detail)}`,
});

export async function readCheckout(repoPath: string): Promise<Checkout> {
  let files: Map<string, string> | null;
  try {
    files = await readStateFiles(repoPath);
  } catch (err) {
    if (err instanceof Refusal || isPathContainmentError(err)) return notRead(err.message);
    throw err;
  }
  return checkoutOf(files);
}

function checkoutOf(files: Map<string, string> | null): Checkout {
  const hash =
    files === null || files.size === 0
      ? 'absent'
      : projectStateHash(new Map([...files].map(([name, text]) => [name, gitBlobId(text)])));
  if (files === null || files.size === 0) return { kind: 'absent', hash };
  const parsed = parseProjectState(files);
  if (!parsed.ok) return notRead(listed(parsed.problems));
  const { render, cli, claims, bundles, settings, environment } = parsed.record;
  return render === null
    ? { kind: 'absent', hash }
    : {
        kind: 'record',
        hash,
        render,
        cli,
        claims,
        gitDataClaims: parsed.gitDataClaims,
        bundles,
        settings,
        environment,
      };
}

const recordOf = (render: ProjectRender | null): ProjectStateRecord => ({
  ...emptyProjectState(),
  render,
});

const renderOf = (snapshot: unknown): ProjectRender | null =>
  (snapshot as { render?: ProjectRender | null }).render ?? null;

async function readSyncRow(db: Database | Tx, repositoryId: string) {
  const [row] = await db
    .select({
      baseSnapshot: schema.projectStateSync.baseSnapshot,
      lastError: schema.projectStateSync.lastError,
      syncedHash: schema.projectStateSync.syncedHash,
      syncedHead: schema.projectStateSync.syncedHead,
    })
    .from(schema.projectStateSync)
    .where(eq(schema.projectStateSync.repositoryId, repositoryId))
    .limit(1);
  return row ?? null;
}

export const CONFLICT_ERROR_PREFIX = "render context conflicts with the checkout's record: ";

/** A conflict's unit is `<file>#<key>`, or the file itself when a side holds no such file. */
export const keyOf = (unit: string): string => unit.slice(unit.indexOf('#') + 1);

/** The record's render unit as the base is to keep it: each key the merge left in conflict stays at
 *  what the base held, so the next sync finds the same conflict again. */
function keptRender(
  incoming: ProjectRender,
  base: ProjectRender | null,
  conflicts: readonly ProjectStateConflict[],
): ProjectRender | null {
  if (conflicts.some(({ unit }) => !unit.includes('#'))) return base;
  const kept: Record<string, unknown> = { ...incoming };
  for (const { unit } of conflicts) {
    const key = keyOf(unit);
    kept[key] = (base as Record<string, unknown> | null)?.[key];
  }
  return kept as ProjectRender;
}

/** Keeps one pending row per conflicted unit, so the writer leaves the other side's value in the file
 *  and an upgrade waits for an answer. A repeat of the same conflict writes nothing. A pending render,
 *  claim, setting or environment row whose unit no longer conflicts converged: a side moved to the
 *  other's value or back to the base, or the claim was settled by the bytes on disk. The RTK question
 *  is no conflict of any merge and stays until it is answered or RTK goes off. Runs after the ledger
 *  took the merge. */
async function recordConflicts(
  tx: Tx,
  repositoryId: string,
  conflicts: readonly ProjectStateConflict[],
): Promise<void> {
  const pending = await tx
    .select()
    .from(schema.projectStateConflicts)
    .where(
      and(
        eq(schema.projectStateConflicts.repositoryId, repositoryId),
        isNull(schema.projectStateConflicts.resolvedAt),
      ),
    );
  const rowOf = new Map(pending.map((row) => [row.unit, row]));
  for (const { unit, base, local, incoming } of conflicts) {
    const sides = {
      base: conflictSide(base),
      local: conflictSide(local),
      incoming: conflictSide(incoming),
    };
    const row = rowOf.get(unit);
    if (!row) {
      await tx.insert(schema.projectStateConflicts).values({ repositoryId, unit, ...sides });
    } else if (
      !sameValue(row.base, sides.base) ||
      !sameValue(row.local, sides.local) ||
      !sameValue(row.incoming, sides.incoming)
    ) {
      await tx
        .update(schema.projectStateConflicts)
        .set(sides)
        .where(eq(schema.projectStateConflicts.id, row.id));
    }
  }
  const open = new Set(conflicts.map(({ unit }) => unit));
  for (const row of pending) {
    const mergeUnit =
      isRenderUnit(row.unit) ||
      isClaimUnit(row.unit) ||
      isSettingUnit(row.unit) ||
      isEnvironmentUnit(row.unit);
    if (!mergeUnit || isRtkQuestion(row) || open.has(row.unit)) continue;
    await tx
      .update(schema.projectStateConflicts)
      .set({ resolution: 'converged', resolvedAt: new Date() })
      .where(eq(schema.projectStateConflicts.id, row.id));
  }
}

/** A failed writer's clear leaves no column: the file with each contested key back at its pending row's
 *  local value stands in, so the conflict stays per key. Null when none is pending or it is no column. */
export async function rebuildLocalRender(
  tx: Tx,
  repositoryId: string,
  onDisk: ProjectRender,
): Promise<ProjectRender | null> {
  const pending = await loadPendingRenderConflicts(tx, repositoryId);
  if (pending.length === 0) return null;
  const rebuilt = overlayRender(onDisk, pending, 'local');
  const valid = renderContextColumnSchema.safeParse({ ...rebuilt, rtkChoiceRecorded: true });
  return rebuilt !== null && valid.success ? rebuilt : null;
}

/** The set 01's apply writes from the column just written, which upgrade-status compares a
 *  repository's claims against. A repository with no claim keeps its set until 01's first plan. */
export async function writeApplicableTemplateIds(
  tx: Tx,
  {
    repositoryId,
    userId,
    requireResolved = true,
  }: { repositoryId: string; userId: string; requireResolved?: boolean },
): Promise<void> {
  const liveRows = await loadLiveArtifacts(tx, repositoryId);
  if (liveRows.length === 0) return;
  const resolved = await resolveRenderContext(tx, { repositoryId, userId, liveRows, logger });
  if (resolved === null) {
    if (!requireResolved) return;
    throw new Error('the render context column just written did not resolve');
  }
  const expanded = await unionExpandedFor(tx, {
    repositoryId,
    userId,
    renderCtx: resolved.renderCtx,
    logger,
  });
  await updateApplicableTemplateIds(tx, repositoryId, expanded);
}

/** A sync from before the set followed the column moved the column alone, and a release adds templates
 *  no stored set holds, so the set is recomputed at boot for every repository with a claim. One with no
 *  column resolves from its snapshots, as 01 does, and keeps its set when none resolves. */
export async function recomputeSyncedApplicableSets(db: Database): Promise<void> {
  const claimed = await db
    .select({ id: schema.onboardingArtifacts.repositoryId })
    .from(schema.onboardingArtifacts)
    .where(isNull(schema.onboardingArtifacts.supersededAt));
  const ids = [...new Set(claimed.map((c) => c.id))].filter((id): id is string => id !== null);
  if (ids.length === 0) return;
  const repos = await db
    .select({
      id: schema.repositories.id,
      userId: schema.repositories.userId,
      renderContext: schema.repositories.renderContext,
    })
    .from(schema.repositories)
    .where(inArray(schema.repositories.id, ids));
  for (const repo of repos) {
    try {
      await db.transaction(async (tx) => {
        await lockProjectState(tx, repo.id);
        await writeApplicableTemplateIds(tx, {
          repositoryId: repo.id,
          userId: repo.userId,
          requireResolved: repo.renderContext !== null,
        });
      });
    } catch (err) {
      logger.warn({ err, repositoryId: repo.id }, 'applicable template ids not recomputed');
    }
  }
}

// A git-data claim the base lists is only there for the writer to remove its file; no merge reads it.
const claimsOf = (snapshot: unknown): ProjectStateClaim[] => {
  const claims = (snapshot as { claims?: unknown } | null)?.claims;
  return Array.isArray(claims)
    ? (claims as ProjectStateClaim[]).filter((claim) => isClaimablePath(claim.path))
    : [];
};

const byPath = (claims: readonly ProjectStateClaim[]) => new Map(claims.map((c) => [c.path, c]));

/** What a path holds on disk, for each claim both installs changed since the base: the only ones the
 *  merge settles by the bytes. */
async function heldBytes(
  repoPath: string,
  { base, local, incoming }: Record<'base' | 'local' | 'incoming', readonly ProjectStateClaim[]>,
): Promise<Map<string, string | null>> {
  const [b, l, i] = [byPath(base), byPath(local), byPath(incoming)];
  const held = new Map<string, string | null>();
  for (const path of new Set([...l.keys(), ...i.keys()])) {
    const [bc, lc, ic] = [b.get(path), l.get(path), i.get(path)];
    if (sameValue(lc, ic) || sameValue(bc, lc) || sameValue(bc, ic)) continue;
    held.set(path, await claimDiskHash(repoPath, (lc ?? ic)!));
  }
  return held;
}

/** Moves the ledger to the merged claims: a path whose claim the merge changed, or this install held
 *  none for, has its live row superseded and an import marker inserted; one the merge dropped is
 *  retired. A path the merge left as local holds stays untouched. True when a row moved. */
async function importClaims(
  tx: Tx,
  {
    repositoryId,
    repoPath,
    repo,
    local,
    merged,
  }: {
    repositoryId: string;
    repoPath: string;
    repo: { userId: string; renderContext: unknown; rtkChoiceMadeAt: Date | null };
    local: readonly ProjectStateClaim[];
    merged: readonly ProjectStateClaim[];
  },
): Promise<boolean> {
  const [l, m] = [byPath(local), byPath(merged)];
  const now = new Date();
  let context: Awaited<ReturnType<typeof loadMarkerContext>> | null = null;
  let moved = false;
  for (const path of [...new Set([...l.keys(), ...m.keys()])].sort()) {
    const claim = m.get(path);
    if (sameValue(l.get(path), claim)) continue;
    // A replaced row can be the only strict membership proof. Capture its provenance before
    // retiring it, while the same transaction still holds the project-state lock.
    if (claim !== undefined) context ??= await loadMarkerContext(tx, repositoryId, repo);
    await tx
      .update(schema.onboardingArtifacts)
      .set({ supersededAt: now, importedAt: now })
      .where(
        and(
          eq(schema.onboardingArtifacts.repositoryId, repositoryId),
          eq(schema.onboardingArtifacts.diskPath, path),
          isNull(schema.onboardingArtifacts.supersededAt),
        ),
      );
    moved = true;
    if (claim === undefined) continue;
    await insertImportMarker(tx, { repositoryId, repoPath, claim, now, context: context! });
  }
  return moved;
}

/** The claims a sync base keeps: the checkout's, each one the merge left in conflict held at what the
 *  base had, so the next sync finds the same conflict again. */
function keptClaims(
  incoming: readonly ProjectStateClaim[],
  base: readonly ProjectStateClaim[],
  conflicts: readonly ProjectStateConflict[],
): ProjectStateClaim[] {
  const open = new Set(conflicts.map(({ unit }) => unit));
  const contested = (claim: ProjectStateClaim) => open.has(claimFileName(claim.path));
  return [...incoming.filter((c) => !contested(c)), ...base.filter(contested)];
}

const portableOf = (settings: unknown): Record<string, unknown> => {
  const out = Object.create(null) as Record<string, unknown>;
  if (settings === null || typeof settings !== 'object' || Array.isArray(settings)) return out;
  for (const [name, value] of Object.entries(settings)) {
    if (isPortableSettingName(name)) out[name] = value;
  }
  return out;
};

/** The value as the column would store it, so a column holding the same value in another order or
 *  with a dropped entry is not moved by a merge that left it be. */
function normalizedOf(name: string, value: unknown): unknown {
  if (value === undefined) return undefined;
  const checked = normalizeSetting(name, value);
  return checked.ok ? checked.value : value;
}

interface PortableMerge {
  conflicts: ProjectStateConflict[];
  /** The repositories columns the merge moves. */
  updates: Record<string, unknown>;
  /** The settings and environment a sync base keeps. */
  baseSettings: Record<string, unknown>;
  baseEnvironment: ProjectEnvironment | null;
  /** The merge left a value the checkout's files do not hold, so the writer has to bring them to it. */
  stale: boolean;
  /** The checkout holds a valid RTK choice that importing records: the column is new, or this install had recorded none. */
  recordsRtkChoice: boolean;
  rejected: string[];
  /** Units the merge, having no base, took from the checkout over a different value held here. */
  overwritten: string[];
}

/** Merges the portable settings and the environment of the checkout into this install's columns. A
 *  base that holds none (no sync row, or one an earlier release wrote) merges as no base at all, so
 *  the checkout's value wins over a column nobody chose, such as RTK's default. */
function mergePortable(
  repo: Parameters<typeof portableSettingsOf>[0] & {
    onboardingEnvironment: unknown;
    renderContext: unknown;
    rtkChoiceMadeAt: Date | null;
  },
  checkout: { settings: Record<string, unknown>; environment: ProjectEnvironment | null },
  row: { baseSnapshot: unknown } | null,
): PortableMerge {
  const previous = (row?.baseSnapshot ?? {}) as Partial<ProjectStateRecord>;
  const rtkRecorded = isRtkChoiceRecorded(
    (repo.renderContext as { rtkChoiceRecorded?: unknown } | null)?.rtkChoiceRecorded === true,
    repo.rtkChoiceMadeAt,
  );
  // An install that recorded no choice leaves RTK out of the merge, so the checkout's valid value is imported, not contested.
  const previousSettings = withoutUnchosenRtk(portableOf(previous.settings), rtkRecorded);
  const previousEnvironment = previous.environment ?? null;
  const heldSettings = portableSettingsOf(repo);
  const localSettings = withoutUnchosenRtk(heldSettings, rtkRecorded);
  const localEnvironment = environmentUnitOf(repo.onboardingEnvironment);
  const importable = repo.onboardingEnvironment == null || localEnvironment !== null;
  const intake = intakeSettings(checkout.settings, localSettings);
  // The base never held the setting, so the checkout's value is no change made since the switch:
  // this install's stands.
  if (
    repo.rtkChoiceMadeAt != null &&
    row !== null &&
    previousSettings['rtk-enabled'] === undefined &&
    localSettings['rtk-enabled'] !== undefined
  ) {
    intake.incoming['rtk-enabled'] = localSettings['rtk-enabled'];
  }
  const recordsRtkChoice =
    intake.accepted['rtk-enabled'] !== undefined && (repo.renderContext == null || !rtkRecorded);
  const checkoutEnvironment = checkout.environment && normalizeEnvironment(checkout.environment);
  const record = (settings: Record<string, unknown>, environment: ProjectEnvironment | null) => ({
    ...emptyProjectState(),
    settings,
    environment: importable ? environment : null,
  });
  const hasBase =
    row !== null && (Object.keys(previousSettings).length > 0 || previousEnvironment !== null);
  const merge = mergeProjectState({
    base: hasBase ? record(previousSettings, previousEnvironment) : null,
    local: record(localSettings, localEnvironment),
    incoming: record(intake.incoming, checkoutEnvironment ?? localEnvironment),
  });

  const contested = new Set(merge.conflicts.map(({ unit }) => unit));
  const environmentContested = merge.conflicts.some(({ unit }) => isEnvironmentUnit(unit));
  const updates: Record<string, unknown> = {};
  const baseSettings = Object.create(null) as Record<string, unknown>;
  for (const name of PORTABLE_SETTING_NAMES) {
    const merged = merge.merged.settings[name];
    if (
      !sameValue(merged, heldSettings[name]) &&
      !sameValue(merged, normalizedOf(name, heldSettings[name]))
    ) {
      Object.assign(updates, settingColumnUpdate(name, merged) ?? {});
    }
    const kept =
      contested.has(settingFileName(name)) || intake.rejected.includes(name)
        ? previousSettings[name]
        : intake.accepted[name];
    if (kept !== undefined) baseSettings[name] = kept;
  }
  const mergedEnvironment = merge.merged.environment;
  if (importable && mergedEnvironment !== null && !sameValue(mergedEnvironment, localEnvironment)) {
    updates.onboardingEnvironment = environmentColumnOf(mergedEnvironment);
  }
  const contestedNames = new Set(
    PORTABLE_SETTING_NAMES.filter((name) => contested.has(settingFileName(name))),
  );
  return {
    conflicts: merge.conflicts,
    updates,
    baseSettings,
    baseEnvironment: environmentContested
      ? previousEnvironment
      : importable
        ? checkoutEnvironment
        : previousEnvironment,
    stale:
      settingsDifferingFrom(merge.merged.settings, checkout.settings, contestedNames).length > 0 ||
      (importable && !environmentContested && !sameValue(mergedEnvironment, checkout.environment)),
    rejected: intake.rejected,
    overwritten: merge.overwritten,
    recordsRtkChoice,
  };
}

/** Merges the checkout's project state record into the repository's render context and artifact
 *  ledger against the base the last sync or writer recorded. Writes the column, the ledger, the sync
 *  row and, for a repository with a claim, the applicable template ids, all in one transaction. */
export async function syncProjectStateFromCheckout(
  db: Database,
  {
    repositoryId,
    repoPath,
    refuseDuringGitOperation,
    expectedCheckout,
  }: {
    repositoryId: string;
    repoPath: string;
    /** An open merge or rebase holds the read. A checkout that changed since its first read always holds it. */
    refuseDuringGitOperation?: boolean;
    expectedCheckout?: NamedCheckout;
  },
): Promise<ProjectStateSyncResult> {
  // An uncommitted writer's partial files are not an incoming checkout. Only its fenced recovery
  // may restore them; clone scans and moved-answer re-syncs wait for the sweep rather than import.
  const [writing] = await db
    .select({ intent: schema.projectStateOutbox.writeIntent })
    .from(schema.projectStateOutbox)
    .where(eq(schema.projectStateOutbox.repositoryId, repositoryId));
  if (writing?.intent)
    return {
      outcome: 'held',
      code: 'write_pending',
      reason: 'an interrupted project state write awaits recovery',
    };
  // The base goes first: a writer that finishes after it left a newer base for the lock to find.
  const seen = await readSyncRow(db, repositoryId);
  const [seenRepo] = await db
    .select({ onboardingResetAt: schema.repositories.onboardingResetAt })
    .from(schema.repositories)
    .where(eq(schema.repositories.id, repositoryId))
    .limit(1);
  const checkout = await readCheckout(repoPath);
  if (checkout.kind === 'absent') return { outcome: 'absent' };

  return db
    .transaction(async (tx) => {
      if (expectedCheckout) await lockRepositoryTasksKey(tx, repositoryId);
      await lockProjectState(tx, repositoryId);
      return syncProjectStateLocked(tx, {
        repositoryId,
        repoPath,
        refuseDuringGitOperation,
        expectedCheckout,
        checkout,
        seen,
        seenRepo,
      });
    })
    .catch((err: unknown) => {
      if (err instanceof CheckoutMoved) return { outcome: 'superseded' as const };
      throw err;
    });
}

/** Import under the project-state lock already held by the writer; no nested pool transaction. */
export async function syncProjectStateLocked(
  tx: Tx,
  {
    repositoryId,
    repoPath,
    refuseDuringGitOperation,
    expectedCheckout,
    holdingTaskId,
    checkout,
    seen,
    seenRepo,
  }: {
    repositoryId: string;
    repoPath: string;
    refuseDuringGitOperation?: boolean;
    expectedCheckout?: NamedCheckout;
    holdingTaskId?: string;
    checkout: Checkout;
    seen: Awaited<ReturnType<typeof readSyncRow>>;
    seenRepo: { onboardingResetAt: Date | null } | undefined;
  },
): Promise<ProjectStateSyncResult> {
  const [writing] = await tx
    .select({ intent: schema.projectStateOutbox.writeIntent })
    .from(schema.projectStateOutbox)
    .where(eq(schema.projectStateOutbox.repositoryId, repositoryId));
  if (writing?.intent)
    return {
      outcome: 'held',
      code: 'write_pending',
      reason: 'an interrupted project state write awaits recovery',
    };
  if (
    expectedCheckout &&
    !(await admitWatchedCheckout(tx, repositoryId, repoPath, expectedCheckout))
  )
    return { outcome: 'superseded' };
  if (refuseDuringGitOperation) {
    if (await gitOperationInProgress(repoPath)) return { outcome: 'held', code: 'git_operation' };
  }
  // Every producer must reject an intermediate checkout, including clone scans and moved answers
  // that do not request the git-operation guard. The database base alone cannot see a file move.
  if (checkout.kind === 'record' && !sameValue(checkout, await readCheckout(repoPath))) {
    return { outcome: 'superseded' };
  }
  // The row lock first: an upgrade's insert holds it, so the live-task read below sees that task.
  const [repo] = await tx
    .select({
      renderContext: schema.repositories.renderContext,
      userId: schema.repositories.userId,
      onboardingResetAt: schema.repositories.onboardingResetAt,
      rootClaimedAt: schema.repositories.rootClaimedAt,
      rootClaimKind: schema.repositories.rootClaimKind,
      scopeExcludeGlobs: schema.repositories.scopeExcludeGlobs,
      rtkEnabled: schema.repositories.rtkEnabled,
      rtkVersion: schema.repositories.rtkVersion,
      lspServers: schema.repositories.lspServers,
      lspServerVersions: schema.repositories.lspServerVersions,
      chromeDevtoolsMcpVersion: schema.repositories.chromeDevtoolsMcpVersion,
      reviewDimensions: schema.repositories.reviewDimensions,
      agentRulesOverride: schema.repositories.agentRulesOverride,
      onboardingEnvironment: schema.repositories.onboardingEnvironment,
      onboardingTooling: schema.repositories.onboardingTooling,
      rtkChoiceMadeAt: schema.repositories.rtkChoiceMadeAt,
    })
    .from(schema.repositories)
    .where(eq(schema.repositories.id, repositoryId))
    .for('update');
  // Deleted since the files were read: its sync row went with it, and nothing is left to write to.
  if (!repo) return { outcome: 'superseded' };
  const live = await tx
    .select({ id: schema.tasks.id })
    .from(schema.tasks)
    .where(
      and(
        eq(schema.tasks.repositoryId, repositoryId),
        inArray(schema.tasks.type, ['onboarding', 'onboarding_upgrade']),
        inArray(schema.tasks.status, [...CHECKOUT_HOLDING_TASK_STATUSES]),
        isNull(schema.tasks.deadAt),
        ...(holdingTaskId ? [ne(schema.tasks.id, holdingTaskId)] : []),
      ),
    )
    .limit(1);
  // Only a reset: a clone or refresh holds its own claim while it calls the sync.
  const resetting = isRootClaimLive(repo.rootClaimedAt) && repo.rootClaimKind === 'reset';
  if (live.length > 0 || resetting) return { outcome: 'deferred' };
  // A reset since the files were read took back the column, the ledger and the sync row.
  if (
    (repo.onboardingResetAt?.getTime() ?? null) !== (seenRepo?.onboardingResetAt?.getTime() ?? null)
  ) {
    return { outcome: 'superseded' };
  }

  const row = await readSyncRow(tx, repositoryId);
  if (!sameValue(row?.baseSnapshot ?? null, seen?.baseSnapshot ?? null)) {
    return { outcome: 'superseded' };
  }

  const refuse = async (reason: string): Promise<ProjectStateSyncResult> => {
    if (row !== null && row.lastError !== reason) {
      await tx
        .update(schema.projectStateSync)
        .set({ lastError: reason, updatedAt: new Date() })
        .where(eq(schema.projectStateSync.repositoryId, repositoryId));
    }
    return { outcome: 'refused', reason };
  };
  if (checkout.kind === 'refused') return refuse(checkout.reason);
  if (checkout.kind === 'absent') return { outcome: 'absent' };

  const column = (repo.renderContext ?? null) as Record<string, unknown> | null;

  const rebuilt =
    column === null ? await rebuildLocalRender(tx, repositoryId, checkout.render) : null;
  const local = recordOf(
    column === null ? rebuilt : portableRender(column as Parameters<typeof portableRender>[0]),
  );
  try {
    renderProjectState(local);
  } catch (err) {
    if (!(err instanceof ProjectStateError)) throw err;
    return refuse(`the render context cannot be written as a record: ${listed(err.problems)}`);
  }

  const baseRender = row === null ? null : renderOf(row.baseSnapshot);
  const baseCli =
    row === null ? [] : ((row.baseSnapshot as Partial<ProjectStateRecord>)?.cli ?? []);
  const columnCli =
    column === null
      ? undefined
      : recordedCliTargets(column as Parameters<typeof recordedCliTargets>[0]);
  const rowsForMembership =
    column?.cliTargets === undefined ? await loadLiveArtifacts(tx, repositoryId) : [];
  const historical = column === null ? pickRenderSnapshot(rowsForMembership) : null;
  const recovered = recoverCliMembership(rowsForMembership);
  const recoveredCli = recovered?.cliTargets;
  const storedCli = column?.cliTargets !== undefined ? columnCli : (recoveredCli ?? columnCli);
  const localCli = storedCli ?? [];
  // No member files in a pre-CLI record are absence, not a request to remove the repository set.
  // Once the base held members, their deletion is an explicit per-member repository change.
  const incomingCli = checkout.cli.length === 0 && baseCli.length === 0 ? localCli : checkout.cli;
  const hasCli =
    columnCli !== undefined ||
    historical?.cliTargets !== undefined ||
    recoveredCli !== undefined ||
    checkout.cli.length > 0 ||
    baseCli.length > 0 ||
    (column === null && historical === null);
  const baseClaims = row === null ? [] : claimsOf(row.baseSnapshot);
  const localClaims = await loadRecordClaims(tx, repositoryId);
  // A checkout with no claim file is one written before the record carried claims: it retires none.
  const incomingClaims =
    checkout.claims.length === 0 && baseClaims.length > 0 ? baseClaims : checkout.claims;
  const held =
    row === null
      ? new Map<string, string | null>()
      : await heldBytes(repoPath, {
          base: baseClaims,
          local: localClaims,
          incoming: incomingClaims,
        });
  const merge = mergeProjectState({
    base: row === null ? null : { ...recordOf(baseRender), cli: baseCli, claims: baseClaims },
    local: { ...local, cli: localCli, claims: localClaims },
    incoming: { ...recordOf(checkout.render), cli: incomingCli, claims: incomingClaims },
    diskHash: (path) => held.get(path) ?? null,
  });
  const claimConflicts = merge.conflicts.filter(({ unit }) => isClaimUnit(unit));
  const renderConflicts = merge.conflicts.filter(({ unit }) => !isClaimUnit(unit));
  const portable = mergePortable(repo, checkout, row);
  const merged = merge.merged.render;
  let wrote = false;
  let columnAfter: unknown = column;
  const flagFlips =
    column !== null && portable.recordsRtkChoice && column.rtkChoiceRecorded !== true;
  const renderMoved =
    merged !== null &&
    (rebuilt !== null || !sameValue(merged, normalizeProjectState(local).render));
  const cliMoved = merged !== null && hasCli && !sameValue(column?.cliTargets, merge.merged.cli);
  if (renderMoved || flagFlips || cliMoved) {
    const candidate: Record<string, unknown> = {
      ...(column ?? (historical?.agentTargets ? { agentTargets: historical.agentTargets } : {})),
      ...(renderMoved ? merged : {}),
      ...(hasCli ? { cliTargets: merge.merged.cli } : {}),
      rtkChoiceRecorded:
        column === null ? portable.recordsRtkChoice : flagFlips || column.rtkChoiceRecorded,
    };
    const context = column ?? historical ?? {};
    const basis = context.agentTargets !== undefined ? context : (recovered?.snapshot ?? context);
    const explicitClearsFallback =
      recovered?.snapshot.cliTargets !== undefined &&
      recovered.snapshot.legacyAgentFallback !== true;
    if (
      hasCli &&
      !explicitClearsFallback &&
      sameValue([...new Set(localCli)].sort(), [...new Set(merge.merged.cli)].sort()) &&
      hasLegacyAgentFallback(basis as Parameters<typeof hasLegacyAgentFallback>[0])
    ) {
      Object.assign(candidate, { legacyAgentFallback: true });
      if (candidate.agentTargets === undefined)
        candidate.agentTargets = deriveRenderTargets(
          [],
          [],
          basis.agentTargets as Parameters<typeof deriveRenderTargets>[2],
          true,
        ).agentTargets;
    } else if (hasCli) delete candidate.legacyAgentFallback;
    const next = renderContextColumnSchema.safeParse(candidate);
    if (!next.success) {
      const issues = next.error.issues.map(
        (i) => `${i.path.join('.') || 'the column'} ${i.message}`,
      );
      return refuse(`the render context would not be valid once written: ${listed(issues)}`);
    }
    await tx
      .update(schema.repositories)
      .set({ renderContext: next.data })
      .where(eq(schema.repositories.id, repositoryId));
    wrote = true;
    columnAfter = next.data;
  }

  const imported = await importClaims(tx, {
    repositoryId,
    repoPath,
    repo: {
      userId: repo.userId,
      renderContext: columnAfter,
      rtkChoiceMadeAt: repo.rtkChoiceMadeAt,
    },
    local: localClaims,
    merged: merge.merged.claims,
  });
  // Never merged: a column that holds tooling stands, and only an empty one takes the checkout's.
  const toolingUnit = toolingUnitFrom(checkout.settings[TOOLING_UNIT_NAME]);
  const toolingImport =
    repo.onboardingTooling == null && toolingUnit !== null
      ? toolingColumnFromUnit(toolingUnit)
      : null;
  const toolingStale = !sameValue(
    toolingUnitOf(toolingImport?.column ?? repo.onboardingTooling),
    toolingUnit,
  );
  const updates = {
    ...portable.updates,
    ...(toolingImport
      ? { onboardingTooling: toolingImport.column as unknown as Record<string, unknown> }
      : {}),
  };
  const settingsMoved = Object.keys(updates).length > 0;
  if (settingsMoved) {
    await tx
      .update(schema.repositories)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(schema.repositories.id, repositoryId));
    if (portable.updates.rtkEnabled === false) await convergeRtkQuestion(tx, repositoryId, null);
  }
  if (wrote || imported) {
    await writeApplicableTemplateIds(tx, {
      repositoryId,
      userId: repo.userId,
      requireResolved: wrote,
    });
  }
  if (toolingImport?.heldServers) {
    logger.warn(
      { repositoryId, servers: toolingImport.heldServers },
      'imported MCP servers held until accepted on this install',
    );
  }
  if (hasCli && !sameValue(merge.merged.cli, checkout.cli)) {
    const [outbox] = await tx
      .select({
        revision: schema.projectStateOutbox.revision,
        writtenRevision: schema.projectStateOutbox.writtenRevision,
      })
      .from(schema.projectStateOutbox)
      .where(eq(schema.projectStateOutbox.repositoryId, repositoryId));
    if (!outbox || outbox.writtenRevision >= outbox.revision)
      await markProjectStateDirty(tx, repositoryId);
  }
  if (portable.stale || toolingStale || checkout.gitDataClaims.length > 0) {
    await markProjectStateDirty(tx, repositoryId);
  }
  if (portable.rejected.length > 0) {
    logger.warn(
      { repositoryId, settings: portable.rejected },
      "project state settings the checkout holds are not valid here; this install's value stands",
    );
  }

  await recordConflicts(tx, repositoryId, [...merge.conflicts, ...portable.conflicts]);
  // The imported tooling and choice are now visible in this transaction. Keep the question's
  // lifecycle identical to clone scans and boot, without nesting another lock/transaction.
  await raiseRtkQuestionLocked(tx, repositoryId);

  const lastError =
    renderConflicts.length === 0
      ? null
      : `${CONFLICT_ERROR_PREFIX}${renderConflicts.map(({ unit }) => keyOf(unit)).join(', ')}`;
  const baseSnapshot = normalizeProjectState({
    ...recordOf(keptRender(checkout.render, baseRender, renderConflicts)),
    cli: checkout.cli,
    claims: [...keptClaims(incomingClaims, baseClaims, claimConflicts), ...checkout.gitDataClaims],
    // Never merged: a conflict row on a descriptor could not be answered, and would block upgrades.
    bundles: checkout.bundles,
    settings: {
      ...portable.baseSettings,
      ...(toolingUnit ? { [TOOLING_UNIT_NAME]: toolingUnit } : {}),
    },
    environment: portable.baseEnvironment,
  });
  // Import work can await many reads. Never acknowledge bytes that moved during it: throw so
  // its column/ledger/conflict mutations roll back as well as its watermark.
  if (
    !sameValue(checkout, await readCheckout(repoPath)) ||
    (refuseDuringGitOperation && (await gitOperationInProgress(repoPath))) ||
    (expectedCheckout &&
      !(await admitWatchedCheckout(tx, repositoryId, repoPath, expectedCheckout)))
  )
    throw new CheckoutMoved();
  if (
    row === null ||
    row.syncedHash !== checkout.hash ||
    row.syncedHead !== (expectedCheckout?.sha ?? null) ||
    row.lastError !== lastError ||
    !sameValue(row.baseSnapshot, baseSnapshot)
  ) {
    const synced = {
      baseSnapshot,
      syncedHash: checkout.hash,
      syncedHead: expectedCheckout?.sha ?? null,
      lastError,
      updatedAt: new Date(),
    };
    await tx
      .insert(schema.projectStateSync)
      .values({ repositoryId, ...synced })
      .onConflictDoUpdate({ target: schema.projectStateSync.repositoryId, set: synced });
  }

  const replaced = [...portable.overwritten, ...merge.overwritten];
  if (replaced.length > 0) {
    logger.warn(
      { repositoryId, count: replaced.length, units: replaced.slice(0, MAX_LOGGED_UNITS) },
      "project state had no base: the checkout's value replaced the one held here for these units",
    );
  }

  if (lastError !== null) return { outcome: 'conflict', reason: lastError };
  if (portable.conflicts.length > 0) {
    const names = portable.conflicts.map(({ unit }) => unit).join(', ');
    return {
      outcome: 'conflict',
      reason: `settings conflict with the checkout's record: ${names}`,
    };
  }
  return { outcome: wrote || imported || settingsMoved ? 'applied' : 'unchanged' };
}

/** Points the sync base at the record the checkout holds now, so a sync after the checkout moves merges
 *  this install's pending changes against the record they were made on. A checkout holding no record
 *  gets an empty base, so what an incoming commit adds is merged in rather than imported over the
 *  pending state; one whose record cannot be read keeps its base and answers in `last_error`. */
export async function rebaseProjectStateOnCheckout(
  db: Database,
  args: { repositoryId: string; repoPath: string },
): Promise<void> {
  const checkout = await readCheckout(args.repoPath);
  await db.transaction((tx) => rebaseLocked(tx, args.repositoryId, checkout));
}

/** HEAD's commit and the record it holds, read outside any transaction: a commit is immutable, so
 *  only applying the result needs the project-state lock. A sha of null (no HEAD) is never reused. */
export interface HeadRecord {
  sha: string | null;
  checkout: Checkout;
}

async function headSha(repoPath: string): Promise<string | null> {
  const head = await gitRun(repoPath, ['rev-parse', '--verify', '-q', 'HEAD']);
  const sha = head.stdout.trim();
  return head.code === 0 && sha !== '' ? sha : null;
}

async function readRecordAt(repoPath: string, rev: string): Promise<Checkout> {
  try {
    const files = await readStateTree(repoPath, rev);
    return checkoutOf(files.size === 0 ? null : files);
  } catch (err) {
    return notRead((err as Error).message);
  }
}

export async function readHeadRecord(repoPath: string): Promise<HeadRecord> {
  const sha = await headSha(repoPath);
  return { sha, checkout: await readRecordAt(repoPath, sha ?? 'HEAD') };
}

/** The rebase onto the record HEAD commits, written in the transaction the caller holds the
 *  project-state lock in. A `head` read before the transaction is used while HEAD is still its
 *  commit, else the record is read again here. Run before the files move, so a crash leaves the base
 *  at HEAD with the files pending or at HEAD. */
export async function rebaseProjectStateOnHeadLocked(
  tx: Tx,
  { repositoryId, repoPath, head }: { repositoryId: string; repoPath: string; head?: HeadRecord },
): Promise<void> {
  const reuse = head?.sha != null && (await headSha(repoPath)) === head.sha;
  const checkout = reuse ? head.checkout : (await readHeadRecord(repoPath)).checkout;
  await applyRebase(tx, repositoryId, checkout);
}

/** The sync row as one comparable string, so a caller can tell whether another writer changed it. */
export async function readProjectStateBase(tx: Tx, repositoryId: string): Promise<string> {
  return JSON.stringify(await readSyncRow(tx, repositoryId));
}

async function rebaseLocked(
  tx: Tx,
  repositoryId: string,
  checkout: Awaited<ReturnType<typeof readCheckout>>,
): Promise<void> {
  await lockProjectState(tx, repositoryId);
  await applyRebase(tx, repositoryId, checkout);
}

async function applyRebase(
  tx: Tx,
  repositoryId: string,
  checkout: Awaited<ReturnType<typeof readCheckout>>,
): Promise<void> {
  if (checkout.kind === 'refused') {
    const row = await readSyncRow(tx, repositoryId);
    if (row !== null && row.lastError !== checkout.reason) {
      await tx
        .update(schema.projectStateSync)
        .set({ lastError: checkout.reason, updatedAt: new Date() })
        .where(eq(schema.projectStateSync.repositoryId, repositoryId));
    }
    return;
  }
  if (checkout.kind === 'absent') {
    const synced = {
      syncedHash: null,
      syncedHead: null,
      baseSnapshot: normalizeProjectState(emptyProjectState()),
      lastError: null,
      updatedAt: new Date(),
    };
    await tx
      .insert(schema.projectStateSync)
      .values({ repositoryId, ...synced })
      .onConflictDoUpdate({ target: schema.projectStateSync.repositoryId, set: synced });
    return;
  }
  const settings = Object.create(null) as Record<string, unknown>;
  Object.assign(settings, intakeSettings(checkout.settings, {}).accepted);
  const tooling = toolingUnitFrom(checkout.settings[TOOLING_UNIT_NAME]);
  if (tooling) settings[TOOLING_UNIT_NAME] = tooling;
  const synced = {
    syncedHash: null,
    syncedHead: null,
    baseSnapshot: normalizeProjectState({
      ...recordOf(checkout.render),
      cli: checkout.cli,
      claims: checkout.claims,
      bundles: checkout.bundles,
      settings,
      environment: checkout.environment && normalizeEnvironment(checkout.environment),
    }),
    lastError: null,
    updatedAt: new Date(),
  };
  await tx
    .insert(schema.projectStateSync)
    .values({ repositoryId, ...synced })
    .onConflictDoUpdate({ target: schema.projectStateSync.repositoryId, set: synced });
}
