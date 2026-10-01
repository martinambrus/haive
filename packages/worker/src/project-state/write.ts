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

  constructor(cause: unknown, written: string[]) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = 'ProjectStateWriteError';
    this.written = written;
  }
}

/** Writes the record holding the context's render unit, then moves the repository's render context
 *  and the sync base to it in one transaction. Returns the repository-relative paths written. */
export async function writeProjectStateRecord(
  db: Database,
  { repositoryId, repoPath, context, rtkChoiceRecorded }: ProjectStateRecordInput,
): Promise<string[]> {
  // Refused before anything is written, so the column only ever holds what reads back.
  const column = renderContextColumnSchema.parse({ ...context, rtkChoiceRecorded });
  const record = { ...emptyProjectState(), render: portableRender(column) };
  const files = renderProjectState(record);
  const written: string[] = [];
  try {
    for (const [rel, text] of files) {
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
    throw new ProjectStateWriteError(err, written);
  }
  return written;
}
