# ECC lessons for Haive

> **Not started** 2026-11-27: this file holds findings and phases only. Nothing is approved and nothing is filed on the
> board. The source is github.com/affaan-m/ECC (MIT, v2.2.3, 2026-10-01), a Claude Code plugin pack
> with 72 agents, 328 skills, hooks and a Rust control-plane alpha (`ecc2/`). Every Haive claim was
> read on `main` `5ecf3ec0b` on 2026-11-27. Line numbers are hints and drift, so resolve each reference by its symbol.
> Keep this file current by editing the section a change belongs to. Recommended order: P0 first, because it is a trust gap, not a quality gain. Then P1, then P2. P3 items each wait for
> their own trigger.

## Context

The user asked what Haive could borrow from ECC. ECC is a single-session plugin pack. Most of what
it does, Haive already does as an orchestrator, and more strictly:
- step 11 learnings are admitted by a human and need a file:line;
- the refuter panel must be unanimous and every refutation must cite code;
- the fix loop has a cap and an oscillation guard;
- the stalled-task sweeper and capacity scheduling cover stuck and overloaded runs.

What is left is one trust gap, a review dedupe flaw, and a set of small prompt and criteria changes.
A few ECC ideas were already measured and rejected by sibling plans. Those are listed under Not
adopted with the measurement that rejected them.

Sibling plans: `tokeneconomizer-lessons.md` (in-run loop guard measured and rejected),
`blastloop-lessons.md` (same-level overlap guard parked), `self-improvement-memory-lessons.md` (P1
fix-loop attempts block), `verification-lessons.md` (P1 check-tamper detector, P2 results bound to a
tree), `aide2-harness-lessons.md` (P6 test edits during a fix), `agent-memory-lessons.md`
(consolidation gated on triggers).

## The source

The ECC mechanisms that matter here:

- **Hookify tracked-rule refusal** (`hooks/README.md`). Project-local hook rules that are tracked by
  git are off by default, because "opening a repository must not activate repository-authored
  instructions". Turning them on needs an explicit env flag. Rule messages are labelled untrusted.
  Symlinked, oversized or malformed rule files are skipped, and regexes run with a 25 ms timeout.
- **AgentShield scan** (`skills/security-scan/SKILL.md`; the scanner itself is an external npm
  package and was not read). It reads committed agent config:
  - `CLAUDE.md`: secrets, auto-run phrasing and injection patterns;
  - `settings.json`: `Bash(*)` allows, a missing deny list and bypass flags;
  - `mcp.json`: shell servers, env secrets and `npx -y`;
  - hooks: `${file}` interpolation, exfiltration, and `2>/dev/null` or `|| true`;
  - agents: unrestricted tools.

  It grades the result A to F.
- **GateGuard sensitive targets** (`docs/gateguard/design-notes.md`). An edit is blocked on first touch when its target is:
  - a secrets file, key or credential;
  - auth or payment code;
  - a migration;
  - a file under `.github/workflows/`.

  Paths match by exact segment and are also checked after symlinks resolve. A resolution error counts as sensitive.
- **Review dedupe and verify** (`workflows/orch-review.workflow.js`). Findings from parallel
  reviewers are merged on `file::normalize(evidence)`, the offending code, not the title or line. One
  local run collapsed 11 raw findings to 4. Each CRITICAL or HIGH finding then gets one adversarial
  verifier. The README says the verifier "defaults to refuted on uncertainty", but the code keeps a
  finding blocking unless refuted with confidence 0.8 or higher.
- **Reviewer agents** (`agents/`):
  - `pr-test-analyzer` maps changed code to tests, flags assertions that only check "does not throw" and flaky patterns, and rates gaps.
  - `code-reviewer` has a pre-report gate: can you cite the line, name the failure mode, have you read the callers, can you defend the severity. It also lists known false-positive patterns and states "zero findings is acceptable".
  - `type-design-analyzer` judges encapsulation and how invariants are expressed and enforced.
  - `comment-analyzer` checks comment claims against code.
  - `silent-failure-hunter` looks for swallowed errors and dangerous fallbacks such as `.catch(() => [])`.
