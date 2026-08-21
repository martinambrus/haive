# Scope-fence the blocking reviewers

## Context

Across 102 benchmark runs of the same task ("Add DDEV", 2026-06-14 → 2026-08-08) the gating
reviewers spent most of their effort on legacy application code the task never touched —
FCKeditor connectors, `functions.php`, `thememanager.php`, `mods/admin_class_db_backup.php`,
`js/jquery-1.2.3.min.js`. This is not model overreach. `08c-code-review.ts:498-501` explicitly
instructs it:

> 'Report EVERY finding in full — **including pre-existing, low-severity, and dead-code ones**'

and the onboarded `.claude/agents/security-code-reviewer.md` (from `_agent-templates.ts:1379,
1406,1428,1433`), which overrides the embedded persona via `agentDefinitionGuidance`, repeats it
four more times including as an anti-pattern ("DO NOT omit pre-existing … findings").

Measured on `review_findings`, excluding every path the task legitimately touched
(`.ddev/*`, `installer/*`, README, `.gitignore`, `aliases.ser`):

| reviewer | in-scope | legacy app | legacy **blocking** | legacy @ round ≤1 |
|---|---|---|---|---|
| security-code-reviewer (08c) | 1196 | 1067 | **206** | 197 |
| validator (07b) | 1169 | 824 | 0 | 97 |
| peer-reviewer (08c) | 986 | 474 | **142** | 76 |
| operational-reviewer (08c) | 1166 | 360 | **101** | 60 |
| code-auditor (08c2) | 291 | 123 | 0 | 25 |
| adversarial-qa (08d) | 29 | 0 | 0 | 0 |

Every provider does it, so this is systemic, not a Codex quirk. Off-scope share of security
findings at round ≤1, before the working tree is polluted: codex xhigh 86%, ollama 71%,
claude-code medium 71%, claude-code max 70%, claude-code high 68%, codex high 68%,
claude-code xhigh 38%, codex low 25%.

Three costs, in order of severity:

1. **`in_scope` is collected and discarded.** The prompt asks for it
   (`08c-code-review.ts:674`), zod parses it (`:140`), the type carries it (`:71`) — and nothing
   reads it. `computeBlocking` (`:225-236`) keys on severity alone, so a finding the reviewer
   itself marked `in_scope: no` still routes the change back through implementation and spends
   one of the capped fix rounds. ~450 blocking findings across reviewers sat on untouched
   legacy code.
2. **Each blocking finding also spends a refuter agent** (`collectRefutable` → `MiningWaveError`
   at `:1020-1027`), so out-of-scope findings burn a second agent invocation each before they
   are dismissed or — more often — stand.
3. **The fix loop then rewrites the legacy app**, which widens every later round. 07b's
   validator↔fixer loop edits files directly with no refutation and no gate. In one live
   `feature-add-ddev` worktree: 71 dirty files, `functions.php` +1257 lines,
   `actions/form_submit.php` +454. Those files then enter `collectImplementationFiles`
   (`_impl-changes.ts:48`, via `git status --porcelain`) and are handed to the *next* round as
   "Changed files to review (read each in full)" — one real prompt listed 84 files where the DAG
   plan had recorded 23. Tasks reached fix round 17-18 and failed.

Intended outcome: reviewers still see and report pre-existing problems, but a finding outside the
change stops costing a fix round, a refuter, and a legacy-code rewrite.

## Explicitly NOT changing

- **`08c2-code-audit`** — broad by design, report-only, non-blocking, `tasks.broad_audit`-gated,
  and it earns real fixes. Leave its breadth alone.
- **`04a-spec-audit`** — same rationale on the spec side.
- **07b Step 4** (`WHOLE CODEBASE` stale-caller search) — correctly repo-wide; the query is
  narrow ("is the old name still called anywhere") and a stale caller *is* in scope.
