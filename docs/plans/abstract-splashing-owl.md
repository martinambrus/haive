# Enforced house rules from the global KB, plus three found-not-fixed fixes

> **In progress**, approved 2026-10-03. Shipped: PR1 (#398: the Drupal 7 facet family with the major
> the token implies, plus an inherited-key guard on the facet alias lookup), PR2 (#399: the title list
> states its omission), PR3 (#402), PR4 (#400: descriptions, backend and web) and PR5 (#432,
> 2026-10-08). PR6 is in review; PR7 and PR8 follow. Line numbers are as of writing; resolve by symbol.

## Context

Global KB entries are the instance's house standards (coding rules, "no inline svgs", DB practice),
scoped to a stack by facets. Today an agent sees their TITLES only (`_global-kb-digest.ts`, up to
40, rag-wired dispatches only) and has to call `rag_search` to read one. Nothing makes it read one,
and nothing checks the change against one. MEASURED since the title digest shipped (2026-08-16):
claude-code called `rag_search` at all in 24.5% of rag-wired runs (0.35 calls/run, 0.33 before the
digest), ollama in 0 of 125, codex in ~36% of its runs. A Drupal 7 site also matches no
`framework: drupal` entry, because the detector reports it as `drupal7`: the user's own "no inline
svgs" rule reaches none of the 8 Drupal repos on the dev install (all D7).

Outcome:
- every entry is listed skills-style (title plus a one-line description);
- an ENFORCED entry's full text reaches the writing agents when Haive (never the model) sees that the
  work touches its scope;
- the 07b validator blocks on a violation in lines the change wrote;
- three verified found-not-fixed defects in the same area are fixed first.

Decided by the user on 2026-10-03:
- Haive decides what is loaded.
- Triggers are both: file globs decide what 07b enforces, and similarity adds likely rules to writer
  runs. Similarity starts record-only until its threshold is measured.
- Rules go to the writers plus the 07b check.
- A violation blocks.
- A rule marked "always" is refused once the always group would pass a byte cap.
- Only admins enforce or un-enforce; everything else in the global KB stays open to any signed-in
  user.

## Invariants

1. **The text injected is exactly what an admin approved.**
   - Approval stores a versioned hash of a canonical form of the entry.
   - Any later edit lapses enforcement, and so does leaving `active`.
   - Nothing has to remember to clear a flag.
2. **Haive, not the model, chooses which enforced rules a dispatch gets:**
   - `always` rules go to every opted dispatch;
   - `files` rules go only when a glob matches the dispatch's known file set;
   - similarity rules are injected only once their floor is measured.
3. **Only a (step, role) listed in `HOUSE_RULE_ROLES` gets rules.** Every file-writing step is either
   in that table or exempt with a stated reason, and a ratchet test keeps it that way.
4. **07b enforces on lines the change wrote.**
   - A violation elsewhere is reported, never fixed.
   - If the approved spec explicitly requires something a rule forbids, the conflict goes to the
     person at gate 2 and never into a loop.
5. **Switching rules off, or a step that is not opted in, gives a byte-identical prompt.**
6. **Each opted run records what it got** (`cli_invocations.house_rules`). Gate 2 reads that column,
   never message copy.
7. **Facet families widen only what a project MATCHES.** A stored scope is never rewritten.
8. **Every capped block says what it left out.**
9. **Lint blocks only on what the change wrote, wherever Haive can read the linter's findings.**
   Anywhere else it behaves as today and says it ran unscoped.

## Work units (one PR each, in this order)

### PR1. Drupal 7 also matches `framework: drupal` (found-not-fixed #1)
- **Mapping.** In `packages/shared/src/global-kb/facets.ts`, add a local
  `PROJECT_FRAMEWORK_FAMILIES = { drupal7: ['drupal'] }` and apply it in `extractProjectFacets` after
  canonicalisation, with dedupe.
- **Not in `FACET_VALUE_ALIASES`** (`schema.ts`). That table also feeds `normalizeFacets` on every
  write, plus `canonicalFacetValueSql` and the boot backfill, so putting the mapping there would
  rewrite every stored `drupal7` and widen D7-only entries to 8+.