- **Required per-criterion rows** (`docs/ASTRA-REVIEW-GUIDE.md`). The reviewer returns one `checks[]`
  row per rubric criterion, and a reply that skips one is rejected.
- **Context-gate checkpoint** (`scripts/hooks/context-gate.js`). At 90% context the agent finishes
  its unit of work and writes a checkpoint with fixed headings:
  - objective;
  - verified facts, kept apart from hypotheses;
  - decisions the operator approved;
  - approaches ruled out, and why;
  - exact next steps;
  - files touched;
  - half-applied changes.
- **Metrics bridge loop detector** (`scripts/hooks/ecc-metrics-bridge.js`, `ecc-context-monitor.js`).
  A ring buffer holds the last 5 tool calls as {tool, sha256 of params} and flags a loop when all 5
  match. The code comment says a threshold of 3 gave false positives on retries and polling. Cost
  warnings fire at $5, $10 and $50.
- **ecc2 budgets and risk** (`ecc2/src/config/mod.rs`, `ecc2/src/observability/mod.rs`):
  - a per-session cost and token budget with alerts at 50%, 75% and 90%;
  - a per-call risk score that sums:
    - tool type;
    - sensitive path;
    - blast radius;
    - irreversibility.

    It maps the score to Allow, Review, Confirm or Block.
- **Cost-aware routing** (`skills/cost-aware-llm-pipeline`, the "Ralphinho" tiering in
  `skills/autonomous-loops`). A work item's size tier picks how many stages run and which model runs
  each stage. The reviewer never wrote the code it reviews.
- **Spec-miner** (`agents/spec-miner.md`). It extracts `Requirement` (WHEN/THEN) and `Invariant`
  records per capability. Each record carries `enforced: File.method()`, a test, its entities and the
  commit it was last verified on. The miner reads a sample and expands from it, stopping after 15
  files or after 3 files in a row that add nothing; unread files are listed as `deferred`. It flags
  uncertainty instead of guessing.
- **Agent proximity** (`scripts/lib/agent-proximity/distance.js`). It scores concurrent agents by
  line-range overlap, file dependency and tree distance, and turns the score into advisory events.
- **Harness promotion gate** (`ecc2/src/harness_eval.rs`). Each config is identified by its sha256.
  A candidate is compared with the baseline on the same seeds, and promotion needs a minimum number
  of samples, a minimum mean gain and a minimum win rate.
- **Instincts** (`skills/continuous-learning-v2`): learned triggers with self-rated confidence,
  written without review. **Memory vault** (`ecc memory`): cross-harness Markdown handoff.

## Findings

### F1. A repository's committed CLI settings load as-is in the sandbox (trust gap)

Haive asks consent before a repository's own MCP servers run. Step 04
(`04-tooling-infrastructure.ts`) keeps a committed `.claude/mcp_settings.json` out of the form unless
the user ticks it. Its text says each definition "is a command the CLI will EXECUTE". Claude runs
with `--mcp-config … --strict-mcp-config` (`sandbox/mcp-config.ts`), and imports are covered by
`mcpServersNeedingConsent` and `holdImportedMcpServerLists` (docs/architecture/mcp-consent.md).

The same repository's `.claude/settings.json` gets no such treatment. The Claude-family args are
`--dangerously-skip-permissions -p … --output-format stream-json` with no `--setting-sources`
(`cli-adapters/steering.ts`, both branches), and nothing in worker or shared reads, scans or masks
a repository's project settings. What a committed file can do:

- **Hooks.** A `SessionStart` hook runs on every dispatch, including steps that run with tools
  disabled (`--tools ""`): onboarding, review, refuters and step summaries. Those are the steps where no repository code would
  otherwise run, and they hold the task auth volume. Default egress is `mode: 'full'`
  (`DEFAULT_CLI_NETWORK_POLICY`, `shared/src/schemas/cli-providers.ts`). `PreToolUse` and
  `PostToolUse` hooks run on every tool call without the model's judgment.
