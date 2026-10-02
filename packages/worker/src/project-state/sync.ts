import { isUtf8 } from 'node:buffer';
import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import { CHECKOUT_HOLDING_TASK_STATUSES, logger } from '@haive/shared';
import { isPathContainmentError, readFileNoFollow, readdirNoFollow } from '@haive/shared/fs-safe';
import {
  PROJECT_STATE_DIR,
  ProjectStateError,
  emptyProjectState,
  mergeProjectState,
  normalizeProjectState,
  parseProjectState,
  portableRender,
  renderContextColumnSchema,
  renderProjectState,
  sameValue,
  type ProjectRender,
  type ProjectStateConflict,
  type ProjectStateRecord,
} from '@haive/shared/project-state';
import {
  loadLiveArtifacts,
  resolveRenderContext,
  unionExpandedFor,
} from '../step-engine/_upgrade-render.js';
import { updateApplicableTemplateIds } from '../step-engine/template-manifest.js';
import { lockProjectState } from './write.js';

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

export type ProjectStateSyncOutcome =
  'absent' | 'refused' | 'deferred' | 'superseded' | 'unchanged' | 'applied' | 'conflict';

export interface ProjectStateSyncResult {
  outcome: ProjectStateSyncOutcome;
  /** Why the record was refused, or what conflicted, worded as `last_error` holds it. */
  reason?: string;
}

const MIB = 1024 * 1024;
const MAX_ENTRIES = 4096;
const MAX_FILE_BYTES = MIB;
const MAX_TOTAL_BYTES = 16 * MIB;

class Refusal extends Error {}

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
async function readStateFiles(repoPath: string): Promise<Map<string, string> | null> {
  const files = new Map<string, string>();
  const pending = [''];
  let entries = 0;
  let bytes = 0;
  for (let dir = pending.pop(); dir !== undefined; dir = pending.pop()) {
    const listing = await readdirNoFollow(repoPath, stateRel(dir), { strict: true });
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

type Checkout =
  | { kind: 'absent' }
  | { kind: 'refused'; reason: string }
  | { kind: 'record'; render: ProjectRender };

async function readCheckout(repoPath: string): Promise<Checkout> {
  const notRead = (detail: string): Checkout => ({
    kind: 'refused',
    reason: `the checkout's record was not read: ${oneLine(detail)}`,
  });
  let files: Map<string, string> | null;
  try {
    files = await readStateFiles(repoPath);
  } catch (err) {
    if (err instanceof Refusal || isPathContainmentError(err)) return notRead(err.message);
    throw err;
  }
  if (files === null) return { kind: 'absent' };
  const parsed = parseProjectState(files);
  if (!parsed.ok) return notRead(listed(parsed.problems));
  const { render } = parsed.record;
  return render === null ? { kind: 'absent' } : { kind: 'record', render };
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
    })
    .from(schema.projectStateSync)
    .where(eq(schema.projectStateSync.repositoryId, repositoryId))
    .limit(1);
  return row ?? null;
}

/** A conflict's unit is `<file>#<key>`, or the file itself when a side holds no such file. */
const keyOf = (unit: string): string => unit.slice(unit.indexOf('#') + 1);

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

/** The set 01's apply writes from the column just written, which upgrade-status compares a
 *  repository's claims against. A repository with no claim keeps its set until 01's first plan. */