- **Every consumer only matches.** Verified: the digest, `guidance-context`, the promote loaders, and
  the api rag route through `buildFacetClause`. Topic keys use write-side facets.
- **Enrich prompt** (`kb-author/01-enrich.ts`), one added line: "`drupal` with no major covers every
  major, 7 included; a rule that does not hold on 7 lists the majors it does hold on." The scope help
  in `page.tsx` already promises this.
- **PR body: who newly sees D7 entries.** List active entries and `step_guidance` rows whose framework
  holds `drupal` and that name no major. Today that is "no inline svgs" (its body says it holds across
  framework generations), draft `1f6f5558`, and no guidance rows.
- **Tests:**
  - update the two `['drupal7']` assertions in `global-kb-facets.test.ts`;
  - a D10 project is unchanged;
  - a confirmed `Drupal7` gives `[drupal7, drupal]`;
  - `normalizeFacets` and the alias SQL leave `drupal7` alone;
  - the four measured matcher cases run through the real extractor;
  - the captured SQL parameter is `{drupal7,drupal}`.
- **Undo:** revert. Nothing is stored.

### PR2. The title list says what it left out (found-not-fixed #3)
- **`_global-kb-digest.ts`:**
  - A pure `selectDigest` returns `{entries, omitted, scanSaturated}`.
  - The notice sits inside the block, before the closing marker. It is not a bullet, and it says the
    rest are still reachable through `rag_search`.
  - Titles are collapsed to one line. Today they are interpolated raw; this is a pre-existing gap.
- **Count wording:** a new `step-engine/omission-count.ts`, shared with `guidance-context.ts`, whose
  output must stay byte-identical. Importing from guidance-context would create a cycle.
- **Dispatcher:** `DispatchRequest.globalKbDigest` becomes the object, and the isolation scan reads
  `.entries`.
- **Tests:**
  - 45 matches give 40 shown and 5 omitted;
  - a saturated scan reads "at least" / "possibly";
  - the notice is inside the block;
  - the block stays idempotent;
  - fixture updates in `dispatcher.test.ts` and `agent-isolation-rule.test.ts`, plus a RENDERS case in
    `prompt-agent-paths.test.ts`.

### PR3. Lint blocks only on lines the change wrote (found-not-fixed #2)
- **Scope of the change.** phpcs keeps its own file scope; only the verdict is scoped. This applies
  only to the direct `phpcs` runner, where Haive builds the argv. Composer and package.json lint
  scripts are unchanged, and their output says the verdict is unscoped.
- **`_impl-changes.ts`:**
  - Add an uncapped numeric hunk parser beside the capped display strings, which stay byte-identical.
  - Add `collectChangedLineMap(ctx, worktree)`: the union of the merge-base diff, untracked files,
    dirty files and agent-reported files.
  - The prompt caps (20 ranges per file, 100 files) must never decide a verdict. In DAG mode the tree
    is clean, so files that appear only in the diff count.
- **New `_lint-scope.ts`:** report flags, a parser for phpcs's JSON report, the scoper, and a blocking
  list of at most 2000 chars made of whole lines, with the rest counted.
- **`08-phase-5-verify.ts`, in apply** (detect output is persisted and replayed, so not there):
  - Create `.haive/verify/` and make it writable by the DDEV user, the way `_screenshots.ts` does.
    `.haive/` is excluded from staging by 01-worktree-setup.
  - Run with `--report=full` first, then `--report-json=<random name>`, plus `--basepath`.
  - Only fixed-charset flags go on the command line, because `ddevExec` runs `bash -lc`.
  - Read the report through fs-safe and delete it in a `finally`.
- **The verdict:**
  - Exit 0 passes. Exit codes are never read further: 3.x and 4.x differ.
  - Otherwise, any ERROR or WARNING on a changed line blocks. A new or unmeasured file counts whole;
    `Internal.*` counts its whole file.
  - The rest is counted as pre-existing and reported.
  - A missing, unreadable or empty report gives today's verdict plus an "unscoped" note.
  - Exit 127 (no `vendor/bin/phpcs`; D7 has no composer.json) counts as not run, with a note, and
    never costs a fix round.