- **`env`.** A settings `env` key can change the CLI's own configuration without running any code.
  One example is a redirected API base URL. *Inferred, unverified*: that the pinned Claude CLI
  applies project-settings `env` to its own endpoint and auth header. P0a checks this.
- **Persistence.** The sandbox mounts the repository root read-write, so an agent prompt-injected in
  one task can write a hook that runs in every later task. Nothing flags a diff that touches agent
  config at the gate.

Haive already applies this principle on the host side. `hardenGitArgs` keeps a repository's
`core.fsmonitor` and git hooks from running (docs/architecture/sandbox-masking.md). It does not yet
apply it to CLI config inside the sandbox.

What weakens the finding: sandboxed agents already run repository code (tests, builds, DDEV), so in
the implement and verify steps a hook adds no new capability class. The real difference is the
no-tool steps, the `env` route and persistence.

Complication: Haive itself relies on the project settings file. When RTK is on, step 07 writes RTK's
`PreToolUse` hook to `.claude/settings.json` (`shared/src/templates/rtk-settings.ts`,
`_rtk-templates.ts`), and the upgrade path manages that file through the template manifest. A user
may also have edited it (`found-not-fixed-sweep-2.md`, "Edited settings.json with RTK off"). Any fix
must keep RTK working and must not rewrite a user's file.

*Not checked*: whether Codex loads a project `.codex/config.toml` in the sandbox, and whether
Gemini loads `.gemini/settings.json` hooks or env from the repository. P0a checks both.

### F2. The 08c refuter dedupe keys on wording, not on the code

`collectRefutable` (`08c-code-review.ts`) merges the peer, security and lens findings into one
refuter dispatch per bug, keyed by `dispatchKey(path, issue)` = `findingFingerprint('', path, issue)`.
That fingerprint hashes the normalised issue TEXT. `review-findings.md` measured the same
fingerprint matching across rounds 5 times in 9,750 findings (0.05%), because two descriptions of
one defect are different sentences.

*Inferred*: two reviewers in the same round who describe one bug in different words also miss each
other. That spends two refuter panels of three lenses each (`REFUTE_LENSES`) on one bug and fills
`MAX_REFUTERS = 10` sooner. Every reviewer schema already requires `snippet` (the
peer, security and lens schemas in 08c), but the key ignores it.

### F3. Nobody independently reviews the diff's tests

`OPERATIONAL_PERSONA` (08c) says "Do NOT review test coverage (a separate step owns it)". That step
is `08b-test-management.ts`, the step that wrote or ran the tests, auditing its own work. The
Testability dimension (`shared/src/review/dimensions.ts`) asks whether code CAN be tested, not
whether this diff's tests test it. No lens maps changed behaviour to the asserting test, flags
no-throw-only assertions, or catches a test that cannot fail. `verification-lessons.md` P1 (a
check-tamper detector) and `aide2-harness-lessons.md` P6 (test edits during a fix) cover tests being
weakened, not tests that were weak to begin with.

### F4. Reviewer prompts ask for volume, not precision

The 08c personas end with "Report EVERY finding". None has a pre-report gate or a list of known
false positives. Each false high finding costs a three-lens refuter panel, and a surviving one costs
a fix round. ECC's code-reviewer gate is prompt-only and cheap.

Do not copy ECC's demotion of HIGH findings at parse time. It conflicts with Haive's fail-closed
stance, where uncertainty keeps a finding blocking.

### F5. A dimension that is enabled but silently skipped looks the same as one that passed

`review-dimensions.md` lists excluded dimensions under `## Not reviewed`. A reviewer that never
mentions an ENABLED dimension produces no finding for it, which reads the same as a clean pass.
ECC's required `checks[]` row per criterion makes the skip visible.

### F6. Small gaps in the dimension criteria

- **Comment claims.** The operational persona asks "did the change leave any comment WRONG?", and Developer
  Experience says "comments only where non-obvious; no TODO". Nothing asks the reviewer to check a
  comment's factual claim against the code it describes.
- **Dangerous fallbacks.** Stability says "no empty catch blocks" and Observability says "no silent
  catches". Neither names the fallback that converts an error into a valid-looking empty value
  (`.catch(() => [])`, an error mapped to `null`), which is not an empty catch.
