import { pgTable, uuid, text, jsonb, timestamp } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/postgres-js';
import type postgres from 'postgres';

// Global cross-task KB schema. Lives in a SEPARATE database (internal
// haive_kb_global or an external/central Postgres), NOT the main Haive DB, so it
// is intentionally NOT exported from @haive/database/schema — drizzle-kit must
// never try to migrate it onto DATABASE_URL. Tables are created by raw idempotent
// SQL (ensureGlobalKbSchema); this Drizzle object exists only for typed CRUD over
// global_kb_entries. The global vector table (ai_rag_embeddings) is written via
// raw SQL by the sync job, mirroring the per-project store, so it needs no Drizzle
// definition here. See plan luminous-weaving-archive.md §4.1/§4.2.

/** Version/variant scope facets. Each dimension is a SET of allowed values; an
 *  empty/absent dimension means "applies to all" for that dimension (§3.1). */
export interface GlobalKbFacets {
  framework?: string[];
  /** Major version of the framework, e.g. ["11"] for Drupal 11 — distinguishes
   *  same-family majors that `framework` alone cannot (Drupal 11 vs 12). */
  frameworkMajor?: string[];
  language?: string[];
  phpMajor?: string[];
  nodeMajor?: string[];
  /** Datastore engine, e.g. ["mysql"], ["mariadb"], ["postgres"]. */
  database?: string[];
  /** Datastore major version, e.g. ["10"] for MariaDB 10.x, ["8"] for MySQL 8. */
  dbMajor?: string[];
  packages?: string[];
  tags?: string[];
}

/** Every dimension an ENTRY may carry, in the order the UI shows them.
 *
 *  Deliberately NOT the same list as `FACET_FILTER_DIMENSIONS`, which is what RESTRICTS
 *  retrieval. `tags` is the one dimension with no project-side source — `extractProjectFacets`
 *  derives a project's facets from its detected stack and never sets tags — so filtering on it
 *  can only ever exclude. MEASURED on a real entry: an article scoped
 *  `{framework:['drupal'], language:['php'], tags:[...10 topical labels]}` passed the framework
 *  and language clauses and was rejected by the tags clause alone, making it unreachable from
 *  every project. Keep the two lists apart unless projects gain real tags. */
export const FACET_DIMENSIONS = [
  'framework',
  'frameworkMajor',
  'language',
  'phpMajor',
  'nodeMajor',
  'database',
  'dbMajor',
  'packages',
  'tags',
] as const satisfies readonly (keyof GlobalKbFacets)[];

/** Facet values as they must be STORED: trimmed, lowercased, deduped, empties dropped.
 *
 *  The two filters compare differently and only one of them can be made lenient.
 *  `facetsMatchProject` lowercases both sides in JS, while `buildFacetClause` uses jsonb `?|`,
 *  which is exact — MEASURED, `'{"framework":["Drupal"]}'::jsonb->'framework' ?| array['drupal']`
 *  is FALSE. A project's own set is already lowercased by `extractProjectFacets`, so an entry
 *  stored as `Drupal` would be advertised by the digest and then filtered out of the very
 *  `rag_search` the digest promises to agree with. Making the SQL lenient instead would mean
 *  unnesting the array and losing the GIN index, so the normalisation belongs on the WRITE.
 *
 *  Applied wherever an entry's facets are written: the enrich request's author-stated scope,
 *  the scope editor's PATCH, and the model's own answer. */
/** Spellings that are not the token a PROJECT reports, per dimension.
 *
 *  An entry's facets and a project's are compared for OVERLAP, so a dimension whose two sides
 *  spell one technology differently restricts that entry to nothing. `01-env-detect.ts`
 *  canonicalises PostgreSQL to `postgres` — both its `DB_NAME_TO_TYPE` table and the container
 *  scan's `/\b(postgres|postgresql)\b/` yield that token — and `extractProjectFacets` only
 *  lowercases what the detector produced. So an entry stored as `postgresql` was silently
 *  unreachable from every PostgreSQL project, which is the failure this normalisation exists to
 *  prevent, one layer up: `Drupal` vs `drupal` is a CASE mismatch, this is a VOCABULARY one.
 *
 *  Deliberately tiny and grounded: only a spelling the detector itself maps away belongs here,
 *  never a guess at what someone might type. Adding one is a claim about the detector's output
 *  and has to be read out of that file.
 */