- **What other code sees:**
  - `fixLoop.evaluate` gets the blocking list plus "N others predate this change — do not edit code to
    clear them".
  - The ledger fact gains a third state.
  - Gate 2's `liteCheck` passes `scope` through, showing a warn row on a scoped pass that still has
    pre-existing violations. Old payloads render as before.
- **Tests:**
  - `_impl-changes`: display strings identical; 25 hunks give 25 ranges; the deletion junction;
    untracked files; a DAG file found only in the diff.
  - `_lint-scope`: flag order and charset; basepath for DDEV and host; 3.x and 4.x report samples;
    truncated and malformed reports; the full decision table.
  - 08 through IO seams: scoped pass and fail; absent report; script argv unchanged; old outputs.
  - Gate 2: the warn row.
- **Docs:** `fix-loop.md` and `review-scope.md`.

### PR4. Descriptions: the skills-style list
- **Storage:** a `description text` column in the global KB database (`ensure-schema.ts`,
  `ADD COLUMN IF NOT EXISTS`). One line, at most 300 chars, collapsed on write.
- **Who writes it:**
  - kb-author enrich returns it beside the title, category and facets;
  - the global entries promoted in `08-knowledge-acquisition` and `11-phase-8-learning` carry one;
  - `09_6_4` keeps it through a merge;
  - `PATCH` accepts it, and the dialog shows and edits it.
- **The list:** a digest line becomes `title — description`. Without a description it stays title
  only, which is the case for today's 10 entries until someone adds one. The isolation scan covers
  descriptions.
- **Tests:** DDL, update schema, enrich parse, rendering and collapsing, and the isolation case.

### PR5. Enforcement: storage, API, UI (admin-only)
- **Columns:** `enforce jsonb` (`{mode:'always'}` or `{mode:'files', globs}`), `enforced_hash`,
  `enforced_at`, `enforced_by`, and a partial index on namespace.
- **New `shared/src/global-kb/house-rules.ts`:**
  - **The hash:** version prefix plus sha256 of a canonical array covering title, category,
    description, body, the scope facets (`FACET_FILTER_DIMENSIONS` as sorted, unique, normalised
    values, tags excluded) and enforce mode plus sorted globs.
    - Never `JSON.stringify(row.facets)`: jsonb reorders keys and the boot backfill reorders arrays.
    - Pinned by a golden-value test.
  - `enforcementState`: enforced, or lapsed because the entry was edited, is not active, was
    superseded, is in another namespace, or enforcement is switched off.
  - **Refused text:** C0/C1 control characters (other than newline and tab), zero-width and bidi
    characters, and Haive markers.
  - **Glob shape check:** relative, no `..`, no leading `!`, bounded. picomatch stays in the worker.