- **`code-reviewer` / `security-auditor` agent templates** — installed for the user's own
  `/review`, never dispatched by the gating chain.
- **`_impl-changes.ts`** — no change. The pollution is a *consequence* of the unscoped findings
  (round-≤1 data shows reviewers go off-scope with a clean file list). Fixing the cause should
  drain it; filtering the dirty list would risk hiding genuine edits. Re-measure after landing.

## Design

One shared prompt fragment, two dispositions, following the `_qa-lenses.ts` precedent — a single
source of truth imported by both the inline prompts and the generated agent templates so the two
cannot drift.

New `packages/worker/src/step-engine/steps/_scope-fence.ts` exporting:

- `SCOPE_FENCE_INSIGHTS` — for peer / operational / performance / simplicity / validator.
  Wording mirrors what `08c2-code-audit.ts:61-63` already does: findings are problems with
  *this change*; valid-but-unrelated observations go in the `## INSIGHTS` block, never in
  `findings`. `INSIGHTS_INSTRUCTION` is already appended at every one of these call sites, so
  the sink exists.
- `SCOPE_FENCE_IN_SCOPE_FLAG` — for security only. Keeps the "author needs full information"
  intent: still report a pre-existing vulnerability in full, but mark it `in_scope: "no"`, and
  state plainly that `no` means advisory-only, not ignored. Reserve `yes` for code this change
  introduced or altered, and for a path this change makes newly reachable.

Both fences state the boundary the same way: **in scope = the changed files, plus code whose
contract this change alters** (the blast-radius rule 08c2 already uses).

### Enforcement (the half that makes the prompt stick)

In `08c-code-review.ts`:

- Add `isOutOfScope(f)` — true only when the reviewer explicitly said so (`in_scope` normalises
  to `no`/`false`). Absent or unreadable ⇒ **in scope**, so a reviewer that ignores the field
  keeps today's behaviour and nothing silently stops blocking.
- `computeBlocking` skips out-of-scope security findings.
- `collectRefutable` skips them too — no refuter agent spent on a finding that cannot block.
- The fix-loop diagnosis (`live(out.security.findings)`, ~`:745-765`) excludes them, so the
  implementer is never handed legacy work.
- `recordReviewFindings` still writes them, with `blocking: false`. They stay visible at gate 2
  as advisory — this is the security-specific carve-out and it is the whole point of keeping the
  field rather than deleting it.

`hasNonApprovingVerdict` is untouched: a bare `VULNERABLE` still holds gate 2 off its approve
default, which is the existing de-silencing behaviour.

## Files

| file | change |
|---|---|
| `steps/_scope-fence.ts` | **new** — the two fence constants + the shared boundary definition |
| `steps/workflow/08c-code-review.ts` | `SECURITY_PERSONA`: drop the "including pre-existing, low-severity, and dead-code ones" license, splice `SCOPE_FENCE_IN_SCOPE_FLAG`. `PEER_PERSONA` / `OPERATIONAL_PERSONA` / `PERFORMANCE_PERSONA` / `SIMPLICITY_PERSONA`: splice `SCOPE_FENCE_INSIGHTS`. Add `isOutOfScope`; wire into `computeBlocking`, `collectRefutable`, the fix-loop diagnosis, and the `blocking` flag passed to `recordReviewFindings` |
| `steps/workflow/07b-phase-4-validate.ts` | `VALIDATOR_DEFINITION`: splice `SCOPE_FENCE_INSIGHTS` into the Step 3 / Step 7 reporting rules so the validator↔fixer loop stops editing unrelated legacy code. Steps 4 and 5 unchanged |
| `steps/onboarding/_agent-templates.ts` | `security-code-reviewer` (`:1374,1379,1406,1428,1433`), `peer-reviewer` (`:1294`), `operational-reviewer` (`:1439`), `performance-reviewer` (`:1504`): same fence text from the shared module, so the on-disk agent def agrees with the inline persona |
| `steps/workflow/08c-code-review.test.ts` | new cases (below) |