const FACET_VALUE_ALIASES: Partial<Record<keyof GlobalKbFacets, Record<string, string>>> = {
  database: { postgresql: 'postgres' },
};

/** The alias pairs as a flat list, for the migration that has to recognise a topic-key segment
 *  written BEFORE canonicalisation. Exported instead of the map so nothing can mutate the table
 *  through it, and derived from the same table so the two cannot drift. */
export const FACET_VALUE_ALIAS_PAIRS: ReadonlyArray<{
  dimension: string;
  from: string;
  to: string;
}> = Object.entries(FACET_VALUE_ALIASES).flatMap(([dimension, table]) =>
  Object.entries(table ?? {}).map(([from, to]) => ({ dimension, from, to })),
);

/** Trim, lowercase, and fold a known vocabulary alias — the ONE rule BOTH sides of a facet
 *  comparison have to apply.
 *
 *  Exported because `extractProjectFacets` must reach the identical answer: the confirmation
 *  form's `databaseType` is a free-TEXT field (`02-detection-confirmation.ts`, placeholder
 *  "postgres, mysql, mariadb..."), so a person can legitimately confirm `postgresql` and the
 *  project side would then carry a token no canonicalised entry can overlap. Normalising only
 *  the entry side trades one silent mismatch for another. */
export function canonicalizeFacetValue(dimension: string, value: string): string {
  const v = value.trim().toLowerCase();
  return FACET_VALUE_ALIASES[dimension as keyof GlobalKbFacets]?.[v] ?? v;
}

/** The SAME value rule as SQL, built from the SAME alias table, so a backfill cannot disagree
 *  with the write path about what a facet value is.
 *
 *  This is the shape `identifierTsvSql` established for the identifier pattern: one definition,
 *  two engines, rather than a JS rule and a hand-written SQL copy that drift. The copy is what
 *  drifted here — the backfill lowercased and did neither the trim nor the alias, so a legacy
 *  `PostgreSQL` was rewritten to `postgresql` and made unreachable, an already-lowercase
 *  `postgresql` was never even selected, and a padded ` drupal ` matched neither the predicate
 *  (`lower(v)` equals it) nor `?|` (which does not trim).
 *
 *  `keyExpr` names the dimension and `valueExpr` the raw stored text; both are SQL expressions.
 *  Only code constants are interpolated, never a stored value. */
export function canonicalFacetValueSql(keyExpr: string, valueExpr: string): string {
  const base = `lower(btrim(${valueExpr}))`;
  const whens = Object.entries(FACET_VALUE_ALIASES).flatMap(([dim, table]) =>
    Object.entries(table ?? {}).map(
      ([from, to]) => `WHEN ${keyExpr} = '${dim}' AND ${base} = '${from}' THEN '${to}'`,
    ),
  );
  return whens.length === 0 ? base : `CASE ${whens.join(' ')} ELSE ${base} END`;
}

export function normalizeFacets(facets: GlobalKbFacets | null | undefined): GlobalKbFacets {
  const out: GlobalKbFacets = {};
  for (const dim of FACET_DIMENSIONS) {
    const values = facets?.[dim];
    if (!Array.isArray(values)) continue;
    // Aliasing happens INSIDE the Set, so two spellings of one technology collapse to one value
    // rather than being stored as two.
    const cleaned = [
      ...new Set(
        values
          .filter((v): v is string => typeof v === 'string')
          .map((v) => canonicalizeFacetValue(dim, v))
          .filter(Boolean),
      ),
    ];
    if (cleaned.length > 0) out[dim] = cleaned;
  }
  return out;
}