- **Type invariants.** No dimension or lens asks whether new types make illegal states
  unrepresentable or enforce their invariants. A grep of non-test sources for "invariant" or
  "illegal state" in review prompts found nothing. Value is moderate: most target repositories are
  PHP/Drupal.

### F7. No task-level spend or token budget

`cli_invocations.cost` records each run (`model-pricing.md`), but a grep for a cap (`maxCost`,
`costCap`, `spendLimit`, `budgetUsd`) across `packages` finds nothing. A task can spend without
limit until its round caps stop it. Most runs are subscription-billed: on the dev install, 29.63 USD
was real and 3,236 USD notional (`model-pricing.md`). A budget on billable cost alone would almost
never fire, so it must also count tokens or notional cost.

### F8. Triage picks the path, not the model

`00-triage.ts` classifies a task as `quick_bugfix`, `plan_tasklist` or `full_workflow`, and that
choice sets which steps run. Model and effort stay per-step user choices (`effortLevel`,
`local_model_override` in `shared/src/schemas/tasks.ts`). ECC ties tier to model per stage.
*Inferred*: a triage-derived default for model and effort per step, overridable as today, is a small
change. `harness-cadence-by-model.md` and `aide2-harness-lessons.md` (cheaper models on narrow
seats) already own the measurement side, so this finding is only the triage-to-default wiring.

### F9. Fix-round and ledger recaps have no fixed headings

`self-improvement-memory-lessons.md` P1 (not started) plans a fix-loop attempts block: root cause,
change, and predicted versus observed targets. ECC's checkpoint headings map onto it directly:
- "verified facts versus hypotheses" maps to observed versus predicted;
- "ruled out, and why" maps to the failed attempts.

The same headings suit `task-ledger.ts` recaps, which are free-form within a 4,000-character budget.

*Inferred gap*: nothing asks a long run for a checkpoint before a timeout or budget kill, so a killed
07 implement run loses its reasoning. Measure first how often kills land mid-work.

### F10. Smaller items, each gated

- **Spec-miner records.** `08-knowledge-acquisition.ts` writes 15-30 topic KB entries (architecture,
  testing, conventions, domain). These are not behavioural contracts pinned to code. Requirement and
  Invariant records with an `enforced` location and a verified-at commit could feed
  `05-phase-0b5-spec-quality.ts` and give review a list of invariants to check.
- **Concurrent tasks on the same files.** This is the same question as `blastloop-lessons.md` P2 (an
  overlap guard), which is parked on that plan's P0 data (`dag_issue.merge_conflict` events). It is
  not a new item; ECC's proximity score is one possible scorer if that data reopens P2.
- **Risk flags as reviewer attention.** Instead of ECC's gate on each call, apply its sensitive-path
  list (CI workflows, migrations, secrets, agent config) to the diff as attention flags. Folded into
  P0d.
- **MCP tool-description pinning.** `mcpServersFingerprint` pins server definitions, not the tool
  descriptions a server returns, so a server can change what its tools say after consent. ECC lists
  this as roadmap only. It needs a live tool-list fetch.
- **A promotion gate for harness configuration.** A sha256 identity per prompt or template version
  and a min-samples, min-gain, min-win-rate rule on fixed inputs would formalise
  `aide2-harness-lessons.md`'s grading of prompt changes. It is a convention, not new machinery.
- **Cross-repository promotion suggestion.** Flag a `step_guidance` item active in 2+ repositories
  as a global-KB candidate at 11e, never automatically. `agent-memory-lessons.md` M6 measured 0
  `step_guidance` rows, so this waits for rows.
- **Evaluation mode actually reached.** ECC's gan-evaluator reports the mode it actually ran, not the
  one requested (for example, a browser check that fell back to a static read). *Not checked*:
  whether `08a-browser-verify.ts` already does this. Check before filing.

## Phases

Each item is one PR unless stated. Every PR follows the usual process: a worktree, a control that
fails on today's code and passes after, reviewers, CI, and the live check named in its section.

