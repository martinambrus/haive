import { and, desc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import {
  globalKbEntries,
  globalKbTopicKey,
  resolveGlobalKbSettings,
  resolveTaskFacets,
  withGlobalKb,
  type GlobalKbCategory,
  type GlobalKbFacets,
  type ProjectFacetSet,
  normalizeFacets,
  normalizeGlobalKbDescription,
} from '@haive/shared/global-kb';
import {
  embedQueryOrNull,
  FACET_FILTER_DIMENSIONS,
  ragHybridSearch,
  type RagConnection,
} from '@haive/shared/rag';
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
  /** One line saying what the rule states and when it applies. Normalised when stored. */
  description?: string | null;
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

/** Public technology names, grouped as frameworks, CMSs, languages, runtimes, databases, servers. */
const PUBLIC_TECHNOLOGY_NAMES = new Set([
  'angular',
  'astro',
  'bootstrap',
  'cakephp',
  'codeigniter',
  'django',
  'electron',
  'ember',
  'ember.js',
  'express',
  'fastapi',
  'fastify',
  'flask',
  'flutter',
  'gatsby',
  'hono',
  'jquery',
  'laravel',
  'livewire',
  'nestjs',
  'next',
  'next.js',
  'nextjs',
  'nuxt',
  'phoenix',
  'preact',
  'quarkus',
  'rails',
  'react',
  'remix',
  'spring',
  'springboot',
  'svelte',
  'sveltekit',
  'symfony',
  'tailwind',
  'tailwindcss',
  'vue.js',
  'vuejs',

  'backdrop',
  'craftcms',
  'directus',
  'drupal',
  'drupal7',
  'ghost',
  'joomla',
  'magento',
  'opencart',
  'prestashop',
  'silverstripe',
  'statamic',
  'strapi',
  'typo3',
  'umbraco',
  'wagtail',
  'woocommerce',
  'wordpress',

  'clojure',
  'csharp',
  'dart',
  'elixir',
  'erlang',
  'fsharp',
  'golang',
  'groovy',
  'haskell',
  'java',
  'javascript',
  'julia',
  'kotlin',
  'ocaml',
  'perl',
  'python',
  'ruby',
  'rust',
  'scala',
  'swift',
  'typescript',

  'cpython',
  'deno',
  'docker',
  'dotnet',
  'node',
  'node.js',
  'nodejs',
  'openjdk',
  'pypy',

  'cassandra',
  'clickhouse',
  'cockroachdb',
  'couchbase',
  'couchdb',
  'duckdb',
  'dynamodb',
  'elasticsearch',
  'etcd',
  'influxdb',
  'mariadb',
  'memcached',
  'mongo',
  'mongodb',
  'mssql',
  'mysql',
  'neo4j',
  'opensearch',
  'oracle',
  'postgres',
  'postgresql',
  'redis',
  'solr',
  'sqlite',
  'sqlserver',
  'timescaledb',
  'valkey',

  'apache',
  'caddy',
  'dovecot',
  'envoy',
  'gunicorn',
  'haproxy',
  'httpd',
  'jetty',
  'lighttpd',
  'nginx',
  'openresty',
  'passenger',
  'php-fpm',
  'postfix',
  'puma',
  'tomcat',
  'traefik',
  'unicorn',
  'uvicorn',
  'uwsgi',
  'varnish',
  'wildfly',
]);

/** The scope values a promotion names, lowercased, a package's `@major` dropped too; free-text tags are not scope. */
function scopeTokens(facets: GlobalKbFacets | null | undefined): Set<string> {
  const tokens = new Set<string>();
  for (const dimension of FACET_FILTER_DIMENSIONS) {
    const values: unknown = (facets as Record<string, unknown> | null | undefined)?.[dimension];
    if (!Array.isArray(values)) continue;
    for (const value of values) {
      if (typeof value !== 'string') continue;
      const token = value.trim().toLowerCase();
      tokens.add(token);
      tokens.add(token.replace(/@[^@/]*$/, ''));
    }
  }
  return tokens;
}

/** Make a promoted article portable for ANY repo on the same stack: always strip
 *  the trailing `## Source files` footer (a repo file list), and when the project
 *  name is distinctive, remove it from the title and replace it (plus its `@name/`
 *  package scope) in the body with an obvious placeholder so a future reader knows
 *  to rename it. Only a whole token is replaced. A name that is generic (e.g. "app"), a
 *  public technology (e.g. "laravel") or a value in `facets` is not demonstrably the
 *  repository's own and is left untouched. Pure + deterministic; exported for unit testing. */
export function sanitizeGlobalArticle(input: {
  title: string;
  body: string;
  description?: string | null;
  projectName?: string | null;
  facets?: GlobalKbFacets | null;
}): { title: string; body: string; description: string | null } {
  // 1. Drop a trailing "## Source files" section regardless of the project name —
  //    a portable article must never list a specific repo's files.
  let body = input.body.replace(/\n#{1,6}[ \t]+source files\b[\s\S]*$/i, '').trimEnd() + '\n';
  let title = input.title;
  let description = input.description ?? null;

  const name = (input.projectName ?? '').trim();
  const lowerName = name.toLowerCase();
  if (
    name.length >= 4 &&
    !GENERIC_PROJECT_NAMES.has(lowerName) &&
    !PUBLIC_TECHNOLOGY_NAMES.has(lowerName) &&
    !scopeTokens(input.facets).has(lowerName)
  ) {
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const token = `(?<![\\p{L}\\p{N}])${esc}(?![\\p{L}\\p{N}])`;
    const nameRe = new RegExp(token, 'giu');
    // Body: `@name/...` scope and bare name -> placeholder.
    body = body.replace(nameRe, GLOBAL_PLACEHOLDER);
    description = description?.replace(nameRe, GLOBAL_PLACEHOLDER) ?? null;
    // Title: drop the name plus a leading/trailing connector ("for/in/of", "-", ":"),
    // then tidy. Keep the original if scrubbing would empty it.
    const scrubbed = title
      .replace(new RegExp(`\\s*(?:[-—–:]|\\b(?:for|in|of)\\b)\\s*${token}`, 'iu'), '')
      .replace(nameRe, '')
      .replace(/\s{2,}/g, ' ')
      .replace(/^[\s\-—–:]+|[\s\-—–:]+$/g, '')
      .trim();
    if (scrubbed) title = scrubbed;
  }
  return { title, body, description };
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
  /** The normalised description of each `otherTitles` entry, index for index; null where it
   *  has none. */
  otherDescriptions: Array<string | null>;
  /** Applicable articles that did not fit even the title list. Reported, not hidden. */
  omittedTitleCount: number;
}

export async function loadActiveGlobalArticlesForTask(
  db: Database,
  taskId: string,
  relevanceQuery = '',
  limit = 15,
): Promise<GlobalArticleSelection> {
  const empty: GlobalArticleSelection = {
    articles: [],
    otherTitles: [],
    otherDescriptions: [],
    omittedTitleCount: 0,
  };
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
          description: globalKbEntries.description,
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
      const rest = compatible.filter((r) => !ids.includes(r.id));
      const listed = rest.slice(0, OTHER_TITLE_LIMIT);
      return {
        articles,
        otherTitles: listed.map((r) => r.title),
        otherDescriptions: listed.map((r) => normalizeGlobalKbDescription(r.description)),
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
 *  Degrades in two stages, never to nothing. A query that cannot be embedded (no
 *  model configured, a failed or wrong-width embed) ranks on the LEXICAL half of the
 *  same fusion alone, since a hash vector is noise in the dense half. Only a
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
    const vec = await embedQueryOrNull(query, {
      ollamaUrl: settings.ollamaUrl,
      model: settings.embedModel,
      dimensions: settings.embeddingDimensions,
    });
    const hits = await ragHybridSearch(
      conn,
      vec ?? [],
      query,
      { topK: limit * CHUNKS_PER_ARTICLE_ALLOWANCE, lexicalOnly: vec === null },
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

/** The same-topic entry a promotion would add nothing to. An identical body still adds a description
 *  the entry lacks; a reworded one is not worth a draft, since a model rewords it every run. */
export function identicalPromotionTarget<T extends { body: string; description: string | null }>(
  candidates: T[],
  body: string,
  description: string | null,
): T | undefined {
  return candidates.find(
    (c) => c.body.trim() === body.trim() && (c.description !== null || description === null),
  );
}

/** An identical body is the same article: a copy adding a description links to it, no embedding. */
export function resolveIdenticalPromotion<T extends { body: string; description: string | null }>(
  candidates: T[],
  body: string,
  description: string | null,
): { kind: 'duplicate' | 'link'; target: T } | null {
  const duplicate = identicalPromotionTarget(candidates, body, description);
  if (duplicate) return { kind: 'duplicate', target: duplicate };
  const same = candidates.find((c) => c.body.trim() === body.trim());
  return same ? { kind: 'link', target: same } : null;
}

/** A draft's own description wins, else the replaced entry's, which activation archives. */
export function inheritDescription(
  own: string | null | undefined,
  replaced: string | null | undefined,
): string | null {
  return normalizeGlobalKbDescription(own) ?? normalizeGlobalKbDescription(replaced);
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
        description: promotion.description,
        projectName: promotion.projectName,
        facets: promotion.facets,
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
        let supersededDescription: string | null | undefined;
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
              description: globalKbEntries.description,
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
          const same = resolveIdenticalPromotion(
            candidates,
            clean.body,
            normalizeGlobalKbDescription(clean.description),
          );
          if (same?.kind === 'duplicate') {
            log.info(
              { topicKey: promotion.topicKey, existingId: same.target.id },
              'global KB promotion skipped (identical content already present)',
            );
            return { id: same.target.id, deduped: true, supersedesEntryId: null };
          }
          // Supersede an existing entry ONLY when its body is identical or embeddings confirm
          // it is the SAME article — the coarse topicKey (category:tech) groups unrelated
          // articles on one tech, so it can't decide identity. No confirmed match (or ollama
          // unavailable) -> insert an INDEPENDENT new draft; never clobber a different
          // article that merely shares the key.
          if (same) {
            supersedesEntryId = same.target.id;
            log.info(
              { topicKey: promotion.topicKey, supersedesEntryId },
              'global KB promotion linked to existing topic (identical body)',
            );
          } else if (candidates.length > 0) {
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
          supersededDescription = candidates.find((c) => c.id === supersedesEntryId)?.description;
        }
        const [row] = await tx
          .insert(globalKbEntries)
          .values({
            namespace: settings.namespace,
            userId: promotion.userId,
            title: clean.title,
            body: clean.body,
            category: promotion.category,
            // Normalised here rather than at each caller: this insert is the one place every
            // promotion funnels through, and `techAnchorFacets` assigns a detected package
            // VERBATIM while a project's own set is lowercased, so a capitalised package name
            // would be stored unmatchable by the exact jsonb `?|` the search uses.
            facets: normalizeFacets(promotion.facets),
            description: inheritDescription(clean.description, supersededDescription),
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

// `globalKbTopicKey` moved to @haive/shared: the api recomputes it when the scope editor
// changes an entry's category or facets, and cannot import the worker. Re-exported so every
// importer here is unchanged.
export { globalKbTopicKey };

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
