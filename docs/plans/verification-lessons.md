# Claude Code verification lessons for Haive

> **Not started** 2026-11-19: findings and phases only, nothing approved. One source is reviewed:
> Addy Osmani's "How the Claude Code team thinks about verification" (claude.dev blog). Every Haive
> claim was read on `main` `bc0b9bc85` on 2026-11-19. Resolve references by symbol; line numbers are
> hints and drift. Keep this file current by editing the section a change belongs to: a decision
> moves from Open decisions to Decided, a shipped phase gets its status in its own section and in
> `README.md`. Recommended first wave: P0, P1 and P2, since all three reuse mechanisms Haive already
> has and together close the gap the article treats as fatal (a change able to edit the check that
> judges it).

## Context

The user asked what the article offers Haive. Each technique below counts only where Haive lacks it
or does it worse; what Haive already does is listed under Already present so it is not rebuilt.

One difference bounds the transfer. The article describes a team verifying its own product's
changes with tooling it controls end to end. Haive verifies changes an agent makes in someone
else's repository, so a check's rules, scripts and personas often live in the very tree under
review. That makes the article's integrity rule ("if a change can modify the check that judges it,
the check is broken") more important for Haive than for the article's authors, not less.

## Source reviewed

### S1. Addy Osmani, "How the Claude Code team thinks about verification" (claude.dev blog)

<https://claude.dev/blog/how-the-claude-code-team-thinks-about-verification/>

- About 90% of the team's code is written and reviewed by Claude. Verification loops are what lets
  them run many agents in parallel instead of one or two. A separate grader against a rubric raised
  task success by up to 10 points on structured file generation, most on the hardest problems.
- Test types: end-to-end first (hard to fool, definite done criteria, a step trace and a screenshot
  rather than "Timeout after 30 seconds"); property tests (round-trip, invariants, idempotency,
  equivalence with a naive version; fast-check, Hypothesis, proptest); differential tests (the old
  system as the oracle, random or sampled production inputs, irrelevant differences normalized, a
  list of approved differences).
- A per-repo feature map (features from the user's side with paths, shortcuts, selectors and
  expected results) serves as guide and grading rubric.
- A `verify` skill in `.claude/skills/` boots and drives the app; it is the smoke harness and must be
  fast and reliable.
- A check still failing after three fix rounds brings in a human. Owners write their own checks;
  a check that pulls in a reviewer says why.
- A 39-item reliability checklist, each item with a trigger readable from a diff, a check and the
  incidents or PRs behind it; Claude runs only the matching items (usually 3 to 10).
- One tuned reviewer beats stacking a second, more expensive one. A REVIEW.md states the focus.
  Rounds build on earlier rounds' context.
- Changes cannot modify their own checks: REVIEW.md is read from the base branch, never from the
  PR. A review is tied to a commit; a push during review makes it stale.
- Cheap checks first (tests, build, lint before a PR), enforced by a hook or a goal.
- Every commit is stamped with how it was verified, `none` included, so unverified commits can be
  queried. A commit gate has off, observe (log what would have been blocked) and enforce modes, an
  explanation in the commit message can excuse it, and after two blocks in a session the next
  commit is let through.
- Reviewers are graded: reverted merges, maintainer rejections, a size-matched clean control set.
  A formal eval recreates the repo at review time, gives each case a one-sentence answer key, scores
  only findings that describe that bug, uses merged stable changes as controls against over-flagging,
  keeps the tuning set apart from the test set, and measures recall separately for raw findings,
  post-verification and the final review. Severity is Important, Nit or Pre-existing.
- Misses become rules: mine patterns from human review comments and reverts (seen in at least two
  PRs, readable from a diff, three agents try to disprove it, a human approves it); replay three bug
  finders against a PR tied to a known incident (two of three finding it means it is detectable).
- Flaky tests: no skips, no sleeps, no retry-until-green; if the cause cannot be found, delete the
  test and document why. Test suites, verification steps and rule files are pruned on a routine.

## Already present

Haive already does these; no phase rebuilds them.

- **Running the change.** 08 always runs an HTTP smoke (`runRuntimeSmoke`) and the test, lint and
  typecheck slots; 08a drives the app through the chrome-devtools MCP with tester and fixer passes
  and captures screenshots (`_screenshots.ts`), console and network errors and a visual verdict, and
  sets `verificationIncomplete` on a pass with zero screenshots; gate 2 shows a live noVNC browser
  and does not treat a pass without evidence as clean.