### P0. Repository-authored CLI config (recommended first)

**P0a. Live checks before design (no code).** Run each check in a throwaway sandbox against the
pinned CLI versions, using a scratch repository that commits:
- a `.claude/settings.json` with a `SessionStart` hook that touches a marker file, and an `env` key
  that points the API base URL at a local listener;
- a `.codex/config.toml` with a distinguishable setting;
- a `.gemini/settings.json` with a hook.

Record for each CLI whether the hook ran, whether the `env` reached the CLI's own requests, and whether the auth header went with it.
Also confirm that the pinned Claude CLI supports `--setting-sources` and `--settings <file>`, and how they interact with `-p`. The results decide P0b's shape and are written into F1.

**P0b. Neutralise project CLI settings by default.** The recommended design, to be confirmed by P0a:
1. Move RTK's hook out of the repository file. Render it into a Haive-owned settings file passed with
   `--settings` (or into the sandbox's user-level settings). Leave the manifest-tracked
   `.claude/settings.json` in place for the upgrade path.
2. Run Claude-family CLIs with `--setting-sources user` (the exact value comes from P0a), so project and local
   settings stop loading.
3. Apply the equivalent per CLI that P0a shows loads project config. For CLIs with no flag, mask the
   file with an empty read-only bind, as `agent-definition-mask.ts` already does for agent
   directories, but fail closed.
4. Repositories that need their own hooks get an opt-in on the tooling settings page. It works like
   step 04's MCP consent: the user ticks a box over a fingerprint of the hooks, env and permissions
   keys, the fingerprint is stored, and any change re-asks.

**Rollback:** a `CONFIG_KEYS` kill-switch restores today's args with no data change; RTK's moved hook keeps working under either setting.

**Live check:** P0a's scratch repository leaves no marker file, and RTK still rewrites commands.

**P0c. Agent-config report at onboarding.** A deterministic, read-only step modelled on
`07_7-secret-sweep`: it never edits, and it reports once per repository. It lists, for the human at
the gate and for P0b's consent form:
- each committed hook command and its event;
- each settings `env` key;
- permission allows;
- MCP commands that P0b did not already hold;
- rules-file phrasing that asks for automatic execution.

No A-to-F grade and no autofix.

**P0d. Flag sensitive paths in the diff at the gates.** Gate 2 and gate 3 show a fixed row when the
task diff touches:
- `.github/workflows/`;
- `.claude/settings*.json` or other agent hook and config files (`.codex/`, `.gemini/`, `.mcp.json`, `.claude/agents/`, skills);
- migrations;
- secret-pattern paths.

The flag is an attention marker, not a block. It also stops an agent persisting a hook for the next run without the human seeing it.

**P0e. Credential scan of Haive's own commit.** Before `10-gate-3-commit` commits, run the
`_credential-scan.ts` patterns over the staged diff and show hits in the gate's form. Do not block
silently, and never print the matched value.

### P1. Review precision (one PR per item)

1. **Dedupe on the snippet (F2).** `dispatchKey` keys on path plus the whitespace-normalised
   `snippet` and falls back to `issue` when the snippet is absent or too short to be distinctive.
   The key is a hash and never enters a prompt (a snippet may be a credential, see 08c's security
   schema note). The per-reviewer `findingFingerprint` in `review_findings` is unchanged.
   **Control:** two findings with different wording and the same snippet dispatch one panel.
   **Measure:** refuter dispatches per review pass, from stored rows, before and after.
2. **Test-quality lens (F3).** Add a level-gated entry to `REVIEW_LENSES`. It maps each changed
   behaviour to an asserting test, and flags:
   - no-throw-only assertions;
   - tests that cannot fail (asserting a mock's own return);
   - timing-dependent tests;
   - missing error-path tests.

   Findings go through the same refuter panel. Keep it out of 08b, which must not grade itself.
   Coordinate with `verification-lessons.md` P1 so the two do not report the same edit twice.
3. **Pre-report gate in reviewer prompts (F4).** Add one shared block to the 08c, 07b and 08d personas:
   - cite the line;
   - name the concrete failure;
   - confirm the callers were read;
   - defend the severity;
   - check a short list of known false-positive shapes;
   - "no findings is a valid answer".

   Keep "Report EVERY finding" for findings that pass the gate. **Measure:** refuted-finding rate and refuter
   dispatches over the next N review passes against the prior N.
4. **One row per enabled dimension (F5).** The reviewer reply carries `checks: [{ dimension,
   status: pass|finding|not-applicable, note }]` for every enabled dimension. A missing row marks
   the review incomplete through the existing `incompleteReviewIssue` path rather than as a pass.
   Update the parked form-schema back-fill if the gate renders it.
5. **Criteria lines (F6).** Developer Experience gains "a comment's factual claim matches the code
   it describes". Stability gains "no fallback that turns an error into a valid-looking empty value
   (empty list, null, default object) unless the spec asks for it". Type invariants become an
   optional criterion under Maintainability, worded for typed languages and skipped otherwise.
   This is a `dimensions.ts` edit only; check whether any prompt hash or pinned text covers these
   strings before changing them.

### P2. Spend and routing

1. **Task budget (F7).** Add a per-task budget on tokens and on cost, counting real plus notional
   cost, because subscription runs are notional. It has 50/75/90% alerts on the task page and a
   park, not a kill, at 100%: the task waits in a resumable state with a banner, like the existing
   capacity parks. The default is off; a per-user default and a per-task override live in settings.
   Design questions for the PR: which spend counts (sub-agents, refuters, summaries), and how a
   park at 100% interacts with step ownership (`worker-restarts.md`).
2. **Triage-derived model defaults (F8).** The `00-triage` result picks a default model and effort
   per step from a table, and the user's per-step choice still overrides it. Gated on
   `harness-cadence-by-model.md` P0's measurement for which seats tolerate a cheaper model; without
   that data, this ships only the wiring with today's defaults in every row.

### P3. Triggered or later

1. **Checkpoint headings (F9).** Use ECC's headings as the fixed structure of
   `self-improvement-memory-lessons.md` P1's attempts block and of ledger recaps. Ship with that P1,
   not separately.
2. **Checkpoint before a kill (F9).** First measure, from stored invocations, how many 07 runs were
   killed by a timeout while still editing. Build a pre-kill checkpoint steer (Claude family and
   codex only, see `steering.md`) only if that number is material.
3. **Spec-miner records (F10).** An optional onboarding step or 08 variant that writes Requirement
   and Invariant records with an `enforced` location and a verified-at commit. Needs an owner
   decision on where they live (KB entries with a type, or a new table) and on how review consumes
   them.
4. **MCP tool-description pinning (F10).** After P0. Needs a tool-list fetch at consent time and at
   dispatch.
5. **Harness promotion convention (F10).** Fold into `aide2-harness-lessons.md`'s prompt grading
   when it is built.
6. **Cross-repository promotion suggestion (F10).** Waits for `step_guidance` rows
   (`agent-memory-lessons.md` M6).
7. **Evaluation mode reached (F10).** Check `08a-browser-verify.ts` first. File only if it reports
   the requested mode rather than the mode reached.

## Not adopted

- **In-run tool-loop detector** (ECC's 5-identical-calls ring buffer). `tokeneconomizer-lessons.md`
  replayed a richer loop rule on stored runs: tokens spent after a stuck point were at most 1.6% on
  574 loop-prone claude runs and about 1.0% on 842 codex runs, both upper bounds. ECC's rule only
  fires on exact repeats, a subset of those cases. Steering, the stall badge, `loadSameCheckRepeat`
  and DAG stuck detection already cover the visible cases. Reopen only if a replay of ECC's exact
  rule on current stored logs finds materially more than that bound.
- **Instincts** (continuous-learning-v2). Self-rated confidence, written without review. This breaks
  the rule that learning counts only outcomes the host observes (`self-improvement-memory-lessons.md`), and the 2026-11-19
  memory pilot measured no benefit (`agent-memory-lessons.md`). The decay it documents is not
  implemented in its own scripts.
- **Memory vault, strategic compact, memory-persistence hooks.** Haive already moves context between
  CLI families centrally (`task_events`, the ledger), and every step is a fresh process at a phase
  boundary.
- **Per-call risk gate** (ecc2 `compute_risk`). The sandbox already bounds blast radius; the useful
  part, its sensitive-path list, is P0d.
- **Verification-loop, eval-harness, agent-evaluator and GAN scoring rubrics.** Run-based checks
  already exist (07b, 08, 08a, 08b), and an LLM 1-10 score is weaker evidence than a refutation that
  cites a file and line.
- **ECC's adversarial verifier.** Haive's unanimous three-lens panel is stricter. ECC's regex
  trigger for running a security reviewer is a step down from Haive, which always runs one.
- **The silent-failure-hunter agent.** Existing criteria and the operational persona cover it; the
  one addition is the P1.5 criteria line.
- **ecc2 heartbeat and stale-session check.** It checks only that a process is alive.
  `StalledTaskSweeper` and the worker-restart recovery go further.
- **MCP connector policy.** Already aligned: step 04 defaults to chrome-devtools only, with per-repo
  opt-in.

## Open decisions

1. P0b: neutralise by default with an opt-in over a fingerprint (recommended), or consent at
   onboarding with project settings left on? The recommendation follows step 04's MCP precedent, under which code
   the repository authored stays off until a human accepts it.
2. P0b: where RTK's hook lives once it leaves `.claude/settings.json`: a Haive-owned `--settings`
   file per dispatch (recommended, versioned with the image) or the sandbox user's settings.
3. P2.1: does reaching 100% of the budget park the task (recommended) or warn only?
4. P3.3: where spec-miner records live, if built.

## Critical files

- `packages/worker/src/cli-adapters/steering.ts`: Claude-family args (P0b).
- `packages/shared/src/templates/rtk-settings.ts`,
  `packages/worker/src/step-engine/steps/onboarding/_rtk-templates.ts`,
  `07-generate-files.ts`: the RTK hook (P0b).
- `packages/worker/src/step-engine/steps/onboarding/04-tooling-infrastructure.ts`,
  `packages/worker/src/sandbox/mcp-config.ts`: the consent precedent (P0b, P0c).
- `packages/worker/src/queues/cli-exec/agent-definition-mask.ts`, `exec-core.ts`: masks (P0b).
- `packages/worker/src/step-engine/steps/onboarding/07_7-secret-sweep.ts`, `_credential-scan.ts`:
  the report pattern and scanner (P0c, P0e).
- `packages/worker/src/step-engine/steps/workflow/10-gate-3-commit.ts`: commit scan (P0e).
- `packages/worker/src/step-engine/steps/workflow/08c-code-review.ts`: `dispatchKey`,
  `collectRefutable`, `REVIEW_LENSES`, the personas (P1).
- `packages/shared/src/review/dimensions.ts`: criteria (P1.5).
- `packages/worker/src/step-engine/steps/workflow/00-triage.ts`, `shared/src/schemas/tasks.ts`:
  triage defaults (P2.2).
- `docs/architecture/mcp-consent.md`, `sandbox-masking.md`, `review-findings.md`,
  `review-dimensions.md`, `model-pricing.md`: topics to update with each phase.

## Verification

- P0a results are written into F1 before P0b starts.
- P0b: the scratch repository's hook and env have no effect under the default; RTK still rewrites
  commands; the opt-in restores the hook, and changing the hook re-asks. Kill-switch tested.
- P0c and P0d: a fixture repository with each config kind appears in the report and the gate row.
  A diff touching `.github/workflows/` shows the flag.
- P0e: a generated test secret in a staged file is reported by kind, and its value never appears.
  Test secrets are generated, never literals (owner rule).
- P1.1: dispatch count drops on a fixture with two reworded findings sharing one snippet, and
  distinct snippets in one file still get separate panels.
- P1.3 and P1.4: measured over the next review passes against the prior ones, as stated in each item.
- P2.1: a task crossing each threshold shows the alert, parks at 100%, and resumes after a raise.
