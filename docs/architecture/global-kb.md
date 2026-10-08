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

The list says what it left out. It keeps the 40 newest matches from a 400-row scan, and past that
it ends with one line that is not a bullet, counting the rest ("at least N", or "possibly" when the
scan filled before it read them all) and saying `rag_search` still searches every one, because a
capped list that reads as complete is worse than none. Every title and category is collapsed onto
one line (`collapseToLine`), as step 11's article headers and title list are, so an
agent-authored title cannot open a line of its own; the isolation scan still reads the raw values,
and its verdict is the same for either.

**Each entry may carry a one-line description** — what the rule says and when it applies, like a
skill's frontmatter description — shown beside its title as `- title — description`, so a model
can judge relevance without fetching the body. `normalizeGlobalKbDescription` (`schema.ts`) is the
one rule for every writer and for the render: collapsed to one line, capped at 300 characters at a
word with an ellipsis, empty is null, and idempotent, so the isolation scan reads exactly the value
the render shows. A person's text over the cap is refused, never cut; a model's is cut. It is
written by the enrich task (a description the author stated wins over the model's), by the global
promotions in `08-knowledge-acquisition` and `11-phase-8-learning` (the project name scrubbed, and
08's repo-own backstop scanning it like the body). A promotion's title, body and description lose the
project's name to `example-app` as a whole token (letters and digits bound it; `_`, `-` and `/` do not),
and only when the name is the repository's own: a generic name, a public technology (`laravel`,
`drupal`, `redis`) or a value of the promotion's scope is left alone, since a repository named
laravel still writes articles about Laravel. A promoted investigation has no scope to tell its
subject from the project's name, so it is not scrubbed; the person scopes it before activating.
Activating a draft that supersedes an entry
archives that entry, so a draft that states no description of its own takes the entry's when it is
written, by the enrich task or a promotion, and `09_6_4` gives it again whether or not its merge
succeeded, never over one written since and never to a draft activated meanwhile. A promotion whose
body is identical to a same-topic entry's that lacks a description links to that entry directly,
with no embedding check, and `09_6_4` spends no merge agent on a pair whose bodies already match.
It is never embedded, so a description-only edit queues no re-embed. A person sees it wherever an
entry can be activated: on its card and in its dialog in Settings → Global KB, where Edit
description sets it, beside the existing entry's in a superseding draft's "Updates existing" view,
and in 09_6_5's draft list. The page renders it as markdown like every prose body; its editor and
the prompt carry the stored text.

Authoring and description editing show and enforce the 300-character limit before submission;
the description counter and validation measure the collapsed line through the browser-safe
`@haive/shared/collapse-line` export, exactly as the API does. Over-limit input stays available
to correct, with an inline error and disabled submit/save, rather than being cut by `maxLength`.
the title has the same limit, and the connection namespace allows 120 characters. The API refuses
over-limit person-authored text without cutting it. Notes, article bodies, scope values, allowed
domains, connection strings and embedding model/URL fields have no application character cap
(the entry table uses `TEXT`/`jsonb`, not length-limited columns). Connection settings validate
whole-number dimensions from 1 to 8192 and archive retention from 0 to 3650 days before saving.

Existing articles, including AI-written drafts and promoted replacements, offer **Edit body** in
the Settings detail dialog through the shared `MarkdownEditor` WYSIWYG editor. Save PATCHes the
markdown body and shows the returned stored entry; Cancel leaves it untouched, and a failed save
keeps the draft for retry. Body edits use the existing pending-embedding/sync path. An open scope,
description or body edit blocks activation, archiving and deletion until saved or cancelled.
The replacement diff is shown again after a body save, using the corrected text.

## House rules: admin-enforced entries

**Only an admin makes an entry an enforced house rule**, because enforcing will put its full text
into agent prompts as an instruction (PR6 of `docs/plans/abstract-splashing-owl.md`). The approval
binds exactly the text the admin saw: `PUT /global-kb/entries/:id/enforcement` takes the entry's
content token (`houseRuleContentToken`, `house-rules.ts`) and stores an approval hash over the same
canonical content plus the mode (`always`, or `files` with globs). Both are computed from STORED
values, so jsonb key order and the boot backfill's array order never change them. A PATCH that
changes the content clears the approval for good: a byte-for-byte revert does not revive it, which
would also let a rule return past the always cap it was no longer counted against. Leaving `active`
clears it through a trigger, which covers every writer, an older build sharing an external store
included; a content change by any writer other than PATCH shows as Lapsed · edited. The mode,
globs and approver stay as the last approval so a cleared or superseded entry can offer
Re-enforce.

Rule globs keep to a small grammar: literal characters, `*`, `**`, `?`, `[…]`, `/` and comma
alternatives in braces. picomatch reads `(`, `)` and `|` as alternation, `..` in any brace group as
a range and drops a `"`, each a way to match every file while seeming to name something, so all are
refused (`?app?` still names a directory such as Next.js's `(app)`). Every brace expansion, at most
64, must name something and keep the path rules a glob written out keeps: relative to the repository
root, with no empty, `.` or `..` segment (`{,src}/README.md` expands to `/README.md`). No brace
alternative may start or end with whitespace, which picomatch keeps: `{src, lib}` names ` lib` and
never matches `lib/`. MEASURED: before the grammar, 535 such wide globs of length 4 passed. The
check catches mistakes and is not a boundary: only an admin enforces, a deliberately broad glob
(`**/*.*`) is theirs to write, and what reaches a prompt is bounded by the per-prompt budget
(PR6), not by this check.
`enforcementState` reads none, superseded, cleared, not active, edited, other namespace, switched
off or enforced, first match winning, and the api attaches it to every entry it returns. Validity
comes first: "other namespace" and "switched off" are pauses that promise the rule resumes, so they
apply only to an approval that is otherwise valid. The enforce panel shows the title and description
as agents see them (collapsed onto one line) and the body as stored, since that is what is approved;
Enforce is offered only in the namespace in use, Un-enforce on any live approval.

An enforced entry needs a description and may not carry invisible or control characters or Haive
prompt delimiters. `always` rules share an 8,000-byte cap per namespace, counted in UTF-8 bytes of
the rendered entry (`houseRuleBytes`). Every writer of an entry takes the namespace's advisory
lock before the row's, with a 30 s wait limit answering 503: MEASURED, a DELETE racing the
activation of a draft that supersedes it deadlocked in 23 of 23 rounds before. The store settings
that could switch every rule off at once (Enabled, namespace, mode, connection string) are
admin-only. A non-admin's save never writes them: a re-sent value is accepted and skipped, so a
save that read the page before an admin's change cannot revert it. The house-rules switch lives in
the admin console, and an admin who points the KB at an external store trusts every writer of that
database: a row it marks enforced is honoured. The
enrich task refuses to re-enrich an enforced entry, since a retry would demote it.

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
