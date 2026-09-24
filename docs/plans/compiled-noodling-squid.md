# Agent rules: global rewrite, per-dispatch delivery in Haive, upgrade and review-gate fixes

> **SHIPPED 2026-09-24.** Part 1 (global instruction files) 2026-09-23; PR B #229; PR C #231 with its follow-up #242; PR D #232; Part 5 as 12 local repository commits (not pushed) plus one re-render of a repository with no git; PR A #235. Migrations 0165 (C) and 0166 (A). Departures from this plan are marked **As built** in Parts 3 to 6. Still owed: Part 2's end-to-end upgrade check (no repository has finished onboarding yet) and the `agent_rules` stamp on the first real invocation.

## Context

A usage analysis (2026-09-23) of the global `~/.claude/CLAUDE.md` and of Haive's sandbox fork of it
(`DEFAULT_AGENT_RULES`) found:

- **Haive agents almost never got the rules.** Only 598 of 3,509 recorded invocations (17%) had them,
  and none has run since the 2026-09-14 manual regeneration, which is still uncommitted. The causes:
  - Worktrees are mounted alone and read HEAD's AGENTS.md.
  - Step 12's commit defaults to off.
  - The upgrade path never restores CLAUDE.md's `@AGENTS.md` and never stages rules files.
  - The block written into every repo is damaged: `dedupLines` drops the repeated blank lines and the
    closing code fence.
- **The global file:**
  - Three rules demonstrably work: found-not-fixed (2% → 93% of sessions), invariants, and browser
    checks (43 of 43 sessions).
  - Three don't work as written: comments, don't-answer-while-a-check-runs, and verification.
  - Several duplicate the harness, and the tone is more emphatic than current models need.
- **The most common user correction** (about half of 25) is that the work wasn't verified end-to-end,
  or verification was handed back to the user.

User decisions (2026-09-23):
- **Global file:**
  - Apply the scorecard.
  - Keep the adversarial retrace; models benefit from retracing while writing the result.
  - Restore Karpathy §1 "Think Before Coding", compressed.
  - Dial back the emphatic wording.
- **Haive delivery:** inject each provider's effective rules into every dispatch.
- **`DEFAULT_AGENT_RULES`:**
  - Drop the instructions about tools the sandbox doesn't have.
  - Drop "expert who double checks".
  - Replace "fix it everywhere" with "find similar code, don't change it, surface it at the review
    gate".
  - Sync the rest with the global rewrite.
- **Stamp** a rules hash per invocation.
- **Repos:** after the rules PR, commit the 12 git repos' rules files.

A plan review (Plan agent, 2026-09-23) found 16 issues; every accepted fix is folded into its part
below.

## Order

| # | Part | Where | Fixes |
|---|---|---|---|
| 1 | Global instruction files | `~/.claude` (no PR) | scorecard |
| 2 | PR B: upgrade restores import stubs; upgrade commit stages what it wrote | worker | found-not-fixed 2 |
| 3 | PR C: similar-code channel to gate 2 / gate 3 (migration **0165**) | shared, worker, database | fix-everywhere rewrite, plumbing |
| 4 | PR D: `DEFAULT_AGENT_RULES` rewrite, `dedupLines` fix, provider-form inherit state | shared, api, web | found-not-fixed 3, sync |
| 5 | Commit the repos' rules files (right after D) | the repos, local commits | legacy guide in HEAD |
| 6 | PR A: rules injected at dispatch, `agent_rules` stamp (migration **0166**) | worker, shared, database, api, web | found-not-fixed 1 |
| 7 | Docs and records | Haive AGENTS.md, docs/plans, memory | — |

Ordering constraints:
- **A lands after D.** Otherwise it would spread today's default ("use plan mode/tasks", "fix it
  everywhere") from 17% of dispatches to all of them, including coders told to change only what the
  prompt asked.
- **C lands before D,** because D tells agents to fill C's field.
- **Part 5 follows D promptly.** An onboarding resumed in between would record a block that doesn't
  match the files.
- **Migration numbers are reserved now, above the 0164 held by the attachments series.** They are never
  renumbered, because a dev database that has applied a renumbered file makes the runner refuse to run.
- **Each PR:** worktree under `.claude/worktrees/`, then branch, PR, merge commit, and Codex/Greptile
  review until a round brings no valid fix.
- **After each merge that touches shared/database:** first `pnpm docker migrate`, then
  `pnpm docker libs`. In the reverse order, `findFirst` without a column list selects the new column
  before it exists and every cli-exec job fails. Do this only after checking that no task is running.
