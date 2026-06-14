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
  /** Cross-repo dedup key (`category:tech`). When set and a matching entry
   *  already exists, the promotion is skipped instead of inserting a duplicate. */
  topicKey?: string;
  /** Source repo's project name, used to genericize the article so it is portable
   *  across repos (drops the name from the title, replaces it + its package scope
   *  in the body with a placeholder). Omit to skip name scrubbing. */
  projectName?: string | null;
}

interface PromoteLogger {
  warn: (obj: unknown, msg: string) => void;
}

/** Placeholder substituted for the source project's name in a promoted article,
 *  chosen to read as an obvious "rename me" token for a future reader/model. */
const GLOBAL_PLACEHOLDER = 'example-app';

/** Project names too generic to safely find-and-replace in article text (a blanket
 *  swap would corrupt unrelated prose/code). Such a name is left as-is. */
const GENERIC_PROJECT_NAMES = new Set([
  'app',
  'api',
  'web',
  'test',
  'tests',
  'demo',
  'site',
  'core',
  'main',
  'src',
  'lib',
  'repo',
  'project',
  'example',
  'server',
  'client',
  'backend',
  'frontend',
  'admin',
  'worker',
  'shared',
  'monorepo',
]);

/** Make a promoted article portable for ANY repo on the same stack: always strip
 *  the trailing `## Source files` footer (a repo file list), and when the project
 *  name is distinctive, remove it from the title and replace it (plus its `@name/`
 *  package scope) in the body with an obvious placeholder so a future reader knows
 *  to rename it. A generic name (e.g. "app", "test") is left untouched to avoid
 *  corrupting unrelated text. Pure + deterministic; exported for unit testing. */
export function sanitizeGlobalArticle(input: {
  title: string;
  body: string;
  projectName?: string | null;
}): { title: string; body: string } {
  // 1. Drop a trailing "## Source files" section regardless of the project name —
  //    a portable article must never list a specific repo's files.
  let body = input.body.replace(/\n#{1,6}[ \t]+source files\b[\s\S]*$/i, '').trimEnd() + '\n';
  let title = input.title;

  const name = (input.projectName ?? '').trim();
  if (name.length >= 4 && !GENERIC_PROJECT_NAMES.has(name.toLowerCase())) {
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const nameRe = new RegExp(esc, 'gi');
    // Body: `@name/...` scope and bare name -> placeholder.
    body = body.replace(nameRe, GLOBAL_PLACEHOLDER);
    // Title: drop the name plus a leading/trailing connector ("for/in/of", "-", ":"),
    // then tidy. Keep the original if scrubbing would empty it.
    const scrubbed = title
      .replace(new RegExp(`\\s*(?:[-—–:]|\\b(?:for|in|of)\\b)\\s*${esc}\\b`, 'i'), '')
      .replace(nameRe, '')
      .replace(/\s{2,}/g, ' ')
      .replace(/^[\s\-—–:]+|[\s\-—–:]+$/g, '')
      .trim();
    if (scrubbed) title = scrubbed;
  }
  return { title, body };
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
): Promise<{ id: string; deduped: boolean } | null> {
  try {
    const task = await db.query.tasks.findFirst({
      where: eq(schema.tasks.id, promotion.taskId),
      columns: { repositoryId: true },
    });
    return await withGlobalKb(db, async ({ db: gdb, settings }) => {
      // Cross-repo dedup: if another promotion already covers this topic
      // (category:tech), skip the insert so re-onboarding many projects does not
      // stack duplicate drafts. The per-task draft cleanup runs first, so this
      // only ever matches OTHER tasks' or already-activated entries.
      if (promotion.topicKey) {
        const [existing] = await gdb
          .select({ id: globalKbEntries.id, status: globalKbEntries.status })
          .from(globalKbEntries)
          .where(
            and(
              eq(globalKbEntries.namespace, settings.namespace),
              eq(globalKbEntries.topicKey, promotion.topicKey),
            ),
          )
          .limit(1);
        if (existing) {
          log.warn(
            { topicKey: promotion.topicKey, existingId: existing.id, status: existing.status },
            'global KB promotion deduped (topic already covered)',
          );
          return { id: existing.id, deduped: true };
        }
      }
      const clean = sanitizeGlobalArticle({
        title: promotion.title,
        body: promotion.body,
        projectName: promotion.projectName,
      });
      const [row] = await gdb
        .insert(globalKbEntries)
        .values({
          namespace: settings.namespace,
          userId: promotion.userId,
          title: clean.title,
          body: clean.body,
          category: promotion.category,
          facets: promotion.facets,
          status: 'draft',
          source: 'promoted',
          sourceTaskId: promotion.taskId,
          sourceRepoId: task?.repositoryId ?? null,
          topicKey: promotion.topicKey ?? null,
          embedStatus: 'pending',
        })
        .returning({ id: globalKbEntries.id });
      return row ? { id: row.id, deduped: false } : null;
    });
  } catch (err) {
    log.warn({ err, title: promotion.title }, 'global KB promotion failed (skipped)');
    return null;
  }
}

/** Stable cross-repo dedup key for a promoted entry: `category:normalizedTech`
 *  (tech lowercased to its alphanumerics). Null when no tech is known — such a
 *  promotion is never deduped (always inserted). */
export function globalKbTopicKey(category: string, tech: string | null | undefined): string | null {
  if (!tech) return null;
  const norm = tech.toLowerCase().replace(/[^a-z0-9]+/g, '');
  return norm ? `${category}:${norm}` : null;
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