export type GlobalKbCategory =
  'general' | 'tech_pattern' | 'anti_pattern' | 'best_practice' | 'quick_reference';

export type GlobalKbStatus = 'skeleton' | 'enriching' | 'draft' | 'active' | 'archived' | 'failed';

export type GlobalKbSource = 'user' | 'promoted';

export type GlobalKbEmbedStatus = 'pending' | 'embedded' | 'failed' | 'stale';

/** Routing decision at the orchestration gate (§5.4). Not a column on entries —
 *  a `global`/`both` choice produces a global_kb_entries row; `local` does not. */
export type GlobalKbScope = 'local' | 'global' | 'both';

export const globalKbEntries = pgTable('global_kb_entries', {
  id: uuid('id').primaryKey().defaultRandom(),
  // Corpus scope key (instance config), NOT a cross-DB user FK. Default 'default'
  // is a single shared corpus; one central server may host several namespaces.
  namespace: text('namespace').notNull(),
  // Opaque provenance only (no FK — different database). Null for some promotions.
  userId: uuid('user_id'),
  title: text('title').notNull(),
  // Raw skeleton the user pasted; null for fully-manual or promoted entries.
  seedText: text('seed_text'),
  // Markdown source of truth (enriched or hand-written).
  body: text('body').notNull(),
  category: text('category').$type<GlobalKbCategory>().notNull(),
  facets: jsonb('facets').$type<GlobalKbFacets>().notNull().default({}),
  status: text('status').$type<GlobalKbStatus>().notNull(),
  source: text('source').$type<GlobalKbSource>().notNull(),
  // Provenance for promotions; plain uuids, no FK (different database).
  sourceTaskId: uuid('source_task_id'),
  sourceRepoId: uuid('source_repo_id'),
  // sha256 of body+facets; drives re-embed when content changes.
  contentHash: text('content_hash'),
  // Cross-repo dedup key (category:tech); null when no tech is derivable.
  topicKey: text('topic_key'),
  // When set, this DRAFT is a proposed merge/enrichment of the entry with this id
  // (same topicKey). A merge step fills its body from both; on activation it
  // supersedes that entry. Plain uuid, no FK (provenance only, like sourceTaskId).
  supersedesEntryId: uuid('supersedes_entry_id'),
  embedStatus: text('embed_status').$type<GlobalKbEmbedStatus>().notNull().default('pending'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  // Soft-delete, matches repo conventions.
  supersededAt: timestamp('superseded_at'),
});

export type GlobalKbEntry = typeof globalKbEntries.$inferSelect;
export type NewGlobalKbEntry = typeof globalKbEntries.$inferInsert;

export const globalKbSchema = { globalKbEntries };

/** Wrap a postgres.js client bound to the global DB connection in a typed Drizzle
 *  client. Schema creation happens out-of-band via ensureGlobalKbSchema. */
export function createGlobalKbDb(pg: postgres.Sql) {
  return drizzle(pg, { schema: globalKbSchema });
}

export type GlobalKbDb = ReturnType<typeof createGlobalKbDb>;

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
  rawFacets: GlobalKbFacets,
  fallbackTech?: string | null,
): string | null {
  // Derived from the CANONICAL facets, because the entry is STORED canonical — every write path
  // runs `normalizeFacets` — so a key built from the raw values describes a scoping no row has.
  // `norm` lowercases, which hides a case difference but not a VOCABULARY one — a promotion
  // carrying `database: ["postgresql"]` keyed on `postgresql` and stored `postgres`, so the
  // exact topic-key lookup missed the earlier entry and wrote a duplicate draft instead of
  // superseding it. Both call sites pass this same object as the promotion's `facets`, so
  // normalising here makes the key and the row agree by construction.
  const facets = normalizeFacets(rawFacets);
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