async function writeApplicableTemplateIds(
  tx: Tx,
  { repositoryId, userId }: { repositoryId: string; userId: string },
): Promise<void> {
  const liveRows = await loadLiveArtifacts(tx, repositoryId);
  if (liveRows.length === 0) return;
  const resolved = await resolveRenderContext(tx, { repositoryId, userId, liveRows, logger });
  if (resolved === null) {
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

/** A sync from before the set followed the column moved the column alone, and no later sync of the
 *  same files repairs the set it left. Run at boot; where a writer wrote both, it writes the same set. */
export async function recomputeSyncedApplicableSets(db: Database): Promise<void> {
  const repos = await db
    .select({ id: schema.repositories.id, userId: schema.repositories.userId })
    .from(schema.repositories)
    .where(isNotNull(schema.repositories.renderContext));
  for (const repo of repos) {
    try {
      await db.transaction(async (tx) => {
        await lockProjectState(tx, repo.id);
        await writeApplicableTemplateIds(tx, { repositoryId: repo.id, userId: repo.userId });
      });
    } catch (err) {
      logger.warn({ err, repositoryId: repo.id }, 'applicable template ids not recomputed');
    }
  }
}

/** Merges the render unit of the checkout's project state record into the repository's render
 *  context against the base the last sync or writer recorded. Writes the column and the sync row, and
 *  for a repository with a claim the applicable template ids, all in one transaction. */
export async function syncProjectStateFromCheckout(
  db: Database,
  { repositoryId, repoPath }: { repositoryId: string; repoPath: string },
): Promise<ProjectStateSyncResult> {
  // The base goes first: a writer that finishes after it left a newer base for the lock to find.
  const seen = await readSyncRow(db, repositoryId);
  const checkout = await readCheckout(repoPath);
  if (checkout.kind === 'absent') return { outcome: 'absent' };

  return db.transaction(async (tx): Promise<ProjectStateSyncResult> => {
    await lockProjectState(tx, repositoryId);
    const live = await tx
      .select({ id: schema.tasks.id })
      .from(schema.tasks)
      .where(
        and(
          eq(schema.tasks.repositoryId, repositoryId),
          inArray(schema.tasks.type, ['onboarding', 'onboarding_upgrade']),
          inArray(schema.tasks.status, [...CHECKOUT_HOLDING_TASK_STATUSES]),
        ),
      )
      .limit(1);
    if (live.length > 0) return { outcome: 'deferred' };

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

    const [repo] = await tx
      .select({
        renderContext: schema.repositories.renderContext,
        userId: schema.repositories.userId,
      })
      .from(schema.repositories)
      .where(eq(schema.repositories.id, repositoryId))
      .for('update');
    // Deleted since the files were read: its sync row went with it, and nothing is left to write to.
    if (!repo) return { outcome: 'superseded' };
    const column = (repo.renderContext ?? null) as Record<string, unknown> | null;

    const local = recordOf(
      column === null ? null : portableRender(column as Parameters<typeof portableRender>[0]),
    );
    try {
      renderProjectState(local);
    } catch (err) {
      if (!(err instanceof ProjectStateError)) throw err;
      return refuse(`the render context cannot be written as a record: ${listed(err.problems)}`);
    }

    const baseRender = row === null ? null : renderOf(row.baseSnapshot);
    const merge = mergeProjectState({
      base: row === null ? null : recordOf(baseRender),
      local,
      incoming: recordOf(checkout.render),
    });
    const merged = merge.merged.render;
    let wrote = false;
    if (merged !== null && !sameValue(merged, normalizeProjectState(local).render)) {
      const next = renderContextColumnSchema.safeParse({
        ...column,
        ...merged,
        rtkChoiceRecorded: column === null ? true : column.rtkChoiceRecorded,
      });
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
      await writeApplicableTemplateIds(tx, { repositoryId, userId: repo.userId });
    }

    const lastError =
      merge.conflicts.length === 0
        ? null
        : `render context conflicts with the checkout's record: ${merge.conflicts
            .map(({ unit }) => keyOf(unit))
            .join(', ')}`;
    const baseSnapshot = normalizeProjectState(
      recordOf(keptRender(checkout.render, baseRender, merge.conflicts)),
    );
    if (row === null || row.lastError !== lastError || !sameValue(row.baseSnapshot, baseSnapshot)) {
      const synced = { baseSnapshot, lastError, updatedAt: new Date() };
      await tx
        .insert(schema.projectStateSync)
        .values({ repositoryId, ...synced })
        .onConflictDoUpdate({ target: schema.projectStateSync.repositoryId, set: synced });
    }

    if (lastError !== null) return { outcome: 'conflict', reason: lastError };
    return { outcome: wrote ? 'applied' : 'unchanged' };
  });
}
