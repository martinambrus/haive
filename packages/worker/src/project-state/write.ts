import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import { removeFileIfNoFollow, writeFileNoFollow } from '@haive/shared/fs-safe';
import {
  PROJECT_STATE_DIR,
  RENDER_UNIT,
  claimFileName,
  conflictSide,
  conflictSideValue,
  emptyProjectState,
  isClaimablePath,
  isRenderUnit,
  sameValue,
  normalizeProjectState,
  portableBundleSource,
  portableRender,
  portableTemplateId,
  renderContextColumnSchema,
  renderProjectState,
  type LocalBundle,
  type ProjectRender,
  type ProjectStateClaim,
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

interface Look {
  pending: PendingRenderConflict[];
  claims: ProjectStateClaim[];
  baseFiles: string[];
}

const CLAIM_FILE_PREFIX = `${PROJECT_STATE_DIR}/artifacts/`;
const isClaimFile = (path: string): boolean => path.startsWith(CLAIM_FILE_PREFIX);

/** The column moved past what the writer planned against, so its record would undo a newer one. */
export class ProjectStateMovedError extends Error {
  constructor() {
    super("The repository's project settings changed while this write was pending");
    this.name = 'ProjectStateMovedError';
  }
}

/** What a record write left behind, as repository-relative paths: the files it wrote and the claim
 *  files it removed, for whoever commits the repository to stage. */
export interface ProjectStateWriteResult {
  written: string[];
  removed: string[];
}

/** A write that failed once it had begun. `written` and `removed` name the repository-relative record
 *  files standing on disk, and the claim files gone from it, by then, whatever the database kept, so
 *  that whoever commits the repository commits them. */
export class ProjectStateWriteError extends Error {
  readonly written: string[];
  readonly removed: string[];
  /** The column could not be cleared either, so it still outranks the rows its writer wrote. */
  readonly columnStale: boolean;

  constructor(cause: unknown, written: string[], columnStale = false, removed: string[] = []) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = 'ProjectStateWriteError';
    this.written = written;
    this.removed = removed;
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

async function loadLocalBundles(db: Database | Tx, repositoryId: string): Promise<LocalBundle[]> {
  const bundles = await db
    .select({
      id: schema.customBundles.id,
      name: schema.customBundles.name,
      sourceType: schema.customBundles.sourceType,
      gitUrl: schema.customBundles.gitUrl,
      gitBranch: schema.customBundles.gitBranch,
    })
    .from(schema.customBundles)
    .where(eq(schema.customBundles.repositoryId, repositoryId));
  if (bundles.length === 0) return [];
  const items = await db
    .select({
      id: schema.customBundleItems.id,
      bundleId: schema.customBundleItems.bundleId,
      sourcePath: schema.customBundleItems.sourcePath,
    })
    .from(schema.customBundleItems)
    .where(
      inArray(
        schema.customBundleItems.bundleId,
        bundles.map((b) => b.id),
      ),
    );
  return bundles.map((b) => ({
    bundleId: b.id,
    source: portableBundleSource(b),
    items: new Map(items.filter((i) => i.bundleId === b.id).map((i) => [i.id, i.sourcePath])),
  }));
}

/** One claim per live ledger row of the repository a record can name: a path a claim may hold,
 *  and a template another install can map back. Import markers are live rows like any other. */
export async function loadRecordClaims(
  db: Database | Tx,
  repositoryId: string,
): Promise<ProjectStateClaim[]> {
  const rows = await db
    .select({
      diskPath: schema.onboardingArtifacts.diskPath,
      templateId: schema.onboardingArtifacts.templateId,
      templateKind: schema.onboardingArtifacts.templateKind,
      templateSchemaVersion: schema.onboardingArtifacts.templateSchemaVersion,
      templateContentHash: schema.onboardingArtifacts.templateContentHash,
      writtenHash: schema.onboardingArtifacts.writtenHash,
      haiveVersion: schema.onboardingArtifacts.haiveVersion,
    })
    .from(schema.onboardingArtifacts)
    .where(
      and(
        eq(schema.onboardingArtifacts.repositoryId, repositoryId),
        isNull(schema.onboardingArtifacts.supersededAt),
      ),
    )
    .orderBy(asc(schema.onboardingArtifacts.diskPath));
  const bundles = rows.some((r) => r.templateId.startsWith('custom.'))
    ? await loadLocalBundles(db, repositoryId)
    : [];
  const claims: ProjectStateClaim[] = [];
  for (const row of rows) {
    if (!isClaimablePath(row.diskPath)) continue;
    const templateId = portableTemplateId(row.templateId, bundles);
    if (templateId === null || templateId === '') continue;
    claims.push({
      path: row.diskPath,
      templateId,
      kind: row.templateKind,
      schemaVersion: row.templateSchemaVersion,
      templateHash: row.templateContentHash,
      writtenHash: row.writtenHash,
      haiveVersion: row.haiveVersion ?? '',
    });
  }
  return claims;
}

/** The claim files the sync base names: the ones this install holds, whoever wrote them. */
async function loadBaseClaimFiles(db: Database | Tx, repositoryId: string): Promise<string[]> {
  const [row] = await db
    .select({ baseSnapshot: schema.projectStateSync.baseSnapshot })
    .from(schema.projectStateSync)
    .where(eq(schema.projectStateSync.repositoryId, repositoryId))
    .limit(1);
  const claims = (row?.baseSnapshot as { claims?: unknown } | null | undefined)?.claims;
  if (!Array.isArray(claims)) return [];
  const files: string[] = [];
  for (const claim of claims) {
    const path = (claim as { path?: unknown } | null)?.path;
    if (typeof path === 'string' && isClaimablePath(path)) {
      files.push(`${PROJECT_STATE_DIR}/${claimFileName(path)}`);
    }
  }
  return files;
}

/** Writes the record holding the context's render unit and one claim per live ledger row, then moves
 *  the repository's render context and the sync base to it in one transaction. A claim file the
 *  previous base named and the record no longer holds is removed; one it never named is not touched.
 *  Returns the repository-relative paths written and removed. */
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
): Promise<ProjectStateWriteResult> {
  const written: string[] = [];
  const removed: string[] = [];
  let attempted: ProjectRender | null = null;
  try {
    // Refused before anything is written, so the column only ever holds what reads back.
    const column = renderContextColumnFor(context, rtkChoiceRecorded);
    const portable = portableRender(column);
    attempted = portable;
    const planFor = (look: Look) => ({
      record: {
        ...emptyProjectState(),
        render: overlayRender(portable, look.pending, 'incoming'),
        claims: look.claims,
      },
      baseSnapshot: normalizeProjectState({
        ...emptyProjectState(),
        render: overlayRender(portable, look.pending, 'base'),
        claims: look.claims,
      }),
    });
    const lookAt = async (reader: Database | Tx): Promise<Look> => ({
      pending: await loadPendingRenderConflicts(reader, repositoryId),
      claims: await loadRecordClaims(reader, repositoryId),
      baseFiles: await loadBaseClaimFiles(reader, repositoryId),
    });
    // A first look only, so its failure must not clear the column: the files then wait for the locked read.
    let seen: Look | null = expectedColumns ? null : await lookAt(db).catch(() => null);
    let plan = planFor(seen ?? { pending: [], claims: [], baseFiles: [] });
    const writeFiles = async (baseFiles: readonly string[]): Promise<void> => {
      const files = renderProjectState(plan.record);
      const produced = new Set<string>();
      for (const [rel, text] of files) {
        const path = `${PROJECT_STATE_DIR}/${rel}`;
        produced.add(path);
        await writeFileNoFollow(repoPath, path, text, { createParents: true });
        if (!written.includes(path)) written.push(path);
        const back = removed.indexOf(path);
        if (back >= 0) removed.splice(back, 1);
      }
      const owned = new Set([...baseFiles, ...written.filter(isClaimFile)]);
      for (const path of owned) {
        if (produced.has(path)) continue;
        const gone = await removeFileIfNoFollow(repoPath, path, () => true);
        const was = written.indexOf(path);
        if (was >= 0) written.splice(was, 1);
        if (gone === 'removed' && !removed.includes(path)) removed.push(path);
      }
    };
    // A fenced write keeps the lock from its check to its last write, files included, so no sync
    // lands between them; an unfenced one writes its files first, before any database write.
    if (!expectedColumns && seen !== null) await writeFiles(seen.baseFiles);
    await db.transaction(async (tx) => {
      await lockProjectState(tx, repositoryId);
      if (expectedColumns) {
        await refuseMovedColumn(tx, repositoryId, expectedColumns);
        if (holdingTaskId) await refuseReleasedCheckout(tx, holdingTaskId);
      }
      const now = await lookAt(tx);
      if (expectedColumns || seen === null || !sameValue(now, seen)) {
        seen = now;
        plan = planFor(now);
        await writeFiles(now.baseFiles);
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
      written.includes(`${PROJECT_STATE_DIR}/${RENDER_UNIT}`) ? attempted : null,
    );
    throw new ProjectStateWriteError(err, written, !cleared, removed);
  }
  return { written, removed };
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
        await recordLocalSide(tx, repositoryId, attempted);
      }
    });
    return true;
  } catch {
    return false;
  }
}
