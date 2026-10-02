# Global knowledge base

The global KB is the instance's house standards: articles that hold across projects (a framework
rule, a datastore practice, an anti-pattern), each scoped to the stacks it applies to. It lives in
a SEPARATE database (`haive_kb_global` on the main host, or an external Postgres), whose tables are
created by raw idempotent SQL in `ensureGlobalKbSchema` (`@haive/shared/global-kb`), never by the
main database's migrations. `namespace` is a corpus key, not a user key. Entries are written by the
kb-author enrich task (Settings → Global KB), promoted as drafts by `08-knowledge-acquisition` and
`11-phase-8-learning`, and activated by a person.

**Agents reach it two ways, and neither is enforcement.** The global half of `rag_search` returns
article chunks, filtered by the project's facets; and `_global-kb-digest.ts` lists up to 40
matching TITLES on every dispatch that has `rag_search` wired, so an agent knows what exists. A
body is read only if the agent chooses to search for it. MEASURED since the title list shipped
(2026-08-16): claude-code called `rag_search` at all in 24.5% of its rag-wired runs, ollama in 0
of 125.

## Facets

An entry's facets RESTRICT: each dimension it names must overlap the project's values, and a
dimension it leaves empty applies to every project. Both comparers — `facetsMatchProject` in JS
for the title list, and `buildFacetClause`'s jsonb `?|` for retrieval — read the project's set from
ONE function, `extractProjectFacets` (`facets.ts`), so the list never advertises a title the search
then filters out.

**The write side and the match side are kept apart on purpose.** `FACET_VALUE_ALIASES` and
`normalizeFacets` (`schema.ts`) canonicalise what is STORED, and the schema ensure's backfill
rewrites stored rows through the same rule, so an alias there changes every existing entry's
scope. A framework FAMILY widens only what a project MATCHES: `PROJECT_FRAMEWORK_FAMILIES`
(`facets.ts`) adds `drupal` beside a project's `drupal7`, and the major `7` the token implies, so a
project a person corrected to Drupal 7 at the confirmation form matches a `drupal` + `7` entry too
(the detected major is kept only while the confirmed framework is the detected one). `01-env-detect` reports a Drupal 7 site
as `drupal7` (and 8+ as `drupal`), so before the family a D7 project matched no `framework: drupal`
entry at all — MEASURED, the user's own "no inline svgs" rule reached none of the 8 Drupal repos on
the dev install, all of them D7. The family never joins the alias table, which would rewrite stored
`drupal7` scopes and widen D7-only entries to 8+.

So `drupal` with no major covers every Drupal major, 7 included, and a rule that does not hold on 7
lists the majors it does hold on. A major needs its parent dimension beside it
(`FACET_MAJOR_PARENTS`): `frameworkMajor` alone would match every framework's major of that number,
so `normalizeFacets` drops an orphan major and the api refuses one.

Facet lookups go through `Object.hasOwn`: `databaseType` is free text on the detection
confirmation form, and a plain index once returned the `Object` function for `constructor`.
