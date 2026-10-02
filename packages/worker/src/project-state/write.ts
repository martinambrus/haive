import { eq, sql } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import { writeFileNoFollow } from '@haive/shared/fs-safe';
import {
  PROJECT_STATE_DIR,
  emptyProjectState,
  normalizeProjectState,
  portableRender,
  renderContextColumnSchema,
  renderProjectState,
} from '@haive/shared/project-state';
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

/** Writes the record holding the context's render unit, then moves the repository's render context
 *  and the sync base to it in one transaction. Returns the repository-relative paths written. */
export async function writeProjectStateRecord(
  db: Database,
  { repositoryId, repoPath, context, rtkChoiceRecorded }: ProjectStateRecordInput,
): Promise<string[]> {
  const written: string[] = [];
  try {
    // Refused before anything is written, so the column only ever holds what reads back.
    const column = renderContextColumnSchema.parse({ ...context, rtkChoiceRecorded });
    const record = { ...emptyProjectState(), render: portableRender(column) };
    for (const [rel, text] of renderProjectState(record)) {
      const path = `${PROJECT_STATE_DIR}/${rel}`;
      await writeFileNoFollow(repoPath, path, text, { createParents: true });
      written.push(path);
    }

    const synced = {
      baseSnapshot: normalizeProjectState(record),
      lastError: null,
      updatedAt: new Date(),
    };
    await db.transaction(async (tx) => {
      await lockProjectState(tx, repositoryId);
      await tx
        .update(schema.repositories)
        .set({ renderContext: column })
        .where(eq(schema.repositories.id, repositoryId));
      await tx
        .insert(schema.projectStateSync)
        .values({ repositoryId, ...synced })
        .onConflictDoUpdate({ target: schema.projectStateSync.repositoryId, set: synced });
    });
  } catch (err) {
    const cleared = await clearRenderContext(db, repositoryId);
    throw new ProjectStateWriteError(err, written, !cleared);
  }
  return written;
}

/** A column this write could not move would read as newer than the rows its writer just wrote, so it
 *  is cleared and every reader falls back to those rows' snapshot. */
async function clearRenderContext(db: Database, repositoryId: string): Promise<boolean> {
  try {
    await db.transaction(async (tx) => {
      await lockProjectState(tx, repositoryId);
      await tx
        .update(schema.repositories)
        .set({ renderContext: null })
        .where(eq(schema.repositories.id, repositoryId));
    });
    return true;
  } catch {
    return false;
  }
}
