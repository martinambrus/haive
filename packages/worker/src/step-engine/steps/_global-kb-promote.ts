import { and, desc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import {
  globalKbEntries,
  resolveGlobalKbSettings,
  resolveTaskFacets,
  withGlobalKb,
  type GlobalKbCategory,
  type GlobalKbFacets,
  type ProjectFacetSet,
} from '@haive/shared/global-kb';
import { embedQuery, ragHybridSearch, type RagConnection } from '@haive/shared/rag';
import { facetsMatchProject } from './_global-kb-digest.js';
import { confirmSupersedeByEmbedding, SUPERSEDE_CANDIDATE_LIMIT } from './_global-kb-similarity.js';

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
  info: (obj: unknown, msg: string) => void;
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

/** Entries scanned (titles + facets only) before facet filtering and ranking.
 *  Wide because it no longer costs prompt tokens: bodies are read for the
 *  `limit` articles that actually get rendered. Ordered newest-first, so what an
 *  overflowing corpus drops is the stalest. */
const ARTICLE_SCAN_LIMIT = 400;

/** Compatible titles listed after the rendered bodies. Generous — a title is a
 *  dozen words and the point is that no applicable article is dropped without
 *  the agent being told it exists. Whatever exceeds it is reported as a count,
 *  never omitted in silence. */
const OTHER_TITLE_LIMIT = 100;

/** Chunks requested per article slot. An entry chunks into a handful of
 *  sections, so asking for several times the entry budget is what makes it
 *  likely that `limit` DISTINCT entries appear in the ranked chunk list. */
const CHUNKS_PER_ARTICLE_ALLOWANCE = 5;

/** Fetch the active global KB articles that apply to THIS task's project, so a
 *  step can show the agent which existing house-standard articles it could
 *  update. Best-effort: [] when the global KB is off/unavailable or nothing
 *  matches.
 *
 *  Compatibility is `facetsMatchProject` — the SAME predicate the prompt digest
 *  and the rag_search facet filter use. It previously had a private rule here
 *  that required a positive intersection on framework/language/database, which
 *  silently inverted the meaning of an UNCONSTRAINED entry: the shared rule
 *  treats a dimension an entry does not constrain as universal (it applies
 *  everywhere), the private one matched it against nothing and dropped it.
 *  MEASURED: 19 of 60 active entries carry no facets at all. The digest listed
 *  those titles as available while this loader withheld their bodies, so step 11
 *  advertised an article and then refused to show it — on task 201dfef3 the
 *  agent saw "Apache 2.4 authz merging ..." in the index, could not read its
 *  body, and skipped the update it was asked to author. Two predicates for one
 *  question is the bug; there is now one.
 *
 *  Compatible entries are then ORDERED by similarity to `relevanceQuery` (the
 *  task's own subject), not by recency. `updated_at desc` was standing in for
 *  relevance, which holds only while the compatible set is smaller than `limit`:
 *  past that the cut is arbitrary, and the article this block exists to offer is
 *  as likely to be dropped as kept. Ranking is best-effort — with no query, or
 *  when the search itself fails, this falls back to exactly the recency order it
 *  replaced. */
export interface GlobalArticleSelection {
  /** Rendered in full (subject to the prompt's per-article budget), best match first. */
  articles: { title: string; body: string }[];
  /** Every OTHER applicable article, by title. Reachable with `rag_search`. */
  otherTitles: string[];
  /** Applicable articles that did not fit even the title list. Reported, not hidden. */
  omittedTitleCount: number;
}

export async function loadActiveGlobalArticlesForTask(
  db: Database,
  taskId: string,
  relevanceQuery = '',
  limit = 15,
): Promise<GlobalArticleSelection> {
  const empty: GlobalArticleSelection = { articles: [], otherTitles: [], omittedTitleCount: 0 };
  try {
    const projectFacets = await resolveTaskFacets(db, taskId);
    return await withGlobalKb(db, async ({ conn, db: gdb, settings }) => {
      // Titles + facets only. Bodies are fetched for the chosen few at the end,
      // so the scan can be wide enough to survive corpus growth without the
      // prompt paying for it.
      const rows = await gdb
        .select({
          id: globalKbEntries.id,
          title: globalKbEntries.title,
          facets: globalKbEntries.facets,
        })
        .from(globalKbEntries)
        .where(
          and(
            eq(globalKbEntries.namespace, settings.namespace),
            eq(globalKbEntries.status, 'active'),
            isNull(globalKbEntries.supersededAt),
          ),
        )
        .orderBy(desc(globalKbEntries.updatedAt))
        .limit(ARTICLE_SCAN_LIMIT);
      const compatible = rows.filter((r) => facetsMatchProject(r.facets, projectFacets));
      if (compatible.length === 0) return empty;

      const compatibleIds = new Set(compatible.map((r) => r.id));
      const ranked = relevanceQuery.trim()
        ? await rankArticleIdsByRelevance(
            conn,
            settings,
            projectFacets,
            relevanceQuery,
            compatibleIds,
            limit,
          )
        : [];

      const ids = mergeRankedWithRecency(
        ranked,
        compatible.map((r) => r.id),
        limit,
      );
      if (ids.length === 0) return empty;

      const bodies = await gdb
        .select({
          id: globalKbEntries.id,
          title: globalKbEntries.title,
          body: globalKbEntries.body,
        })
        .from(globalKbEntries)
        .where(inArray(globalKbEntries.id, ids));
      const byId = new Map(bodies.map((b) => [b.id, b]));
      const articles = ids
        .map((id) => byId.get(id))
        .filter((b): b is { id: string; title: string; body: string } => !!b)
        .map((b) => ({ title: b.title, body: b.body }));

      // Everything else that APPLIES, by title. Bodies are budgeted; awareness is
      // not. 15 body slots against 56 compatible entries (measured) means the
      // ordering only decides which bodies ride along — whichever article the
      // agent actually needs must still be nameable, and `rag_search` returns any
      // title in full.
      const rest = compatible.filter((r) => !ids.includes(r.id)).map((r) => r.title);
      return {
        articles,
        otherTitles: rest.slice(0, OTHER_TITLE_LIMIT),
        omittedTitleCount: Math.max(0, rest.length - OTHER_TITLE_LIMIT),
      };
    });
  } catch {
    return empty;
  }
}

/** Relevance order first, then the newest of whatever it did not name, capped at
 *  `limit`. The top-up keeps the block the size it has always been, so a task
 *  whose subject matches nothing is no worse off than it was before ranking
 *  existed — degrading to the old behaviour, never to a shorter list. */
export function mergeRankedWithRecency(
  ranked: string[],
  byRecency: string[],
  limit: number,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of [...ranked, ...byRecency]) {
    if (out.length >= limit) break;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/** Active entry ids most similar to `query`, best first, restricted to
 *  `compatibleIds`.
 *
 *  Ranking is the SAME hybrid search an agent's `rag_search` runs against the
 *  same store with the same facet filter, so an article this block offers is one
 *  the agent could also have found — there is no third notion of relevance in
 *  the codebase.
 *
 *  Degrades in two stages, never to nothing. With no embedding model configured
 *  `embedQuery` hash-embeds instead of throwing, so the dense half becomes noise
 *  and the ranking falls back to the LEXICAL half of the same fusion. Only a
 *  thrown search (an index that is not built, an unreachable store) returns [],
 *  and the caller then falls back to the recency order this replaced. Retrieval
 *  degrading must never cost the step its article list. */
async function rankArticleIdsByRelevance(
  conn: RagConnection,
  settings: {
    namespace: string;
    ollamaUrl: string | null;
    embedModel: string | null;
    embeddingDimensions: number;
  },
  facets: ProjectFacetSet,
  query: string,
  compatibleIds: Set<string>,
  limit: number,
): Promise<string[]> {
  try {
    const vec = await embedQuery(query, {
      ollamaUrl: settings.ollamaUrl,
      model: settings.embedModel,
      dimensions: settings.embeddingDimensions,
    });
    const hits = await ragHybridSearch(
      conn,
      vec,
      query,
      { topK: limit * CHUNKS_PER_ARTICLE_ALLOWANCE },
      { namespace: settings.namespace, facets },
    );
    if (hits.length === 0) return [];

    // Chunks carry a source path, not an entry id. Resolve through the stored
    // column rather than re-deriving the synthetic path a third time.
    const paths = [...new Set(hits.map((h) => h.sourcePath))];
    const placeholders = paths.map((_, i) => `$${i + 2}`).join(', ');
    const rows = (await conn.pg.unsafe(
      `SELECT DISTINCT ON (source_path) source_path, entry_id
         FROM ai_rag_embeddings
        WHERE namespace = $1 AND source_path IN (${placeholders})`,
      [settings.namespace, ...paths],
    )) as unknown as Array<{ source_path: string; entry_id: string }>;
    const entryByPath = new Map(rows.map((r) => [r.source_path, r.entry_id]));

    const ordered: string[] = [];
    const seen = new Set<string>();
    for (const h of hits) {
      const entryId = entryByPath.get(h.sourcePath);
      // compatibleIds is belt-and-braces: the SQL facet filter above already
      // applies the same rule, but it reads the chunk's copy of the facets and
      // this reads the entry's, so an entry mid-re-embed cannot slip through.
      if (!entryId || seen.has(entryId) || !compatibleIds.has(entryId)) continue;
      seen.add(entryId);
      ordered.push(entryId);
      if (ordered.length >= limit) break;
    }
    return ordered;
  } catch {
    return [];
  }
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
): Promise<{ id: string; deduped: boolean; supersedesEntryId?: string | null } | null> {
  try {
    const task = await db.query.tasks.findFirst({
      where: eq(schema.tasks.id, promotion.taskId),
      columns: { repositoryId: true },
    });
    return await withGlobalKb(db, async ({ db: gdb, settings }) => {
      const clean = sanitizeGlobalArticle({
        title: promotion.title,
        body: promotion.body,
        projectName: promotion.projectName,
      });
      // Cross-repo reconcile: when another entry already covers this topic
      // (category:tech[:major]), DON'T discard the new knowledge — unless it is
      // byte-identical we keep it as a draft LINKED to that entry (supersedesEntryId)
      // so the merge step can enrich it (keep unique info, dedup overlap) and, on
      // activation, supersede the existing one. The existing entry — possibly a
      // curated active — is never mutated here. The per-task draft cleanup runs
      // first, so this matches OTHER tasks' or already-activated entries.
      //
      // The SELECT..INSERT runs in one transaction under a topic-scoped advisory lock
      // so concurrent promotions of the SAME topic serialize: the second waits, then
      // sees the first's committed draft and dedups/links instead of inserting a blind
      // duplicate. Distinct topics never contend; the xact lock auto-releases on end.
      return await gdb.transaction(async (tx) => {
        let supersedesEntryId: string | null = null;
        if (promotion.topicKey) {
          const lockKey = `${settings.namespace}:${promotion.topicKey}`;
          await tx.execute(
            sql`SELECT pg_advisory_xact_lock(hashtext('gkb_promote'), hashtext(${lockKey}))`,
          );
          const candidates = await tx
            .select({
              id: globalKbEntries.id,
              status: globalKbEntries.status,
              title: globalKbEntries.title,
              body: globalKbEntries.body,
            })
            .from(globalKbEntries)
            .where(
              and(
                eq(globalKbEntries.namespace, settings.namespace),
                eq(globalKbEntries.topicKey, promotion.topicKey),
                // Don't reconcile against a superseded (archived) entry — it's on its
                // way out; match only live drafts/actives for this topic.
                ne(globalKbEntries.status, 'archived'),
              ),
            )
            // Prefer the canonical active entry; else the newest.
            .orderBy(
              sql`case when ${globalKbEntries.status} = 'active' then 0 else 1 end`,
              desc(globalKbEntries.createdAt),
            )
            .limit(SUPERSEDE_CANDIDATE_LIMIT);
          // Exact duplicate of any same-key entry: nothing new to add, skip the insert.
          const identical = candidates.find((c) => c.body.trim() === clean.body.trim());
          if (identical) {
            log.info(
              { topicKey: promotion.topicKey, existingId: identical.id },
              'global KB promotion skipped (identical content already present)',
            );
            return { id: identical.id, deduped: true, supersedesEntryId: null };
          }
          // Supersede an existing entry ONLY when embeddings confirm it is the SAME
          // article — the coarse topicKey (category:tech) groups unrelated articles on
          // one tech, so it can't decide identity. No confirmed match (or ollama
          // unavailable) -> insert an INDEPENDENT new draft; never clobber a different
          // article that merely shares the key.
          if (candidates.length > 0) {
            supersedesEntryId = await confirmSupersedeByEmbedding(
              { ollamaUrl: settings.ollamaUrl, embedModel: settings.embedModel },
              `${clean.title}\n\n${clean.body}`,
              candidates.map((c) => ({
                id: c.id,
                status: c.status,
                text: `${c.title}\n\n${c.body}`,
              })),
            );
            log.info(
              { topicKey: promotion.topicKey, candidates: candidates.length, supersedesEntryId },
              supersedesEntryId
                ? 'global KB promotion linked to existing topic (similarity-confirmed)'
                : 'global KB promotion kept independent (no same-article match)',
            );
          }
        }
        const [row] = await tx
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
            supersedesEntryId,
            embedStatus: 'pending',
          })
          .returning({ id: globalKbEntries.id });
        return row ? { id: row.id, deduped: false, supersedesEntryId } : null;
      });
    });
  } catch (err) {
    log.warn({ err, title: promotion.title }, 'global KB promotion failed (skipped)');
    return null;
  }
}