**Template versioning:** body-only edits per `CLAUDE.md` rule 1 — **do not bump `schemaVersion`**.
`contentHash` recomputes on worker boot and every onboarded repo will correctly report these four
agents as changed in upgrade-status. Expect that; it is the delivery mechanism.

## Verification

1. `pnpm typecheck` and `pnpm test` in the worker container (per-container node_modules).
2. New unit tests in `08c-code-review.test.ts`:
   - `in_scope: "no"` + `severity: critical` ⇒ `computeBlocking` false, finding still recorded
     with `blocking: false`;
   - `in_scope` absent + `severity: critical` ⇒ still blocking (no silent regression);
   - `in_scope: "no"` ⇒ not in `collectRefutable`, so no refuter is dispatched;
   - out-of-scope findings absent from the fix-loop diagnosis text.
3. Restart worker (rebuilds `@haive/shared` + `@haive/database`), confirm boot is clean and
   `assertCliDispatchListInSync` still passes.
4. End-to-end: re-run "Add DDEV" against the same repo on **codex xhigh** — the worst offender at
   86% off-scope. Success criteria, queried the same way as the table above:
   - legacy-app **blocking** findings at round ≤1 → near zero;
   - max fix round well under the 17-18 observed;
   - `git status --porcelain` in the worktree stays close to the DAG's `filesModified` count
     (23) rather than ballooning to 71+;
   - security still reports the legacy vulnerabilities, now as `in_scope: no` advisory rows —
     verify they are present in `review_findings` with `blocking = false`, not missing.
5. Compare against one **claude-code high** run (68% off-scope) to confirm the fix is not
   provider-specific.

## Rollback

Pure prompt-text and predicate changes; no migration, no schema change, no config key. Revert the
commit and restart the worker — the next review round reverts to today's behaviour. Already-written
`review_findings` rows are unaffected either way (`blocking` is historical telemetry, never re-read
as state). The one visible residue is upgrade-status reporting the four agent templates as changed;
reverting flips their `contentHash` back on the next worker boot.

---

# Amendment — 2026-08-21: unbuilt; premise intact, anchor moved

Unbuilt — no `_scope-fence.ts` exists anywhere in the tree.

The instruction the whole plan rests on is still present verbatim, but has moved: it is at
`08c-code-review.ts:655-657`, not `:498-501` (which is now the refuter prompt builder added by the
later refutation pass). The text is unchanged — "Report EVERY finding in full — including
pre-existing, low-severity, and dead-code ones". `08c-code-review.ts:674` and
`_agent-templates.ts:1379` still resolve as cited.

Note the interaction the body predates: 08c now runs a refutation wave over blocking findings, so
some of the noise this plan targets is already being filtered — but refutation only disproves a
finding, it never suppresses one for being out of scope, so the plan is not made redundant.

---

# Amendment — 2026-08-21: shipped (`3415278`)

Shipped as written, with three departures from the body and two additions it did not list.
Do not re-implement from this plan.

## What differed, and why

**Three fence constants, not two.** The body says `SCOPE_FENCE_INSIGHTS` covers "peer /
operational / performance / simplicity / validator" on the grounds that "`INSIGHTS_INSTRUCTION`
is already appended at every one of these call sites, so the sink exists". That holds for the
five 08c personas — they all route through `reviewAssignment`, which appends it — but **not for
07b**, which is not one of `INSIGHTS_INSTRUCTION`'s call sites at all, and whose
`outputContract()` requires the JSON to be "the FINAL thing in your response", directly
contradicting the shared instruction's "after your main output". Pointing the validator at
`## INSIGHTS` would have named a block whose line format it was never given, so `parseInsights`
would have dropped every line silently. 07b therefore gets a third disposition,
`SCOPE_FENCE_REPORT_ONLY`: the sink is its own markdown report (which reaches the human at
gate 2) while `issues` — the only thing the fix agent receives — is fenced. It carves out Step 4
explicitly, since a stale caller of something this change renamed is in scope wherever it lives
and the validator's protocol requires it to be fixed.