- **Tasks:** one per part, created at the start of the work.

## Part 1 — Global instruction files

- **Files:** `~/.claude/CLAUDE.md` and `~/.claude/INVESTIGATE.md`. RTK.md stays on disk; only its
  import is removed.
- **Rollback, first:** copy both files to `~/.claude/backups/{CLAUDE,INVESTIGATE}.md.bak-20260923`.
  Undo means copying them back.
- **Restart:** not needed. Running sessions get an `edited_text_file` notice.
- **The full text** is in Appendix A.

Changes:
- **Structure and tone:** five short sections with sentence-case lead-ins instead of ALL-CAPS headings.
  "never" stays only at real boundaries.
- **Added:**
  - **Think before coding:** state assumptions; name readings that lead to different work, and ask;
    flag a simpler approach or a mistaken request in one sentence, then proceed as asked.
  - **Own the verification:** run the real flow end-to-end yourself, or say exactly what wasn't run.
  - **Separate git worktree:** use one when the checkout holds another branch's work.
- **Merged:**
  - The two read-before-answering bullets and the call-graph rule, into one bullet.
  - Plan mode and tasks, into one bullet.
- **Dropped:** parallel tool calls. The harness line and the batching reminders already carry it.
- **Rewritten:**
  - **Comments:** default none. One line, two at most, only where code can't show the why.
    Measurements, history and fix narratives go to the commit message or docs, even in comment-heavy
    code.
  - **DB-only changes:** gains an explicit local-only exception.
  - **Browser rule:** adds phone/tablet widths, and keeps "tell me and wait".
  - **Wait-for-checks:** names the observed failure, a wrap-up after a merge or push while CI runs.
- **Kept, with the same substance:** found-not-fixed, invariants, retrace, one recommendation.
- **Tooling:** `@RTK.md` is replaced by one line: use `/usr/bin/<cmd>` or `rtk proxy` when output is
  evidence. `rtk init -g` may re-append the import, so check after rtk upgrades.
- **INVESTIGATE.md:**
  - Keeps the four steps, the banned phrases, the report shape, the admissions and the hard stop.
  - Drops "Why this exists", which was tied to Claude Code 2.1.110.
  - The self-check list becomes one line pointing at the retrace rule.
- **Size:** about 8 KB instead of 16.6 KB.

**Verify:** a zero-token capture on the host. Point the real `claude -p hi` (real HOME) at
`scratchpad/cap.mjs` via `ANTHROPIC_BASE_URL`, then assert:
- the new CLAUDE.md and INVESTIGATE.md lines are in the request;
- RTK.md's text is not.

## Part 2 — PR B: the upgrade restores import stubs and commits what it wrote

**Helper** `steps/onboarding/_rules-files.ts`:
- `ensureRulesImportStub(repoPath, rel)` returns
  `'created' | 'appended' | 'unchanged' | 'skipped-link'`, or throws on a foreign link.
- It is moved out of 07's closures (`appendOrCreate(rf, '@AGENTS.md\n', '@AGENTS.md')` and
  `linkedToAgentsMd`, 07 ~992–1002) with the semantics unchanged.
- 07 calls it; its `wroteFiles`/`appendedFiles`/`skippedFiles` bookkeeping stays identical, pinned by
  `test/generate-files-links.test.ts`.

**`02-upgrade-apply.ts`:**
- After applying the selected items, list the import-mode rules files for the currently enabled
  providers: `planRulesFiles` (exported from 07) plus `cliAdapterRegistry` plus the user's enabled
  `cli_providers` rows.
- Call the helper for each file inside its own `try`. A refusal is recorded, never thrown: a throw
  would skip `updateApplicableTemplateIds` and `writeInstallManifest` (02 ~565–584).
- The output gains:
  - `rulesImportStubs: [{ file, result }]`;
  - `writtenPaths`: every path this run wrote, including AGENTS.md when the region changed.
- The stub is not tracked as an artifact; AGENTS.md "Onboarding completion" already rejected that
  design. Rollback leaves a restored stub in place, which is harmless and only imports AGENTS.md.

**`01-upgrade-plan.ts`:** its detect output lists missing stubs, so the upgrade form says what will be
restored.

**`03-upgrade-commit.ts`:**
- Stages its existing base paths and provider dirs, plus 02's `writtenPaths`.
- Paths are filtered with `safeDiskRel` (02 ~148–160) and checked for existence, as 03 already does
  (`hasWorkspaceEntry` ~180).