- **A human after N failed rounds.** `tasks.max_fix_rounds` (default 5, `DEFAULT_MAX_FIX_ROUNDS`),
  `detectFixLoopOscillation` from round 3, and `buildFixLoopEscalationSchema` (Continue, Accept,
  Abort, instructions for the next round). The article's three is not adopted: Haive's cap is a
  per-task setting and the oscillation guard stops a stuck loop earlier.
- **Disproving findings.** 08c's refutation panel (`REVIEW_REFUTE_ENABLED`, `MAX_REFUTERS` 10,
  three lenses: reachability, impact, defenses; `isRefutedByPanel` dismisses only when all three
  disprove with file:line evidence).
- **Rounds build on rounds.** `loadPriorFixContext`, `loadSameCheckRepeat`, `loadFindingRecurrence`
  and 08c's `buildRecurringNote`.
- **Pre-existing is not blamed on the change.** The scope fence (`SCOPE_BOUNDARY`, `isOutOfScope`),
  security `in_scope: no` / `pre-existing`, phpcs blocking only on written lines, the report-only
  upstream class. Severity is critical/high/medium/low (`shared/src/review/severity.ts`); a Nit tier
  is not adopted, `low` covers it.
- **Diff-triggered rules.** House rules in `files` mode match admin-approved globs against the
  change (`selectHouseRules`), including planned paths before anything is written.
- **One ownership read outside the change.** `_dependency-policy.ts` reads ownership from the task's
  fork point, "never from an agent's edited working copy". P0 generalizes this.
- **Fix-pass test edits recorded.** `aide2-harness-lessons` P6's cheap half (`_fix-test-edits.ts`):
  per-pass manifests and blobs, shown at the gates and named to 07b and 08c.

## Findings

- **F1. Reviewer personas are read from the tree under review.** 08c, 08d, 08b and 08a follow
  `.claude/agents/<id>.md` "if it exists in the repo" (`buildPeerPrompt` in `08c-code-review.ts`,
  `agentDefinitionGuidance`). The pasted persona body is read from the invocation's worker tree
  (`readPersonaBodies` in `orchestrator/agent-isolation.ts`, `workerTree` resolved in
  `dispatcher.ts` from `snapshotWorkspace.target.workerRoot` or `resolveInvocationWorkerTree`), which
  is the task worktree the implementing agent writes. An implementation pass can rewrite the
  reviewer that judges it.
- **F2. Other check-defining files are read from the tree under review too.** Skills
  (`.claude/skills`, `.agents/skills`), AGENTS.md / CLAUDE.md (loaded natively by the CLI in its
  cwd), and the scripts and configs behind every verify command (a declared
  `repositories.verifyCommands` string or one detected from the worktree's manifests; either way it
  runs the worktree's `package.json` scripts and test, lint and coverage configs). Some edits to
  these are the task's legitimate purpose, so a blanket base-branch read is wrong for them; they need
  visibility (P1), not relocation.
- **F3. Only review dimensions, house rules, agent rules and dependency policy are out of reach.**
  The first three come from the database (`review-dimension-context.ts`, `global-kb-context.ts`,
  `provider.rulesContent`), the last from the fork point.
- **F4. Nothing deterministic flags a weakened test.** No detector for added `.skip`, `.only`,
  `xit`, `markTestSkipped`, `pytest.mark.skip`, added sleeps or fixed waits in tests, retry
  settings, deleted test files, lowered coverage thresholds, or edits to CI or test configuration.
  `_test-env-guard.ts` only classifies two Playwright launch errors; 07b's churn guard is about
  convergence; 08b's `tests_deleted` is the agent's own report. `_fix-test-edits.ts` records edits
  only on repair passes (the `repairPass` condition in `step-runner.ts`, and `dag-executor.ts`), so
  the first 07 pass and 08b's first pass are never captured, and it is labelled "display evidence,
  not a verdict on expectation weakening" by design (P6).
- **F5. Most results are not bound to the tree they checked.** Two bindings exist: 07b's validation
  snapshot (`_validation-snapshot.ts`; `queues/validation-recheck.ts` re-runs 07c/07b when a step with
  `editsCodeOrTests` changes the tree before gate 3) and the house-rules change fingerprint
  (`changeFingerprint` in `orchestrator/house-rules-dispatch.ts`; `modifiedAfterCheck` in
  `_gate-house-rules.ts` turns the row PARTIAL, which blocks gate-2 approval, but only when a house
  rule was in play). The outputs of 08, 08b, 08c, 08c2 and 08d carry no fingerprint and are never
  invalidated; only the 08e insight path re-runs 08 and review. A manual edit after gate 2 is not
  detected: gate 3 re-reads `git status` and stages everything at submit.
- **F6. A commit does not record how it was verified.** `10-gate-3-commit.ts` builds the message
  from the diff only and tells the model "do not invent work, verification results". No trailer, no
  column; `tasks.commit_sha` is the only commit field. Verification results live only as JSON in
  each step's `task_steps.output`, which a step reset clears.
- **F7. No check has an observe mode.** No off/observe/enforce, shadow or dry-run mode in worker,
  shared, api or web. Nearest: house-rule states (`off`, `enforced`), verify slots `auto|off|custom`
  (`web/src/lib/verify-commands.ts`), and advisory-only signals (runtime smoke, 08c2 audit).
- **F8. Nothing detects flakiness.** No rerun of the same code to see pass and fail. 08b loops while
  `testsPassed === false` (up to 6 iterations) with a fix pass between runs. Failure classes are
  environment versus defect only (`classifyTestEnvFailure`, the NOT RUN slots). The prompts say "do
  not weaken tests" (`BEHAVIOUR_FIX_LINES`) and "replace arbitrary waits with assertions" (08b fix
  prompt); none forbids skips or retries, and none says what to do when no root cause is found.