**`isOutOfScope` lives in `_scope-fence.ts`, not `08c-code-review.ts`.** Gate 2 needs the same
predicate (see below) and should not import it from a step module. The fence module now owns
both halves of one contract — the instruction and its enforcement.

**Spliced at the end of `VALIDATOR_DEFINITION`, not into "the Step 3 / Step 7 reporting rules".**
It sits immediately before the "You may fix what your protocol REQUIRES you to fix" paragraph,
which is the paragraph about what may be edited, so the fence and its carve-out read as one rule
rather than being buried mid-protocol. Steps 4 and 5 are unchanged as the body requires.

## Two changes the Files table did not list

**`in_scope` moved from `z.string().optional()` to `z.unknown().optional()`.** A security
reviewer answering `false` instead of `"no"` would have failed the whole `securitySchema` parse —
not one field, the entire review, which then degrades to a synthetic non-blocking finding and
loses every real one. Harmless while nothing read the field; not a landmine to leave under a
field that now decides whether a change is reimplemented. This matches the file's own established
convention for `severity` and `cwe` ("a strict enum would fail the whole finding rather than the
one field"). `isOutOfScope` normalizes instead, and the raw value is still stored verbatim on the
finding so `review_findings.raw` records what the reviewer actually said.

**`09-gate-2-verify-approval.ts` renders `[pre-existing]` beside `[refuted]`.** Not in the Files
table, but the body's own claim is that fenced findings "stay visible at gate 2 as advisory" — and
without a marker a `[critical]` that did not block reads as an inconsistency rather than as the
advisory it is. That is the same reason `refutedTag` exists. Three lines, mirroring it exactly.

Also added: `securityOutOfScope` in the step's completion log, so the fence can be measured from
the logs rather than only from `review_findings`.

## Left alone deliberately

- **`_task-history-digest.ts`** skips `refuted` findings but not fenced-out ones. A refuted
  finding was disproved against the code; a pre-existing one is real, and the learning agent may
  legitimately want it in the KB. Different questions, so the digest keeps the wider set.
- **`adjustVerdict`** still counts fenced criticals as blocking-severity, so a `VULNERABLE`
  verdict is not downgraded when only pre-existing findings remain — gate 2 stays off its approve
  default. Conservative, and strictly better than today, where those same findings also block.
- Everything in the body's "Explicitly NOT changing" list, including `_impl-changes.ts`.

## Verification — what it did and did not cover

Done, in the worker container (per-container node_modules): `tsc --noEmit` clean; 2904 tests pass
across 235 files, 22 of them new; prettier clean; worker restarted twice with zero level-40+ logs,
`haive-worker ready`, and `assertCliDispatchListInSync` passing. The rendered on-disk agent files
were inspected, and a test asserts all five dispatched 08c reviewer prompts plus both 07b
validator passes carry the fence — the delivery mechanism, not just the constant. Template
`contentHash` recomputed on boot with `schemaVersion` still 2 for all four agents, as required.

**Not done — this is the measurement the plan hangs on.** Verification steps 4 and 5, the
end-to-end "Add DDEV" re-runs on codex xhigh (86% off-scope) and claude-code high (68%), are live
benchmark runs and were not executed. Until they are, the success criteria — legacy-app blocking
findings at round ≤1 near zero, max fix round well under 17-18, `git status --porcelain` close to
the DAG's 23 rather than 71+, and the legacy vulnerabilities still present in `review_findings`
with `blocking = false` rather than missing — are unmeasured.

Separately, no repository on the dev install carries `onboarding_artifacts` rows, so the
"upgrade-status reports these four agents as changed" path was verified only on the
`template_manifest_cache` side.