- It stages only what the upgrade wrote, never whole-file blankets. That way a user's uncommitted edits
  elsewhere are never swept into the upgrade commit.

**Also in this PR:** fix the stale comment at `cli-adapters/types.ts:76-83`, which says import files
also get the CLI's own rules block.

**Tests** (temp repos):
- The helper: every result, plus refusal of a foreign link.
- 02: a missing CLAUDE.md is recreated; a refusal is recorded without aborting.
- 03 stages 02's `writtenPaths`.

**Rollback:** revert the PR. Stubs already written stay, and are harmless.

**Verify:** on elmont_rs_test, delete CLAUDE.md and run an onboarding upgrade with commit ticked. Then
check:
- CLAUDE.md is back as `@AGENTS.md`;
- `git show --stat HEAD` lists exactly the paths 02 wrote;
- a zero-token capture from a worktree-shaped mount shows AGENTS.md reaching claude.

## Part 3 — PR C: similar code is surfaced, not changed

**Contract:** optional `similarSites: [{ path, lines?, reason }]`, meaning places with the same code or
defect that the agent did NOT change.

**07-phase-2-implement:**
- Contract text goes in `common` (~370).
- `parseImplementOutput` accepts the field; `salvageImplementOutput` gives `[]`.
- The field is declared last in the output object, because the step-recap prompt cuts the stringified
  output at 4000 chars (`step-runner.ts` ~2912).

**DAG coders:**
- `dagIssueResultSchema` (`packages/shared/src/schemas/dag.ts`) gains
  `similar_sites: z.array(z.unknown()).catch([])`, sanitised after the parse.
- It must not be stricter. A bad entry must never turn a finished coder into `failed_unrecoverable`
  (`parseCoderResult`, dag-executor ~350–365).
- Contract text is at `06c-dag-execute.ts` ~97 and `dag-executor.ts` ~844.
- Ingest merges (unions) the sites into a new jsonb column `task_dag_issues.similar_sites` (migration
  0165, declared last in `task-dag.ts`). The coder, fix-coder and advisor passes each rewrite the issue
  row (~2221), so overwriting would lose sites.

**Sanitising** (the `attachments-context.ts` ~84–91 pattern):
- `path`: `isSingleLine`, `survivesFence`, and relative; otherwise drop the entry.
- `lines`: must match `^\d+(-\d+)?(,\s*\d+(-\d+)?)*$`; otherwise drop the `lines` value.
- `reason`: `collapseToLine`, capped at 200 chars.
- At most 30 entries per output.

**Gate 2** (`09-gate-2-verify-approval.ts`):
- Detect reads ALL 07 rounds. `loadPreviousStepOutput` returns only the latest, so query the rows.
- It also reads the task's DAG issue sites, dedupes by (path, lines), caps at 50, and stores optional
  `similarSites?` and `similarSitesOmitted?`.
- Form appends an `info` statusSummary row, LAST, titled "Similar code elsewhere — not changed":
  - one line per site, with the path rendered by `code()`, exported from `workflow/_plan-ops.ts` ~51;
  - the source of each site (07 round N, or the DAG issue key);
  - an intro: to fix them in this task, reject with feedback naming them; otherwise consider a
    follow-up task.
- The row appears only when there are sites. Old payloads read `?? []` and render unchanged.

**Gate 3** (`10-gate-3-commit`) renders the same row when the run has no gate-2 step.
`quick_bugfix` is SPINE only: it runs 07 but has no 09 (`orchestrator/execution-paths.ts` ~34–101).

**Containment:** the list never enters the ledger. Its only prompt exposure is the step-recap slice,
where it is sanitised, agent-authored prose next to 07's summary. A person copying sites into reject
feedback writes human text, which stays unfenced by design.

**Tests:**
- 07 parse: accepted, sanitised, capped, bad `lines` dropped, missing field gives `[]`.
- DAG: a malformed entry still yields `completed`; ingest merges across passes.
- Gate 2: detect across rounds; the form row; a legacy payload without the field.
- Gate 3 on a quick_bugfix run.

**Rollback:** revert. The column is additive.

**Verify:** unit tests, plus the zero-token UI check. Render gates 2 and 3 from a temp tsx on a
dev-user fixture task, then view them at `localhost:3000` through Chrome MCP (desktop and narrow).