- **F9. No prompt asks for property or differential tests.** `07-phase-2-implement.ts` gives no
  test instruction; 08b says "Match the test TYPE already used in the project (E2E vs unit)".
- **F10. Review quality is not measured.** No eval corpus, answer keys, seeded bugs, controls or
  per-stage recall in src, `tests/` or `scripts/`. `aide2-harness-lessons` F13: `review_findings`
  held rows from only 3 tasks then. The review-corpus harvester is untracked and absent from this
  checkout. Haive's review has exactly the article's three stages (raw 08c findings, after the
  refutation panel, open at gate 2), and nothing shows whether the panel drops real bugs.
- **F11. No outcome after merge comes back.** A PR closed unmerged only sets `prState='closed'` and
  stops polling (`pr-poll-queue.ts`); no code detects a revert of a task's commit. Step 11 runs before
  push (11a) and the PR wait (13), so it cannot see the outcome. `review_findings` dispositions
  (`dismissed_human`, `accepted_risk`) feed only `GET /stats/quality` and gate display.
- **F12. Learned rules carry a task id but no incident, and no occurrence bar.** Global KB entries
  have `sourceTaskId`, `sourceRepoId`, `enforcedBy`; step guidance has `sourceTaskId` and
  `sourceStepId`; repo learnings a footer with origin task. None names the finding, PR, gate
  rejection or revert that motivated it. `occurrences` is counted for ranking and explicitly "NOT
  evidence" (`step-guidance.ts`). Promotion to an enforced house rule needs a person (draft,
  activate, admin enforce), which matches the article's human approval; nothing like its
  two-occurrence or replay bar exists.
- **F13. Nothing prunes by use.** The only sweep deletes global-KB entries already `archived` past
  retention (`global-kb-sync-queue.ts`). Step guidance has no reaper; learning deletion-intent
  records are never pruned. 13's RAG usage review writes `usageAssessment` on `ragQueryLog`
  (`_rag-usage.ts`) and nothing reads it for pruning.
- **F14. 08a's rubric is the spec, and its evidence is screenshots.** The rubric is the spec's
  acceptance criteria plus the plan-impact block, or a repo `integration-tester.md` persona (from
  the worktree, see F1). No per-repo feature map exists. No step traces, videos or HAR files;
  `checklistMarkdown` is always null in 08a.

## Phases

