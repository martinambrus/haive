import { and, eq } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import {
  globalKbEntries,
  resolveGlobalKbSettings,
  withGlobalKb,
  type GlobalKbCategory,
  type GlobalKbFacets,
} from '@haive/shared/global-kb';

export interface GlobalKbPromotion {
  userId: string;
  taskId: string;
  title: string;
  /** Markdown body. */
  body: string;
  category: GlobalKbCategory;
  facets: GlobalKbFacets;
}

interface PromoteLogger {
  warn: (obj: unknown, msg: string) => void;
}

/** Promote a generalizable knowledge item to the cross-repo global KB as a DRAFT
 *  (`source='promoted'`). Drafts hold no vectors and are not retrievable until an
 *  admin activates them in Settings → Global KB, so this NEVER touches the
 *  per-repo RAG — the routing gate keeps the local store clean by construction.
 *  Looks up the task's repository for provenance. Best-effort: any failure is
 *  logged and returns null so promotion can never fail the orchestration step. */
export async function promoteToGlobalKbDraft(
  db: Database,
  promotion: GlobalKbPromotion,
  log: PromoteLogger,
): Promise<string | null> {
  try {
    const task = await db.query.tasks.findFirst({
      where: eq(schema.tasks.id, promotion.taskId),
      columns: { repositoryId: true },
    });
    return await withGlobalKb(db, async ({ db: gdb, settings }) => {
      const [row] = await gdb
        .insert(globalKbEntries)
        .values({
          namespace: settings.namespace,
          userId: promotion.userId,
          title: promotion.title,
          body: promotion.body,
          category: promotion.category,
          facets: promotion.facets,
          status: 'draft',
          source: 'promoted',
          sourceTaskId: promotion.taskId,
          sourceRepoId: task?.repositoryId ?? null,
          embedStatus: 'pending',
        })
        .returning({ id: globalKbEntries.id });
      return row?.id ?? null;
    });
  } catch (err) {
    log.warn({ err, title: promotion.title }, 'global KB promotion failed (skipped)');
    return null;
  }
}

/** Delete the DRAFT promotions a prior run of this task created, so re-running a
 *  promoting step (a Retry) REPLACES rather than DUPLICATES them. Call once
 *  before re-promoting. Only `status='draft' source='promoted'` rows for this
 *  task are removed — entries the user already activated (curated KB) are left
 *  untouched, and drafts hold no vectors so deleting the row is enough. No-ops
 *  when the global KB is disabled (so a normal run never opens the store).
 *  Best-effort: any failure is logged and returns 0 so it can never fail the
 *  orchestration step. Returns the number of drafts removed. */
export async function clearTaskPromotedDrafts(
  db: Database,
  taskId: string,
  log: PromoteLogger,
): Promise<number> {
  try {
    const settings = await resolveGlobalKbSettings();
    if (!settings.enabled) return 0;
    return await withGlobalKb(db, async ({ db: gdb }) => {
      const removed = await gdb
        .delete(globalKbEntries)
        .where(
          and(
            eq(globalKbEntries.sourceTaskId, taskId),
            eq(globalKbEntries.status, 'draft'),
            eq(globalKbEntries.source, 'promoted'),
          ),
        )
        .returning({ id: globalKbEntries.id });
      return removed.length;
    });
  } catch (err) {
    log.warn({ err, taskId }, 'global KB draft cleanup failed (skipped)');
    return 0;
  }
}
