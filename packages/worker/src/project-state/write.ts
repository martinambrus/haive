import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import { writeFileNoFollow } from '@haive/shared/fs-safe';
import {
  PROJECT_STATE_DIR,
  RENDER_UNIT,
  conflictSide,
  conflictSideValue,
  emptyProjectState,
  isRenderUnit,
  sameValue,
  normalizeProjectState,
  portableRender,
  renderContextColumnSchema,
  renderProjectState,
  type ProjectRender,
} from '@haive/shared/project-state';
import { CHECKOUT_HOLDING_TASK_STATUSES } from '@haive/shared';
import type { TemplateRenderContext } from '../step-engine/template-manifest.js';

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

/** First in every transaction that writes a repository's render context or its sync row. */
export async function lockProjectState(tx: Tx, repositoryId: string): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`project-state:${repositoryId}`}, 0))`,
  );
}

export interface ProjectStateRecordInput {
  repositoryId: string;
  repoPath: string;
  context: TemplateRenderContext;
  /** Whether `context.rtkEnabled` is a choice somebody made, rather than a default. */
  rtkChoiceRecorded: boolean;
  /** The columns the writer planned against; a column found holding anything else (null aside)
   *  refuses the write before a file changes. Omitted: written whatever the column holds. */
  expectedColumns?: unknown[];
  /** The task writing the record. Its write is refused once the task no longer holds the checkout,
   *  since a refresh may then have fast-forwarded the record files under it. */
  holdingTaskId?: string;
}

/** The column moved past what the writer planned against, so its record would undo a newer one. */
export class ProjectStateMovedError extends Error {
  constructor() {
    super("The repository's project settings changed while this write was pending");
    this.name = 'ProjectStateMovedError';
  }
}

/** A write that failed once it had begun. `written` names the repository-relative record files standing
 *  on disk by then, whatever the database kept, so that whoever commits the repository commits them. */
export class ProjectStateWriteError extends Error {
  readonly written: string[];
  /** The column could not be cleared either, so it still outranks the rows its writer wrote. */
  readonly columnStale: boolean;

  constructor(cause: unknown, written: string[], columnStale = false) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = 'ProjectStateWriteError';
    this.written = written;
    this.columnStale = columnStale;
  }
}

/** A writer reports a failed record write as a warning, unless the column it leaves would outrank the
 *  rows it wrote: that one fails the step, which a retry runs again. */
export function failIfColumnStale(err: unknown): void {
  if (err instanceof ProjectStateWriteError && err.columnStale) throw err;
}

/** The render context column a record write stores for this context. Throws when it would not read back. */
export function renderContextColumnFor(context: TemplateRenderContext, rtkChoiceRecorded: boolean) {
  return renderContextColumnSchema.parse({ ...context, rtkChoiceRecorded });
}

/** A pending conflict of the render unit, its sides as values (`undefined` where a side has none). */
export interface PendingRenderConflict {
  unit: string;
  base: unknown;
  local: unknown;
  incoming: unknown;
}

export async function loadPendingRenderConflicts(
  db: Database | Tx,
  repositoryId: string,
): Promise<PendingRenderConflict[]> {
  const rows = await db
    .select({
      unit: schema.projectStateConflicts.unit,
      base: schema.projectStateConflicts.base,
      local: schema.projectStateConflicts.local,
      incoming: schema.projectStateConflicts.incoming,
    })
    .from(schema.projectStateConflicts)
    .where(
      and(
        eq(schema.projectStateConflicts.repositoryId, repositoryId),
        isNull(schema.projectStateConflicts.resolvedAt),
      ),
    )
    .orderBy(asc(schema.projectStateConflicts.unit));
  return rows
    .filter((row) => isRenderUnit(row.unit))
    .map((row) => ({
      unit: row.unit,
      base: conflictSideValue(row.base),
      local: conflictSideValue(row.local),
      incoming: conflictSideValue(row.incoming),
    }));
}

/** The render unit with every contested key at `side`'s value, the whole unit first. A writer renders
 *  the file with `incoming` and the sync base with `base`, so the next sync meets the same conflict
 *  rather than the writer settling it for the column's side. */
export function overlayRender(
  render: ProjectRender | null,
  pending: readonly PendingRenderConflict[],
  side: 'base' | 'local' | 'incoming',
): ProjectRender | null {
  let out: Record<string, unknown> | null = render;
  for (const row of pending) {
    const value = row[side];
    if (row.unit === RENDER_UNIT) {
      out = (value ?? null) as Record<string, unknown> | null;
      continue;
    }
    const key = row.unit.slice(RENDER_UNIT.length + 1);
    out = { ...out, [key]: value };
  }
  return out as ProjectRender | null;
}

/** Writes the record holding the context's render unit, then moves the repository's render context
 *  and the sync base to it in one transaction. Returns the repository-relative paths written. */
export async function writeProjectStateRecord(
  db: Database,
  {
    repositoryId,
    repoPath,
    context,
    rtkChoiceRecorded,
    expectedColumns,
    holdingTaskId,
  }: ProjectStateRecordInput,
): Promise<string[]> {
  const written: string[] = [];
  let attempted: ProjectRender | null = null;
  try {
    // Refused before anything is written, so the column only ever holds what reads back.
    const column = renderContextColumnFor(context, rtkChoiceRecorded);
    const portable = portableRender(column);
    attempted = portable;
    const planFor = (pending: readonly PendingRenderConflict[]) => ({
      record: { ...emptyProjectState(), render: overlayRender(portable, pending, 'incoming') },
      baseSnapshot: normalizeProjectState({
        ...emptyProjectState(),
        render: overlayRender(portable, pending, 'base'),
      }),
    });
    // A first look only, so its failure must not clear the column: the files then wait for the locked read.
    let seen: PendingRenderConflict[] | null = expectedColumns
      ? []
      : await loadPendingRenderConflicts(db, repositoryId).catch(() => null);
    let plan = planFor(seen ?? []);
    const writeFiles = async (): Promise<void> => {
      for (const [rel, text] of renderProjectState(plan.record)) {
        const path = `${PROJECT_STATE_DIR}/${rel}`;
        await writeFileNoFollow(repoPath, path, text, { createParents: true });
        if (!written.includes(path)) written.push(path);
      }
    };
    // A fenced write keeps the lock from its check to its last write, files included, so no sync
    // lands between them; an unfenced one writes its files first, before any database write.
    if (!expectedColumns && seen !== null) await writeFiles();
    await db.transaction(async (tx) => {
      await lockProjectState(tx, repositoryId);
      if (expectedColumns) {
        await refuseMovedColumn(tx, repositoryId, expectedColumns);
        if (holdingTaskId) await refuseReleasedCheckout(tx, holdingTaskId);
      }
      const pending = await loadPendingRenderConflicts(tx, repositoryId);
      if (expectedColumns || seen === null || !sameValue(pending, seen)) {
        seen = pending;
        plan = planFor(pending);
        await writeFiles();
      }
      const synced = { baseSnapshot: plan.baseSnapshot, lastError: null, updatedAt: new Date() };
      await tx
        .update(schema.repositories)
        .set({ renderContext: column })
        .where(eq(schema.repositories.id, repositoryId));
      await recordLocalSide(tx, repositoryId, portable);
      await tx
        .insert(schema.projectStateSync)
        .values({ repositoryId, ...synced })
        .onConflictDoUpdate({ target: schema.projectStateSync.repositoryId, set: synced });
    });
  } catch (err) {
    if (err instanceof ProjectStateMovedError) throw err;
    const cleared = await clearRenderContext(
      db,
      repositoryId,
      expectedColumns,
      written.length > 0 ? attempted : null,
    );
    throw new ProjectStateWriteError(err, written, !cleared);
  }
  return written;
}

async function refuseReleasedCheckout(tx: Tx, taskId: string): Promise<void> {
  const [task] = await tx
    .select({ status: schema.tasks.status })
    .from(schema.tasks)
    .where(eq(schema.tasks.id, taskId))
    .limit(1);
  if (!task || !(CHECKOUT_HOLDING_TASK_STATUSES as readonly string[]).includes(task.status)) {
    throw new ProjectStateMovedError();
  }
}

/** Throws ProjectStateMovedError when the column holds a context none of `expected` is. Call it
 *  under `lockProjectState`, in the transaction whose write it fences. */
export async function refuseMovedColumn(
  tx: Tx,
  repositoryId: string,
  expected: unknown[],
): Promise<void> {
  const [repo] = await tx
    .select({ renderContext: schema.repositories.renderContext })
    .from(schema.repositories)
    .where(eq(schema.repositories.id, repositoryId))
    .limit(1);
  const now = repo?.renderContext ?? null;
  if (now !== null && !expected.some((c) => sameValue(now, c))) throw new ProjectStateMovedError();
}

/** A column this write could not move would read as newer than the rows its writer just wrote, so it
 *  is cleared and every reader falls back to those rows' snapshot. One a sync moved past `expected`
 *  meanwhile is newer than both and stays. */
/** The value this install now holds for each pending key becomes the row's local side; a key that
 *  now holds what the other side has is no longer contested. */
async function recordLocalSide(
  tx: Tx,
  repositoryId: string,
  rendered: ProjectRender | null,
): Promise<void> {
  for (const row of await loadPendingRenderConflicts(tx, repositoryId)) {
    const local =
      row.unit === RENDER_UNIT
        ? rendered
        : (rendered as Record<string, unknown> | null)?.[row.unit.slice(RENDER_UNIT.length + 1)];
    if (sameValue(local, row.local)) continue;
    const agreed = sameValue(local, row.incoming);
    await tx
      .update(schema.projectStateConflicts)
      .set(
        agreed
          ? { local: conflictSide(local), resolution: 'converged', resolvedAt: new Date() }
          : { local: conflictSide(local) },
      )
      .where(
        and(
          eq(schema.projectStateConflicts.repositoryId, repositoryId),
          eq(schema.projectStateConflicts.unit, row.unit),
          isNull(schema.projectStateConflicts.resolvedAt),
        ),
      );
  }
}

async function clearRenderContext(
  db: Database,
  repositoryId: string,
  expected: unknown[] | undefined,
  attempted: ProjectRender | null,
): Promise<boolean> {
  try {
    await db.transaction(async (tx) => {
      await lockProjectState(tx, repositoryId);
      if (expected) {
        try {
          await refuseMovedColumn(tx, repositoryId, expected);
        } catch (err) {
          if (err instanceof ProjectStateMovedError) return;
          throw err;
        }
      }
      await tx
        .update(schema.repositories)
        .set({ renderContext: null })
        .where(eq(schema.repositories.id, repositoryId));
      // The column was this install's side of each pending key; the next sync rebuilds it from the rows.
      if (attempted) {
        // In a savepoint, so a failure here never undoes the clear above.
        await tx
          .transaction((sp) => recordLocalSide(sp, repositoryId, attempted))
          .catch(() => undefined);
      }
    });
    return true;
  } catch {
    return false;
  }
}