Each phase is one PR unless it says otherwise, through review and CI. Every new gate signal starts
in observe mode (P3's mode setting) and moves to enforce only on an owner decision backed by its
observed false-positive rate.

### P0. Read reviewer personas from the fork point (small; recommended first)

F1. For every seat that judges the change rather than writing it (07b's validator, 08a's tester,
08c's and 08c2's reviewers, 08d's adversarial QA), read `.claude/agents/<id>.md` from the task's fork
point, the same way `_dependency-policy.ts` reads ownership, never from the worker tree. Confirm the
seat list against `agentDefinitionGuidance` call sites when building. The implementing, fixing and
test-writing seats (07, 08b) keep the worktree copy, since a task may legitimately change its own
repository's personas for later tasks. Where the
fork-point and worktree copies differ, the gate row says the change edited a reviewer persona and
which copy judged it. The prompt line "if it exists in the repo, follow it" becomes a Haive-pasted
body, so the reviewer does not open the worktree file itself.

- Reads go through held git reads and `fs-safe`, per AGENTS.md; a missing fork-point copy means "no
  persona", not a fallback to the worktree.
- Verification: a fixture where the implementer rewrites `peer-reviewer.md` and the reviewer's
  prompt carries the fork-point body; a persona added only in the change is not used by its own
  review; the gate row names the edit.
- Rollback: code only; reverting restores the worktree read.

### P1. A check-tamper detector, in observe mode, on every pass (recommended first)

F2, F4. A host-side, deterministic scan of the change against the fork point after every writing
pass, the first 07 pass and 08b's first pass included (extending, not replacing, P6's repair-pass
record). It flags:

- added skip or focus markers in test files (`.skip`, `.only`, `xit`, `xdescribe`, `test.todo`,
  `markTestSkipped`, `@skip`, `pytest.mark.skip`/`xfail`, `t.Skip`) and their per-framework kin;
- added fixed waits in tests (`sleep`, `waitForTimeout`, a bare `setTimeout` promise);
- added or raised retry settings (Playwright `retries`, `jest.retryTimes`, rerun plugins);
- deleted or renamed-away test files, and a net drop in test count where the framework lists tests;
- lowered coverage thresholds;
- edits to check-defining files: CI workflows, test, lint and coverage configs, `package.json` /
  `composer.json` test and lint scripts, reviewer personas, AGENTS.md / CLAUDE.md, skills.

The marker list is keyed on framework API names, which are stable contracts, kept in one named
table per framework. Each flag is evidence with its file, line and pass, never a verdict: P6's
decision that a diff does not mechanically decide weakening stands, and a skip the spec asked for is
legitimate. Flags show as one gate-2 row (gate 3 when no gate-2 decision exists) and as Haive-derived
paths to 07b and 08c, behind the same trust boundary as P6's row. Observe mode logs what enforce would
have blocked; enforce (a later owner decision) would make a flag on an unexplained edit block
approval until the person accepts it with a reason.

- Verification: fixtures per marker class and per framework; a pass that only renames a test
  records delete/add as P6 does; a spec-requested skip is flagged but not blocking; the first 07 pass
  is captured.
- Rollback: additive record and display; turning the mode off hides it.

### P2. Bind every verify and review result to the tree it checked (recommended first)

F5. Stamp the outputs of 08, 08b, 08c, 08c2, 08d and 08a with `changeFingerprint` at the moment the
check read the tree, stored in a task event (step resets clear output). Gates 2 and 3 compare each
stamp with the current tree and mark a result "stale since check" when they differ, naming the step
that changed the tree in between where it is known. Gate 3 also compares against gate 2's decision,
so a manual edit after gate 2 is shown before the commit. Observe mode only shows staleness; whether a
stale blocking check re-runs (as `validation-recheck.ts` does for 07b) or only blocks approval is
D1.

- Verification: a fixture where 08e edits the tree after 08c marks 08c stale; a manual edit between
  gate 2 and gate 3 is shown at gate 3; an unchanged tree shows nothing.
- Rollback: additive events and display.

### P3. A verification stamp on every commit, and gate modes

F6, F7. Two parts, one PR each.

- **Stamp.** At gate 3, record per check: passed, failed, not run, accepted risk, stale (P2), or
  none, plus the round and the Haive build (`aide2-harness-lessons` P0's stamp). Store it in a new
  `tasks` column (a guarded numbered migration, the column declared last) and, per D2, as a commit
  trailer (`Haive-Verification: tests=passed lint=passed browser=not-run review=passed`). Missing,
  partial and not-run stay distinct from pass. `GET /stats/quality` gains a count of commits by
  stamp, `none` included. The commit-message model never writes the trailer; Haive appends it after
  the person approves the message.
- **Modes.** One shared setting per new gate signal (P1 flags, P2 staleness, any later signal):
  `off`, `observe`, `enforce`, admin-set with a GET/PUT route and a toggle card in the admin UI (the
  convention for global config keys). Observe writes a task event recording what enforce would have
  blocked; the statistics module counts them so false positives are reviewed before anyone is
  blocked. An enforced block can be passed with a written reason, which the stamp records.
- Verification: the stamp for a task with a NOT RUN slot says not run; the trailer survives an edited
  message; observe writes the event and blocks nothing; enforce blocks and the reason path passes.
- Rollback: the column is additive (code rollback leaves it unread); the trailer is text; modes
  default to off.

### P4. Flaky tests: a rerun to classify, and an explicit rule

F8.

- **Rule (prompt only).** Add to 08b's fix prompt and `BEHAVIOUR_FIX_LINES`: never skip, add a
  fixed wait, add a retry, or rerun until green to make a failing test pass; if the root cause
  cannot be found, say so in the reply with the evidence, and delete the test only with a written
  reason that the gate shows. Kept out of `DEFAULT_AGENT_RULES`, whose edits need a new hash in
  `KNOWN_DEFAULT_RULES_HASHES`.
- **Rerun.** When 08 or 08b fails, rerun only the failing tests once on the unchanged tree (the
  framework's own filter; where none exists, the slot is not rerun and says so). A failure that
  passes on the rerun is classified flaky: it does not spend a fix round, it shows at gate 2 with
  both outputs, and it joins a per-repository flaky list the next task sees. A failure that fails
  twice proceeds as today. Cost is one extra run per failing slot; the rerun's time is reported.
- Verification: a fixture test that fails on its first run and passes on its second is classified
  flaky and spends no round; a deterministic failure spends one; the rule is in both prompts.
- Rollback: prompt text and an additive classification.

### P5. Property and differential tests in the test prompt

F9. Prompt only. 08b's create step may add, where the changed code has the shape for it and the
repository already has or can use the library:

- property tests for round-trip encode/decode, invariants, idempotent operations and equivalence
  with a naive version (fast-check, Hypothesis, proptest, or the repository's existing tool);
- differential tests for refactor and migration tasks (triage's execution path says which), with
  the fork point's code as the oracle: same inputs to old and new, irrelevant differences normalized,
  intended differences listed in the test.

A new test dependency goes through the dependency policy as any other. Matching the project's test
type stays the default.

- Verification: prompt tests; one live refactor task on the dev stack, checked by hand.
- Rollback: prompt text.

### P6. Grade the review against known bugs, recall by stage (larger; conditional)

F10. Not a separate harness: requirements added to `aide2-harness-lessons` P8, built on the frozen
input harness in `step-benchmark-suite.md`.

- each case pins the tree its reviewer reads and carries a one-sentence answer key; only a finding
  describing that bug scores;
- merged changes that stayed clean are the control set, against over-flagging;
- the tuning set is kept apart from the fixed test set;
- recall is reported separately for raw 08c findings, after the refutation panel, and open at gate
  2, so a bug found and then refuted away is visible;
- a cheap field metric needs no replay: the share of `dismissed_refuted` findings that a person
  re-opened or that a later fix round's diagnosis names (D3 asks whether the gate can re-open one).

Conditional on P8's own trigger. Rollback: tooling only.

### P7. Outcome after merge (conditional)

F11. Record, per task, whether its PR merged, closed unmerged, or was reverted later. Detect a
revert structurally: a later commit on the default branch whose patch is the inverse of the task's
commit (`git patch-id` of the reversed diff), never by the "This reverts commit" message wording,
which is git's human-facing default and is often edited. Write the outcome as a task event; show it
in statistics; surface it to the next task's step 11 on the same repository ("task X's commit was
reverted on DATE"), so a learning can name it. Conditional on P3's stamp, since an outcome is only
useful beside how the change was verified.

- Rollback: additive events; polling stops when the flag is off.

### P8. Provenance and an occurrence bar for learned rules (lower priority)

F12. Add optional provenance fields to global-KB entries, step guidance and repo learnings: the
finding id, gate rejection, PR or revert (P7) that motivated it. Step 11 fills them from its digest.
For suggesting a learning's promotion to a house rule (never for enforcing one), require the
pattern in at least two tasks or a replay in which it is detectable (P6's harness); a person still
activates and an admin still enforces. `occurrences` stays a ranking signal, not evidence, as decided
in `step-guidance.ts`; the bar only decides which drafts are offered.

- Rollback: nullable columns, a migration and a code revert.

### P9. Prune by use (lower priority)

F13. Step 11 is offered, as deletion proposals a person approves, learnings and step-guidance
entries that `usageAssessment` marked unused across the last N tasks that retrieved them (N set in
D4). Nothing is deleted automatically.

- Rollback: proposals only.

### P10. A feature map and richer 08a evidence (lower priority)

F14. Two independent parts.

- **Feature map.** An onboarding-generated, person-edited per-repository map of user-facing features
  (route or screen, selector, expected result), stored in Haive's data directory and read from the
  fork point. 08a uses the entries the change touches as rubric beside the spec's acceptance
  criteria. Overlaps the article's `verify` skill; Haive's 08a is that skill already, so only the
  rubric is new.
- **Evidence.** A step trace (each action, its target, its result) per 08a tester pass, shown at gate
  2 beside the screenshots; videos and HAR stay out of scope.
- Rollback: additive data and display.

## Not adopted

- **A fix cap of three.** Haive's cap is per task and the oscillation guard covers a stuck loop.
- **An Important / Nit / Pre-existing tier.** `low` covers Nit; the scope fence and pre-existing
  markers cover Pre-existing.
- **A second, more expensive reviewer.** The article argues against it too; Haive tunes the one
  fan-out it has.
- **Letting a commit through after two blocks.** Haive's gates are a person's decision, not an
  agent's commit; the reason path in P3 is the escape.

## Open decisions

- **D1.** P2: a stale blocking check re-runs automatically (cost: one more step run) or only blocks
  approval until the person re-runs it.
- **D2.** P3: the commit trailer on by default, opt-in per repository, or not written (column only).
- **D3.** P6: whether gate 2 lets a person re-open a `dismissed_refuted` finding, which the field
  metric needs.
- **D4.** P9: the number of unused retrievals before a pruning proposal.
- **D5.** P1 and P2 from observe to enforce, each on its observed false-positive rate.

## Decided

Nothing yet.

## Critical files

- `packages/worker/src/orchestrator/agent-isolation.ts` (`readPersonaBodies`), `dispatcher.ts`
  (`workerTree` resolution) for P0
- `packages/worker/src/step-engine/steps/workflow/_dependency-policy.ts` (the fork-point read P0
  copies)
- `packages/worker/src/step-engine/steps/workflow/08c-code-review.ts` (`buildPeerPrompt`,
  `agentDefinitionGuidance`, the refutation panel, `isRefutedByPanel`)
- `packages/worker/src/step-engine/steps/workflow/_fix-test-edits.ts`, `_test-paths.ts`,
  `step-runner.ts` (`repairPass`), `dag-executor.ts` for P1
- `packages/worker/src/orchestrator/house-rules-dispatch.ts` (`changeFingerprint`),
  `_gate-house-rules.ts` (`modifiedAfterCheck`), `queues/validation-recheck.ts`,
  `_validation-snapshot.ts` for P2
- `packages/worker/src/step-engine/steps/workflow/09-gate-2-verify-approval.ts`,
  `10-gate-3-commit.ts` for P1 to P3
- `packages/database/src/schema/tasks.ts` (P3's column)
- `packages/worker/src/step-engine/steps/workflow/08-phase-5-verify.ts`, `08b-test-management.ts`,
  `_fix-loop.ts` (`BEHAVIOUR_FIX_LINES`), `_test-env-guard.ts` for P4 and P5
- `packages/worker/src/queues/pr-poll-queue.ts` for P7
- `packages/shared/src/global-kb/schema.ts`, `packages/database/src/schema/step-guidance.ts`,
  `11-phase-8-learning.ts`, `_rag-usage.ts` for P8 and P9
- `packages/worker/src/step-engine/steps/workflow/08a-browser-verify.ts`, `_screenshots.ts` for P10

## Cross-plan dependencies

- `aide2-harness-lessons` P6 owns fix-pass test edits; P1 here extends its capture to first passes
  and adds flags, under P6's rule that a diff is evidence, not a verdict.
- `aide2-harness-lessons` P8 and `step-benchmark-suite` own replay; P6 here only adds requirements.
- `aide2-harness-lessons` P0 (the build on every run) feeds P3's stamp.
- `harness-cadence-by-model` places checks during implementation; P1's flags are one such check's
  input, not a replacement for its measurement.