- **`PUT`/`DELETE /global-kb/entries/:id/enforcement`**, `requireAdmin` on the route (no field
  gate inside a route non-admins share):
  - Every writer of an entry (PATCH, DELETE, both enforcement routes) takes the namespace advisory
    lock first and the row lock second, with a 30 s `lock_timeout` answering 503, so enforcing,
    reactivating, deleting and superseding cannot deadlock.
  - `expectedHash` is the entry's content token (title, category, description, body and scope,
    no enforce part), which every returned entry carries; the server computes the approval hash
    itself, since the browser has no canonical form and no `crypto.subtle` off localhost.
  - 409 for an entry that is not active, belongs to another namespace, or whose token differs (the
    admin enforces what they saw), and when the always-cap is exceeded. The cap is counted in UTF-8
    bytes of the rendered entry and the response gives the numbers.
  - 400 for refused text, bad globs, or a missing description.
  - Clearing: a trigger nulls `enforced_hash` whenever an active row leaves `active` (any writer,
    an older build on a shared store included), and a PATCH that changes the content token nulls it
    in code (not the trigger, which would see the backfill's reordered facets as an edit), so a
    revert never revives an approval nor slips a rule back past the always cap. `enforce` and at/by
    stay as the last approved settings, so a cleared or superseded entry can offer Re-enforce.
    Un-enforce nulls the hash only.
  - An enforce-only change bumps nothing and queues no re-embed; a PATCH re-embeds only when the
    title or body changed or the entry becomes active.
- **Enrich step:** `01-enrich` refuses to re-enrich an enforced entry; a Retry would demote it and a
  Cancel would delete it.
- **Config:** `GLOBAL_KB_HOUSE_RULES_ENABLED`, seeded true, switched at `/admin/config/house-rules`
  beside the agent-rules switch (the global KB config route is open to every user). One resolver
  reads `GLOBAL_KB_ENABLED`, whose four readers defaulted differently. Decided by the user on
  2026-10-03: the store's Enabled switch, namespace, mode and connection string become admin-only
  (a non-admin's CHANGE is a 403; each could switch every rule off), and approvals are trusted from
  whatever store an admin points the KB at (no per-install signing).
- **UI:**
  - Enforce panel: the raw source, fenced; mode; globs; always-usage meter.
  - Badges: Enforced·always, Enforced·files, Lapsed with its reason. "Superseded" names the successor
    and offers Re-enforce. "Paused" for switched off or another namespace, which come back on their
    own.
  - Warnings on Edit scope, Archive, and on activating a superseding draft.
  - PR5 and PR6 merge in one session with no release tag between them, so "Enforced" never does
    nothing in a release.
- **Tests:**
  - hash: golden value; invariant to key order, array order and tags; changes with every other field;
  - refused texts and the glob shape check;
  - the API gate and each 409 and 400;
  - reactivation does not restore enforcement;
  - an enforce-only change does not sync;
  - a race smoke modelled on `first-admin-race-smoke.ts`: two concurrent enforces give one 409, and
    enforcing against reactivating does not deadlock.

### PR6. Dispatch: who gets which rule, the 07b check, the per-run record (migration 0176)
The topic file `docs/architecture/global-kb.md` ("House rules in prompts") holds the shipped detail;
this section keeps the decisions.
- **Roles table.** `HOUSE_RULE_ROLES` sits in `shared/src/step-engine/types.ts` beside
  `STEP_CLI_ROLES`.
  - **write:** 04, the 05 corrector, 05a, 06b (sprint planning writes like 04), the 06c coder (level
    coder and fix coder, both role `coder`), 07, 07a (simplifier and fixup), the 07b fixer, the 08a
    fixer, 08b and 08e. retry_ai takes the mode of the pass it repairs; an exempt one gets none.
  - **review:** the 07b validator.
  - **Exempt, with reasons** (`HOUSE_RULE_EXEMPT`): merge fixers (00a, 12, 13, the 06c level
    merge), plan merge, 09_5/09_5b/11d, the KB author, the 06c reviewer, issue advisor and
    replanner, and the 08a tester (its scripts verify the change and are not part of it). The 06c
    reviewer not seeing the rules is a recorded risk; 07b checks the merged change.
  - A ratchet keeps every `file_write` (step, role) in one table or the other, and a source guard
    makes every `resolveTaskDispatch` call pass `houseRulesFor(...)` or a named
    `houseRulesOptOut(reason)`, since the ratchet cannot see hard-coded capability arrays. Mining
    dispatches are opted out.
- **Resolver.** One bounded read per dispatch, `resolveGlobalKbContext`, returns the title list, the
  enforced candidates from a query of their own and a status (ok, disabled, unavailable); it never
  rejects. A 3 s connect, a 3 s statement timeout and a 6 s deadline, because a half-open external
  store stalled each dispatch 30 s (MEASURED). A failure is recorded by error class, never its
  message (it names the admin-only host). Rows are re-vetted: an external store's approvals are
  trusted unsigned.
- **Selection** (pure): `always` rules are in; a `files` rule is in when a glob matches the change
  (gate 3's `git status -z` plus the branch against its fork point, since a DAG tree is clean at 07b)
  or a DAG issue's `estimated_files`; a slashless glob matches a name at any depth; an unreadable
  change puts every `files` rule in unscoped; deleted paths and a rename's source count as changed.
  The budget is 16,384 bytes per prompt: `always` rules are kept first, oldest approval first (a set
  within the api's cap always fits), then written-file matches before estimate-only ones and smaller
  before larger, and what is left out is named in the block and the stamp.
- **Injection** (`orchestrator/house-rules.ts`): directly under the agent-rules block, not gated on
  rag, unfenced; replaced only at position 0 (`stripHaivePreamble` for replays, the isolation scan
  and persona bookkeeping). Each entry renders as `### Rule <id8>: <title>`, a `Category:` line (never
  a title prefix: "Anti-pattern — avoid: no inline svgs" read as its opposite), the description, the
  scope line and the approved body; the closing marker is escaped.
- **Framings.** Write: follow the rules on the lines you write; untouched breaches go to similar
  sites; a review finding or a check's diagnosis never licenses a breach; only the approved spec or a
  person's directive (a fix a person directs included) can require one, then follow it and report
  the conflict; a spec never restates the rules. Review: check every written line, a `files` rule
  only on files its globs match; a violation is a `high` issue with `file: "path:line"` and `rule`;
  debt and a check's diagnosis or honored constraint never waive a rule (a person's counts as a
  directive); spec- or person-required violations go to a structured `rule_conflicts`, never to the
  issues or the cut report.
- **07b.** Parses `rule` and `rule_conflicts` tolerantly, stores `ruleConflicts` and the validator's
  own `validatorInvocationId` (a fixer pass carries both). Haive raises an issue naming a rule of
  the pass's own stamp to `high`, and a VALID pass with one to ISSUES_FOUND, so a violation blocks
  through the fixer and the fix loop.
- **Isolation, prompt size, record.** Injected text is external text for agent isolation. A prompt
  too large for an argv-only CLI drops the house block first, then the agent rules; since gemini
  reads stdin this is a guard. The stamp `{mode, entries:[{id, hash, title, why}], omitted:[{id,
  hash, title, why}], reason?, errorClass?}` goes to `cli_invocations.house_rules` (migration 0176;
  0173 was taken) through the `started_at` UPDATE; NULL means not opted in. One
  `house_rules.unavailable` event per task, under an advisory lock.
- **The gates.** Gate 2's "House rules" row is read from the stamp of the invocation 07b's output
  names: CONFLICT, VIOLATED, NOT CHECKED, OFF, PARTIAL or ENFORCED, and all but OFF and ENFORCED
  hold Approve off its default. `quick_bugfix` runs no gate 2, so gate 3 shows the row when no
  gate-2 output exists, the rule similar sites and insights already follow.
- **Late writers (user, 2026-10-09).** 08b and the 08a fixer write after 07b. 08c's peer reviewer
  gets the review framing (a findings wording) and re-checks them: a finding naming a stamped rule
  is raised to high, skips the refuter and blocks through the fix loop; gate 2 merges both checks,
  its state from 08c. 08e runs after 08c and quick_bugfix runs no 08c, so every check also records
  a fingerprint of the change it checked, and a gate that finds the change moved since the last
  check (with rules in play) shows PARTIAL and holds Approve.
- **Panel.** The enforce panel prints the rule through the same render (a browser-safe subpath) for
  the mode and globs being drafted.
- **Tests** follow this list: both framings and byte identity when off, not opted or out of scope
  (also against main's prompts in the harness); block order; replays; a quoted marker; the ladder;
  isolation; the bounded read on a socket that never answers; the budget order and notice;
  slashless globs; an unreadable change; retry_ai; the source guard; the once-only event; 07b's
  parse, carry and backstop; the row table and both gates.

### PR7. Similarity for writers, record-only
- **Scoring.** For each write-mode dispatch, every enforced `files` rule not already selected gets a
  score: the best dense similarity between a task query (title, description, the spec's opening) and
  that rule's vectors in the global `ai_rag_embeddings` (`entry_id`). It uses the same model and store
  as the global half of `rag_search`.
- **Record only.** Each `{id, score}` goes into the stamp, and nothing is injected.
- **Config:** `GLOBAL_KB_HOUSE_RULES_SIMILARITY` is off, record or on, seeded to record.
- **Measurement checkpoint** (a row in `onboarding_run_checkpoints`): grade at least 10 real recorded
  dispatches and choose the floor from that. PR8 sets the floor and switches it on.
- **Tests:** the scorer; off and record leave the prompt unchanged; an embed failure records nothing
  and never fails a dispatch.

## Reuse
- `withAgentRules`, `agentRulesOf` and the handlers' `started_at` stamp path: the pattern for the
  block, the stamp and the kill switch.
- `STEP_CLI_ROLES` / `cliRoles`: the pattern for the roles table.
- `collectImplementationFiles` / `_impl-changes.ts`: changed files and line ranges.
- picomatch with `dot: true`, as in `secret-mask-policy.ts`.
- From `@haive/shared/fs-safe`: `ensureDirNoFollow`, `ensureSandboxWritableTree`, `readTextNoFollow`.
- `guidanceOmissionNotice` wording.
- `facetsMatchProject` / `buildFacetClause`.
- `embedQueryOrNull` and the global half of `rag_search`.
- `requireAdmin`.
- The `first-admin-race-smoke.ts` shape for the race smoke.

## Verification (run by me before calling each PR done)
- **Every PR:** its unit tests, `pnpm typecheck` (the package script), and the full worker suite.
- **PR1:** the real matcher on elmont_rs_test's facets lists "no inline svgs".
- **PR3:** a zero-token probe, `packages/worker/test/lint-scope-probe.ts` (not in CI):
  - On a `git clone --local` copy of `/home/activit/elmont_rs`, install drupal/coder outside the
    clone, add a minimal ruleset, append a violation to one file and add a new file containing one.
  - Assert in host mode: both new violations block, pre-existing ones are counted and do not block,
    the report file is removed, and with `.haive/verify` at 0555 the run falls back.
  - Repeat in `ddev/ddev-webserver` as uid 1000.
- **PR5:** a browser check through Chrome MCP of enforce, lapse and re-enforce, at phone and tablet
  widths too.
- **PR6:** the zero-token harness `.claude/tmp/house-rules/t6/harness/` (H1-H14) drives the real
  dispatch, 07b and gates on a scratch database. Live, once the dev stack carries it: give "no inline
  svgs" a description, enforce it `files` on `**/*.tpl.php` (a D7 template is `.tpl.php`, not
  `.twig`) and stylesheets, and declare the site's own theme in `.haive-data/dependency-ownership.json`
  (a D7 theme outside `custom/` is third-party by default, so a violation there would go to a person
  rather than the fixer). Then one real `quick_bugfix` task on a D7 repo whose request invites an
  inline SVG. It costs tokens, so I'll ask before starting it. Check 07's and 07b's stamps, 07b's
  issue and the House rules row at gate 3 (quick_bugfix runs no gate 2).
- **PR7:** the recorded scores on the next real writer runs feed the measurement checkpoint.

## Not in this plan (verified; each becomes its own task)
- **#4.** Verify has one lint slot: a root `package.json` lint script hides phpcs
  (`08-phase-5-verify.ts` `resolveSlots`). PRE-EXISTING.
- **#5.** 08b joins the test paths the agent reported, unquoted, into the DDEV runner's `bash -lc`.
  The filter only checks the end of each path (`runTestCommand`, `TEST_FILE_RE`). PRE-EXISTING.
- **#6.** The DAG per-issue reviewer gets no line notes and no scope fence (`reviewerPrompt`), so it
  judges whole files. PRE-EXISTING; impact not measured.
- **Known risk.** 08c and the DAG reviewer do not see the rules, so they could ask for a violation and
  oscillate against 07b. The writer framing mitigates it; an "inform" mode is a later option.

## Execution
- **How:** `/opus-sonnet`, ledger in `.claude/tmp/house-rules/`, one worktree per PR at
  `.claude/worktrees/house-rules-<n>`. The PR loop follows the PR workflow memory; Greptile is off
  until 2026-10-08.
- **Order:** PR1 and PR3 can go in parallel. PR2 comes before PR4, which comes before PR5, then PR6,
  then PR7. Rebase onto the AIDE² wave where step-runner overlaps.
- **Migration 0173:** 0172 belongs to AIDE² T1. Renumber only if no dev DB has applied it. After the
  merge, run `pnpm docker migrate` and then `pnpm docker libs`.
- **Docs:** PR1 copies this plan to `docs/plans/` with its README row, after checking that the slug
  does not collide. A new `docs/architecture/global-kb.md` topic gets a line in the AGENTS.md index
  (keep the file under 32 KiB).
- **Undo:** PR1-PR4 and PR7 revert cleanly, and every new column is additive and nullable. Enforcement
  turns off through `GLOBAL_KB_HOUSE_RULES_ENABLED` without a deploy.