/** Stable cross-repo dedup key for a promoted entry: `category:tech[:major]`.
 *
 *  The tech + major are taken from the DETECTION-DERIVED facets (built by
 *  techAnchorFacets), which are stable across runs — unlike the free-form `tech`
 *  string the LLM emits, which drifts ("php" <-> "php5") for the SAME article and so
 *  broke dedup (the original bug: identical facets, divergent topic_key). Priority
 *  mirrors how techAnchorFacets pins a single dimension; a tech-bucket article sets
 *  exactly one. The major keeps genuinely-different majors apart (PHP 5 vs PHP 8).
 *  Falls back to the free-form `tech` only when the facets carry no anchor. Null when
 *  neither yields a tech — such a promotion is never deduped (always inserted). */
export function globalKbTopicKey(
  category: string,
  facets: GlobalKbFacets,
  fallbackTech?: string | null,
): string | null {
  const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '');
  const first = (a?: string[]): string | null => (a && a.length > 0 ? (a[0] ?? null) : null);

  let tech: string | null = null;
  let major: string | null = null;
  const pkg = first(facets.packages); // e.g. "vitest@3", "@scope/name@18.2"
  if (pkg) {
    const at = pkg.lastIndexOf('@');
    if (at > 0) {
      tech = pkg.slice(0, at);
      major = pkg.slice(at + 1).split('.')[0] || null;
    } else {
      tech = pkg;
    }
  } else if (first(facets.framework)) {
    tech = first(facets.framework);
    major = first(facets.frameworkMajor);
  } else if (first(facets.database)) {
    tech = first(facets.database);
    major = first(facets.dbMajor);
  } else if (first(facets.language)) {
    tech = first(facets.language);
    major = first(facets.phpMajor) ?? first(facets.nodeMajor);
  }

  const techNorm = tech ? norm(tech) : fallbackTech ? norm(fallbackTech) : '';
  if (!techNorm) return null;
  const majorNorm = major ? norm(major) : '';
  return majorNorm ? `${category}:${techNorm}:${majorNorm}` : `${category}:${techNorm}`;
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