**As built** (#231, #242):
- No cap per output or per source: every well-formed site is kept, and only the gate caps its
  display at 50 and counts the rest. The plan's 30-per-output cap dropped sites silently.
- A site whose file a later implementation round edited is marked (`editedInRound`), not dropped,
  since that round may have edited the file for something else. The mark reads the agent's own
  `filesTouched`, so it is a hint.
- A manual retry of 07 replaces its round's reports, as it replaces the rest of that pass.
- The reason is backslash-escaped where the row is built (#242). `MarkdownView` renders images and a
  collapsed status row still mounts its body, so an image in a reason was fetched on every gate
  render (verified live with a control fixture). A bare URL still becomes a link.

## Part 4 — PR D: `DEFAULT_AGENT_RULES` rewrite

`packages/shared/src/constants/default-agent-rules.ts` follows Part 1, adapted to a headless sandbox.

**Keep:**
- The sandbox facts, verbatim: ddev and its hand-off; the `.git` boundary.
- The investigation protocol, with Part 1's trims. Step 1 stays VCS-agnostic.
- Reuse-before-writing, compressed.
- No ASCII art in agent docs.
- Read-before-claim plus the call graph.
- Minimum code, surgical changes, the new comments rule, explicit brackets, invariants.
- The DB-only rule with the local exception, and rollback-first.
- Verifiable goals, folding in "re-run a small fix on the input that failed".
- Retrace, and one recommendation.
- One line on parallel tool calls. This departs from the global file on purpose: the default also
  reaches codex, grok, gemini and amp, which get no Claude Code harness line.

**Add:**
- **Think before coding, headless version:** take the reading the spec supports, say which and why,
  and flag a simpler approach in one sentence.
- **Own the verification, sandbox version:** verify with what this environment can run; say exactly
  what couldn't run; never claim unperformed verification.
- **Similar sites:** find the same code or defect elsewhere and don't change it unless the task asks.
  List it where the step's output has a similar-sites field. There is no "otherwise in the summary",
  which would reopen the reporting duty the editing-pass guard deliberately removed.

**Drop:**
- The plan-mode/task-list bullet (found-not-fixed 3: those tools were offered in none of 2,742 sandbox
  tool lists).
- "Expert who double checks".
- "Why this exists".
- "Only make changes that are directly requested", now inside surgical changes.
- The interactive-only rules stay out.

**Also:**
- Add a test that the text names no agent path. One such path would end isolation on every dispatch
  once A lands.

**`dedupLines`** (`packages/shared/src/templates/cli-rules.ts:37-53`):
- A line with no letter or digit is structure and is never deduped.
- That keeps blank lines, `---` and the closing fence of the report block.
- Tests cover merging two providers' rules.
- The API drift recompute and 01-upgrade-plan use the same function, so they stay consistent.

**Hash contract:**
- Append the evaluated string's sha256 to `KNOWN_DEFAULT_RULES_HASHES`, labelled
  (`packages/shared/test/cli-rules.test.ts` asserts it).
- All 15 provider rows hold verbatim defaults and inherit the new text.

**Provider form** (`web/src/components/cli-provider-form.tsx:239` and the provider GET in
`api/src/routes/cli-providers.ts`):
- The API returns the effective rules and whether they inherit the default.
- The form shows the live default with the note "inherits the Haive default and follows its updates;
  editing makes it a custom override".
- Without this, editing a stale stored default freezes old text as a custom override.

**Rollback:** revert the text but keep the new hash in the set. Otherwise a provider created in the
meantime would read as custom.

**Verify:**
- `resolveEffectiveRules('')` returns the new text; record its size.
- The upgrade-status endpoint reports cli-rules changed for an onboarded repo.
- The provider form shows the inherit note, checked in Chrome MCP.

**As built** (#232):
- `dedupLines` never deduplicates structure (a line with no letter or digit), skips a block identical
  to an earlier one, and treats a fenced code block as one unit, dropped only when an identical fence
  was already emitted. Deduplicating lines inside a fence left a different example incomplete.
- The new default is 9,198 characters (hash `7a41e8a7…`), and all 15 dev providers read as inheriting
  it; the form shows it with the inherit note.
- The upgrade-status check could not run: no repository on the install has finished onboarding.

## Part 5 — Commit the repos' rules files (right after D)

No repo has `onboarding_artifacts` rows.

Step 12 hashes the block from **07's stored detect** (`12-post-onboarding.ts` 200, 260). Step 07 leaves
an existing region alone when overwrite is off (`07:854`). So the right content differs per repo. In
every case, first check that no task is running and that `git diff` shows only Haive content.

| Repos | Action | Why |
|---|---|---|
| 7 parked at `09_2` (the elmont_rs* test repos) | **commit as they are** (09-14 render, old default) | their 07 detect holds the old default; step 12 will record it; a later upgrade is then a clean update |
| muse, koznaklinika, dogacars (parked at `04`) | **re-render with the new default**; commit (dogacars is not a git repo: re-render only) | their 07 will detect the new default and skip the existing region |
| sailorix, vareska-claude, elmont_skladacka | **re-render with the new default**; commit | no onboarding; nothing records a hash |

- **Re-render:** use Haive's own functions, as on 09-14:
  - the project-info block, from stored detection, or name-only for blank repos;
  - the cli-rules block, from `buildCliRulesBlockFromProviders`;
  - the RTK block where enabled;
  - CLAUDE.md as `@AGENTS.md`.
- **Commit:** `git add AGENTS.md CLAUDE.md && git commit`, one local commit per repo, no push. This
  removes the 36 KB legacy guide from HEAD in the elmont repos.
- **Undo:** `git revert <sha>` per repo.

**Verify:**
- `git show HEAD:AGENTS.md` has both markers and no "Agent Spawning Pattern".
- A zero-token capture from a worktree-shaped mount of one elmont repo shows the block.

**As built:** the seven repos parked at `09_2` were not committed as they were. D changed
`dedupLines`, and step 12 hashes 07's stored rules with the new function, so a region written by the
old one would read as a conflict at the first upgrade. Each one's region was re-rendered from its own
07 detect with the fixed merge and then committed; its hash equals what step 12 will record (verified
for all seven). Each commit touches only AGENTS.md and CLAUDE.md, and a gitignored CLAUDE.md is left
out. `dogacars` has no git and was re-rendered only; `adminanything` carries no Haive markers and was
left alone. `git revert` restores HEAD's legacy guide rather than the uncommitted render that stood in
the working tree, so the pre-apply files were archived before the commits.

## Part 6 — PR A: rules injected at dispatch, and stamped per invocation

**Seam:** `buildCliSidePlan` / `adaptPrompt` (`packages/worker/src/orchestrator/dispatcher.ts`
~469–540).
- All nine dispatch sites pass through it, holding both the provider row and the final prompt.
- Stored-prompt re-feeds, sub-agent prompts and the codex exec fallback go through it too.
- It doesn't touch `step-runner.ts`, where the attachments series is working.

**New `orchestrator/agent-rules.ts`** (pure):
- `AGENT_RULES_MARKER = '<haive_agent_rules>'` and its closing tag.
- `withAgentRules(prompt, rules)` returns `{ prompt, injected }`:
  - It replaces a block found at **position 0**, which is how a re-fed stored prompt gets the current
    rules instead of keeping stale ones.
  - Otherwise it prepends.
  - A marker anywhere else is ignored, so repo or agent text can't suppress injection.
- **Framing line:** "Standing rules from this Haive install's CLI settings. The step's own instructions
  and output contract take precedence where they differ; these supersede any differing
  `haive:cli-rules` block in AGENTS.md."
- The block is unfenced. Providers are per-user and owner-edited, so this is operator text.

**Always inject.** There is no "the repo already delivers it" skip. The review showed that skip was
unsafe in four ways:
- the repo block is damaged (fixed in D, but still present in existing repos);
- codex reads only the first 32 KiB of AGENTS.md;
- antigravity's native loading is unmeasured;
- merged blocks from several providers never equal one provider's block.

The cost is a duplicate block on runs where the repo copy also loads.

**When not to inject:**
- **Opt-out:** a new request field `skipAgentRules` is set by the step-summary recap, 01-env-detect and
  `_model-health` (the canary declares no `toolProfile`).
- **Switch:** `req.agentRulesInjection` is absent in the pure resolver, which means OFF. That matches
  `agentIsolation` (dispatcher ~168–171) and keeps every existing resolver test's exact prompt.
  `resolveTaskDispatch` sets it from `CONFIG_KEYS.AGENT_RULES_INJECTION_ENABLED` (default on).
- **Rules source:** `resolveEffectiveRules(provider.rulesContent ?? '')` — this provider's own rules,
  not the merged block.

**Order inside `adaptPrompt`:** `withAgentRules` is applied LAST. The operator's text stays out of every
rewrite (capability, retrieval and marker rewrites) and sits outermost.

**Oversized prompts:** if `buildCliInvocation` throws `PromptTooLargeError` (gemini is argv-only,
`prompt-delivery.ts` ~77–88), rebuild without the block, warn, and stamp the reason. That way the
injection can never turn a working dispatch into a failed one.

**Isolation:**
- The final `agentIsolationApplies` gets the injected text as extra external text (condition 7), so
  rules naming `.claude/agents/x` end isolation.
- The async pre-check (~330) stays without it. The pre-check must be at least as permissive as the
  final pass so that persona bodies get read, and the final pass can only turn isolation off.
- Fix the docstring's stale "All six must hold".

**Stamp:**
- `spec.agentRules = { hash, injected, reason? }`, with `reason` one of
  `disabled | opt-out | prompt-too-large | empty` and `hash = sha256Hex(normalizeContent(rules))`.
- Exec writes it in the UPDATE that sets `startedAt` (`queues/cli-exec/handlers.ts` ~149): one write
  site, the same route `assignedAgentIds` rides.
- Rows that never start stay NULL.

**Database:** migration **0166** `cli_invocations_agent_rules.sql`:
`ADD COLUMN IF NOT EXISTS agent_rules jsonb`, declared LAST in `schema/tasks.ts` `cliInvocations`.
NULL means not recorded.

**Switch UI:** it mirrors `AGENT_ISOLATION_ENABLED`:
- key and seeded default in `shared/src/config/config.service.ts`;
- a route beside `api/src/routes/admin.ts` ~759;
- a toggle on the admin CLI-execution card.

**Tests:**
- `agent-rules.test.ts`: position-0 replace, prepend, the spoofed marker ignored.
- `test/dispatcher.test.ts`: injection on; per-provider rules; opt-out; switch absent; the
  `PromptTooLargeError` fallback; the stamp in every case.
- `agent-isolation-rule.test.ts`: injected rules naming an agent path end isolation.
- The mining re-feed replaces a stale block (`test/step-runner-mining-retry.test.ts`).
- The exec start update writes `agent_rules`.
- CI's `schema-parity` job covers the migration.

**Docs, in the same PR:**
- Update Haive AGENTS.md's per-call isolation paragraph, where the list of post-decision appends gains
  the rules block.
- Update the tripwire comment at `prompt-agent-paths.test.ts` ~1869.
- Add a short "Agent rules delivery" subsection.

**Rollback:** turn the switch off (no deploy) or revert. The column is additive.

**Verify:**
- Unit tests.
- A zero-token dispatch check from a temp tsx:
  - a worktree fixture is injected exactly once;
  - a re-fed prompt gets the current block;
  - an opt-out step gets none.
- After merge, run `migrate` then `libs` (no task running), arm a watcher, and SELECT `agent_rules` on
  the next real invocation.

**As built** (#235):
- A closing tag the operator's rules quote is escaped (`<\/haive_agent_rules>`), never removed.
- A re-fed prompt's stored block is stripped before the other adapters run. Every one of them
  prepends, so one that newly applies would otherwise bury the stored block and leave two. The
  isolation scan reads the prompt without that block too.
- The stamp's `reason` is `disabled`, `opt-out` or `prompt-too-large`. There is no `empty`, because
  blank rules inherit the default.

## Part 7 — Docs and records

- **Haive AGENTS.md changes land with the PR that makes them true:**
  - B: upgrade stubs and staging, under "Onboarding template versioning".
  - C: similar sites, under "Review scope".
  - A: the rules delivery.
- **`docs/plans/`:** add this plan and its README status row in the same change.
- **Memory:**
  - A series entry: plan path, order, reserved migrations 0165/0166, and the decisions not to
    re-litigate (always inject; switch absent = off; stamp at exec start; similar sites display-only;
    per-repo Part 5 table).
  - Close found-not-fixed 1–3 as they land.

## Coordination with the attachments series (in flight)

- **PR A** avoids `step-runner.ts`.
- **Migrations:** 0165 and 0166 sit above its 0164.
- **PR C** touches the DAG coder contract text, where that series' PR 6 edits prompt assembly: rebase
  right before opening it.
- **Mining re-feed:** its "recovered mining prompts replayed verbatim" work covers the terseness
  double-append.

## Found during planning, not in scope (all verified)

1. **Onboarding reset leaves the RTK block in AGENTS.md.** `stripHaiveContent` knows two marker pairs
   (`api/src/routes/repos.ts:1525-1528`), while `_rtk-templates.ts:26-29` claims otherwise.
   PRE-EXISTING.
2. **A default change between 07 and 12 records a hash that doesn't match disk.** 07 skips an existing
   region when overwrite is off (`07:854`), while 12 hashes 07's detect (`12:200,260`), so the first
   upgrade reads `conflict`. Part 5's table avoids it for the current repos. PRE-EXISTING.
3. **The instruction-chain scan anchors its fs-safe read on the worktree** (`agent-isolation.ts:93` via
   `resolveInvocationWorkerTree`), against the anchor convention (`workspaceAnchor`). PRE-EXISTING.
4. **Codex reads only the first 32 KiB of AGENTS.md** (OpenAI docs; not measured here). The repo rules
   block sits after user content, so a user's own codex runs in large-AGENTS.md repos may never see
   it. Haive runs are unaffected once A lands. PRE-EXISTING.
5. **The API upgrade banner compares hashes only,** so a repo drifting only by a missing stub is not
   offered an upgrade. PRE-EXISTING.
6. **Stale docs:**
   - `_untrusted-repo.ts:196-203`: the ledger is fenced since #216.
   - `AGENTS.md:1050`: `review_findings` is SELECTed by `_review-findings.ts:337` and the stats routes.
   - `AGENTS.md:1990`: no code writes `.claude/upgrade-reviews/`.
   PRE-EXISTING.
7. **Under auto-continue, 07's `## INSIGHTS` are pre-answered empty** (`06-run-config.ts:513`).
   PRE-EXISTING; possibly intended.

## Appendix A — proposed global text

### `~/.claude/CLAUDE.md`

~~~markdown
# Working rules

## Before coding
- **Think before coding.** State the assumptions you are making. If the request can be read in ways that lead to different work, name the readings and ask rather than picking one silently. If a simpler approach exists or the request looks mistaken, say so in one sentence, then proceed as asked. If something is unclear, say what and ask.
- **Read before you claim or change.** Open the relevant files before answering about code or proposing an edit, and make no claim about code you have not read unless you are certain. Before changing a function, method, hook or endpoint, find its callers and usages: they are the contract it must keep, and a fix that breaks a caller is a regression.
- **Plan larger work.** For a larger refactor or feature, plan in plan mode first, then track the plan as tasks; a task list survives compaction, a plan held only in context does not.
- **Keep branches apart.** When the checkout holds work in progress for another branch, start new work in a separate git worktree.

## Scope and simplicity
- **Minimum code.** Solve the problem and nothing speculative: no unrequested features, no abstractions for single-use code, no configurability nobody asked for, no handling for impossible cases. If 200 lines could be 50, rewrite it.
- **Surgical changes.** Touch only what the request needs; every changed line should trace to it. Match the existing style; do not improve adjacent code, comments or formatting. Remove only what your own change made unused; mention unrelated dead code instead of deleting it.
- **Fix it everywhere.** When fixing or implementing a functionality, find the other places that use the same functionality and fix them too, unless I ask you to stay in one place.
- **Small units.** Keep each change the smallest unit worth reviewing, and split a refactor, a fix and a feature into separate commits or PRs.
- **Comments.** Default to none. Add one only where the code cannot show the why (hard math, a workaround, a non-obvious constraint), in one line, two at most. Measurements, history and the story of a fix go in the commit message or the docs, not in code comments. This holds even where the surrounding code is comment-heavy.
- **Explicit brackets** in mixed logic: `if ((a && b) || c)`, never `if (a && b || c)`.
- **Invariants, not ephemeral values.** Key logic on stable contracts (documented APIs, exit codes, schema fields, error types, structural delimiters), never on ephemeral values (banners, log or branding prefixes, version strings, timestamps, ANSI codes, human-facing wording). Split output by its structure (delimiter, stream, exit code), and prefer capturing everything and excluding the known-stable part over capturing the known-ephemeral part. If you must depend on an ephemeral value, isolate it in one named constant marked volatile and fail loudly when it stops matching. The test: would this still be correct if the tool reworded its banner or bumped its version tomorrow?

## Data and irreversible changes
- **Database-only changes ship as code.** A change that lives only in the database (config set through a CLI or admin UI, a data fix, SQL) goes out as the framework's update mechanism (Drupal hook_update_N, a migration) or an idempotent script that production runs on deploy, guarded so re-running is a no-op. Exception: a change that must stay local, such as neutralising mail or cron after restoring a production dump; say explicitly that it is local-only.
- **Rollback first.** Before a migration or other hard-to-reverse change, state the undo path in plain words. Prefer small reversible steps, and split a risky migration into an additive phase and a later destructive one. If a change cannot be undone safely, stop, tell me, and redesign.

## Verifying and reporting
- **Verifiable goals.** Turn the task into a goal you can check before starting: a failing test for a bug, tests green before and after a refactor. Give each step of a plan its own check, and loop until it passes.
- **Own the verification.** Before calling something done or fixed, run the real flow end-to-end yourself: the actual UI path, logged in as the role it targets, with real data, producing the actual export. If you cannot, say exactly what you could not run and why. Do not hand verification back to me by default.
- **Browser checks.** Test front-end changes in a browser through the Chrome MCP server; for layout changes also check phone and tablet widths. If the Chrome MCP server is unavailable, tell me and wait for me to fix it.
- **Retrace before you answer.** After reaching a conclusion, take the adversarial side and ask yourself at least three questions that could disprove it, and check them. Example: a 403 does not prove missing access until you have confirmed the credentials and that the request matches the documented auth route; there may be two routes with different inputs.
- **One recommendation.** When asked which approach to take, give one specific recommendation and the reason. When better evidence or a stronger argument appears, switch visibly: "you're right, switching to X because Y".
- **Wait for your own checks.** If you started something whose result could change the answer (a subagent review, a test run, CI, a review round), do not present the plan, conclusion or final report until it lands; say "waiting on X" and wait. This includes the wrap-up after a merge or push while CI on that commit is still running: "unless something goes red" is not an exception. The only exceptions, said out loud: the pending result cannot change this answer, or it has hung or been superseded. A harness nudge to end the turn is not a reason; post a one-line status instead. Never predict what a pending result will say.
- **Found, not fixed.** Keep a running list of defects, gaps and trade-offs you found outside the task, and show it whenever I wait on something long-running and in the final report. One line per entry: what it is, REGRESSION or PRE-EXISTING, and why it was left; most consequential first; end with the one or two you would fix. Verify each entry against the code before writing it down. It is not a parking lot: fix what is in scope and cheap, and anything you introduced. It runs alongside a loop's own stop condition, never instead of it. Carry it across sessions for ongoing work. If nothing was left, say so in one line.

## Tooling
- Shell commands pass through rtk, which can summarise output. When output is evidence (logs, grep matches, git output), run the absolute binary (`/usr/bin/grep`, `/usr/bin/git`) or `rtk proxy <cmd>`.

@INVESTIGATE.md
~~~

### `~/.claude/INVESTIGATE.md`

~~~markdown
# Investigating failures

When a test fails, something errors, or I report a bug, work in this order:

1. **Own changes first.** Run `git diff --stat HEAD` and `git status` and state what this session changed, one line per file.
2. **Read every failure artefact, not a sample:** all files the runner produced for the failing case (output, result files, fixtures, screenshots, traces); for a unit failure the test, the class under test and its fixture; for a runtime error the error log, the request log and the log of any downstream service in that window.
3. **Compare to a prior passing run** if one exists, citing its timestamp; if none exists, say so.
4. **Then hypothesise,** pairing each claim with the path and line (or key) that supports it. No citation, no claim.

Do not use blame-shifting phrases ("not my code", "not caused by my changes", "this is environmental", "this is a pre-existing issue", "not a code bug", "infrastructure is down", "external service is broken", "must be a flake", "not my fault") unless you have just cited the artefact that proves it. Reaching for one before steps 1–3 means you skipped them.

Before sending a diagnosis, retrace it (see "Retrace before you answer"): every claim cited, your own changes ruled out by evidence rather than assumption, and no "likely", "probably" or "seems" where you have not checked.

Report a failure investigation in this shape:

```
WHAT I CHANGED THIS SESSION:
  - <file>: <one line on what>
WHAT THE ARTEFACTS SHOW:
  - <path>: <exact finding>
COMPARE TO PRIOR RUN:
  - <prior path>: <same / different> — or "no prior run"
HYPOTHESIS (with evidence):
  - <claim> — supported by <artefact line/key>
WHAT I HAVE NOT VERIFIED:
  - <gap> — or "nothing, hypothesis is evidence-complete"
```

Always acceptable instead of speculating: "I don't know yet — reading the logs now."; "My change at `<file>:<line>` could plausibly have caused this; ruling it out by checking `<artefact>`."; "I was wrong earlier — the evidence at `<artefact>` says `<finding>`." (replacing the wrong claim, not sitting beside it).

If I say "investigate properly", "look at it", "did you actually check" or similar, drop the current hypothesis and restart from step 1.
~~~
