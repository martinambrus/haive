# Enforced house rules from the global KB, plus three found-not-fixed fixes

> **In progress** 2026-10-03: approved. PR1 shipped (#398: the Drupal 7 facet family with the
> major the token implies, plus an inherited-key guard on the facet alias lookup). PR2 built (the
> title list states its omission; global KB titles collapsed in the list and in step 11). Line
> numbers are as of writing; resolve by symbol.

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
- **`PATCH /global-kb/entries/:id`:**
  - Enforce and un-enforce require `requireAdmin`.
  - Every PATCH takes a namespace advisory lock first and the row lock second, so enforcing and
    reactivating cannot deadlock.
  - 409 for an entry that is not active, belongs to another namespace, or whose `expectedHash`
    differs (the admin enforces what they saw), and when the always-cap is exceeded. The cap is
    counted in UTF-8 bytes and the response gives the numbers.
  - 400 for refused text, bad globs, or a missing description.
  - Enforcement is cleared when the status leaves `active` and when an activation archives a
    predecessor.
  - An enforce-only change bumps nothing and queues no re-embed.
- **Enrich step:** `01-enrich` refuses to re-enrich an enforced entry; a Retry would demote it and a
  Cancel would delete it.
- **Config:** `GLOBAL_KB_HOUSE_RULES_ENABLED`, seeded true, beside the digest toggle. One resolver
  reads `GLOBAL_KB_ENABLED`, whose two readers default differently today.
- **UI:**
  - Enforce panel: the raw source, fenced; mode; globs; always-usage meter.
  - Badges: Enforced·always, Enforced·files, Lapsed with its reason. "Superseded" names the successor
    and offers Re-enforce.
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

### PR6. Dispatch: who gets which rule, the 07b check, the per-run record (migration 0173)
- **Roles table.** `HOUSE_RULE_ROLES` goes in `shared/src/step-engine/types.ts` beside
  `STEP_CLI_ROLES`, and steps reference it the way they reference `cliRoles`.
  - **write:** 04, 05 corrector, 05a, 07, 07a (simplifier and fixup), 07b fixer, 08a fixer, 08b, 08e,
    the 06c coder (level coder and fix coder), and retry_ai under a role constant of its own, never
    `default`.
  - **review:** the 07b validator.
  - Mining dispatches are not opted in.
  - `HOUSE_RULE_EXEMPT` gives a reason for each exemption: merge fixers, plan merge, 09_5/09_5b, 11d,
    kb_author, advisor, replanner.
  - Ratchet: every step that declares `file_write` must be in one table or the other.
- **Wiring.** Every dispatch site already knows (step, role) for `resolvePreferredCli`, so each sets
  `DispatchRequest.houseRules` from the table.
- **Resolver.** One global-KB read per dispatch, `resolveGlobalKbContext`, returns:
  - the title list;
  - the enforced candidates from a query of their own, so an enforced rule never falls outside the
    400-row scan;
  - a status of ok, disabled or unavailable.

  It never rejects.
- **Selection** (pure):
  - `always` rules are in.
  - A `files` rule is in when a glob matches the dispatch's known files, using picomatch with
    `dot: true` as secret masking does. Known files are the change collector's git half for the
    dispatch's worktree, plus a DAG issue's `estimated_files`.
  - A per-prompt byte budget drops whole entries and says which. The budget is set from the measured
    p95 prompt size of 07, 07b and 08b.
- **Injection** (`orchestrator/house-rules.ts`):
  - The block sits at position 0 directly under the agent-rules block. It is not gated on rag, and it
    is unwrapped because the text is approved by an admin.
  - A stored block is replaced only at position 0. A marker quoted anywhere else must not suppress
    injection.
  - One `stripHaivePreamble()` is used by the isolation scan and by the persona bookkeeping reads.
  - The closing marker is escaped. Titles and descriptions are collapsed. `anti_pattern` renders as
    "Anti-pattern — avoid".
- **Write framing:**
  - Follow the rules in what you write or specify, on the lines you write.
  - Do not rewrite untouched code to fit them; report it as similar sites.
  - A spec never restates the rules as requirements; every implementer and validator receives them.
  - When the approved spec requires something a rule forbids, follow the spec and report the
    conflict.
- **Review framing (07b validator):**
  - Check the written lines against every rule; a file with no line note counts as wholly written.
  - A violation is an issue at severity high that names the rule.
  - Violations elsewhere, and spec/rule conflicts, go to the report.
  - 07b's `ISSUES_FOUND` then blocks through its own fixer and the fix loop.
- **Isolation, prompt size, record:**
  - The injected text is scanned as external text, and only when it is injected.
  - When the prompt is too large, the fallback drops house rules first, then agent rules.
  - The stamp `{mode, entries:[{id,hash,why}], omitted, reason?}` is written to
    `cli_invocations.house_rules` by the `started_at` UPDATE. Migration 0173 declares the column after
    AIDE²'s `haive_build`. NULL means the run was not opted in or predates this.
- **Gate 2** gets a row, "House rules: enforced (N) / not enforced (reason)", read from the latest
  validator invocation's stamp. When the KB cannot be read, one `house_rules.unavailable` event is
  written per task.
- **Tests:**
  - `dispatcher.test.ts`:
    - both framings;
    - off or absent gives a `toBe`-identical prompt, digest included;
    - injection is not gated on rag;
    - block order;
    - a replay carries one block, and none after un-enforcing, including when a new adapter applies;
    - a quoted marker elsewhere does not suppress injection;
    - the fallback ladder;
    - isolation ends for a rule that names an agent path, but not for a stored block;
    - sub-agent kinds get nothing.
  - `agent-isolation-rule.test.ts`.
  - `prompt-agent-paths.test.ts`: the named list, and "nine appends, five external".
  - `house-rules.test.ts`, mirroring `agent-rules.test.ts`.
  - Resolver: an enforced rule older than 400 rows; lapsed rules are excluded; budget drop order;
    status values.
  - The roles ratchet.
  - DAG roles.
  - Loop iteration 0 is review and 1 is write.
  - The `started_at` UPDATE writes both stamps. No test covers `agentRules` there today.

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
- **PR6:** with "no inline svgs" enforced `files` on templates and stylesheets, run the real
  `resolveTaskDispatch` against the live DB for a D7 task:
  - 07 and 07b get the rule when a `.twig`/`.css` file is in the change;
  - 05's reviewer passes get nothing;
  - with the switch off the prompt is identical;
  - the stamp has the right shape.

  Then one real `quick_bugfix` task on a D7 repo whose request invites an inline SVG. It costs tokens,
  so I'll ask before starting it. Check 07's output, 07b's issue, the stamps and the gate-2 row.
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