/** When a kb_author enrich task ends without producing a real article, reconcile its
 *  linked global KB entry (only while still `skeleton`/`enriching`): a FAILED task marks
 *  the entry `failed` (kept so the user can retry from the KB view); a CANCELLED task
 *  deletes it (the user abandoned it, so the orphan row is removed). No-op for a
 *  non-kb_author task or a disabled global KB. Best-effort: never throws — it runs
 *  inside task teardown and must not break it. */
export async function reconcileKbAuthorEntryOnTaskEnd(
  db: Database,
  taskId: string,
  outcome: 'failed' | 'cancelled',
  log: PromoteLogger,
): Promise<void> {
  try {
    const task = await db.query.tasks.findFirst({
      where: eq(schema.tasks.id, taskId),
      columns: { type: true },
    });
    if (task?.type !== 'kb_author') return;
    const settings = await resolveGlobalKbSettings();
    if (!settings.enabled) return;
    await withGlobalKb(db, async ({ db: gdb }) => {
      const where = and(
        eq(globalKbEntries.sourceTaskId, taskId),
        inArray(globalKbEntries.status, ['skeleton', 'enriching']),
      );
      if (outcome === 'cancelled') {
        const removed = await gdb
          .delete(globalKbEntries)
          .where(where)
          .returning({ id: globalKbEntries.id });
        if (removed.length)
          log.info({ taskId, removed: removed.length }, 'kb_author entry removed on task cancel');
      } else {
        const updated = await gdb
          .update(globalKbEntries)
          .set({ status: 'failed', updatedAt: new Date() })
          .where(where)
          .returning({ id: globalKbEntries.id });
        if (updated.length)
          log.info({ taskId, updated: updated.length }, 'kb_author entry marked failed');
      }
    });
  } catch (err) {
    log.warn({ err, taskId, outcome }, 'kb_author entry reconcile on task end failed (skipped)');
  }
}
