# When Haive's checks run: harness cadence by model

> **Not started** (2026-10-13). One source is reviewed: Naresh Jain, "Are Harnesses Worth the
> Cost?", martinfowler.com, 13 October 2026. Nothing here is approved. P0 is a measurement and gates
> P1; P2 is parked. The test-edit half of the article is already planned as `aide2-harness-lessons`
> P6 and is not repeated here. Keep this file current by editing the section a change belongs to.

## Context

The user asked what Haive could take from the article. Every Haive claim below was read on `main`
`cc786ca0f` on 2026-10-13; none was measured on the dev install yet.

## The source

A greenfield Java BFF (HTTP API, a downstream Order API, Kafka, deferred creation with a 202 and a
monitor link, exact 429/503/502/400 error contracts) was built 10 times per arm in isolated
containers and judged by 178 acceptance tests the implementer could not see. The harness was
guides before the agent acts (OpenAPI/AsyncAPI specs, request/response examples, an API skill) and
sensors after it acts (contract conformance, API tests on HTTP values and side effects, coverage),
run continuously during implementation. Both models ran at low reasoning effort.

| Model | Arm | Accepted | Tokens | Time | Est. cost |
|---|---|---|---|---|---|
| GPT-6 Sol (frontier) | harness | 10/10 | 11.3M | 19m 53s | ~$2.68 |
| GPT-6 Sol (frontier) | none | 10/10 | 1.08M | 6m 51s | ~$0.41 |
| GPT-6 Luna (cheap) | harness | 10/10 | 22.9M | 35m | ~$0.27 |
| GPT-6 Luna (cheap) | none | 3/10 | 5.86M | 15m 56s | ~$0.09 |

- Unharnessed Luna passed 94.8% of checks on average; every failed app passed at least 144/178. The
  misses sat at seams: the timeout boundary of deferred creation, missing monitor links, an extra
  Kafka header and a `null` field, a 415 where 400 was specified, and an env-var name mismatch
  (`ORDER_API_API_KEY` read, `ORDER_API_KEY` supplied).
- The author's name for the mechanism is "executable attention": a requirement stated in the brief
  loses influence during implementation, and a red sensor brings it back.
- Recommendation: continuous checks for cost-optimised models with inconsistent results; for a
  frontier model keep the independent acceptance check but run it once as a final gate. "What
  changes with model capability is not whether independent sensors are needed, but when they run."
- The agent must not weaken an expectation to turn a check green.
- Caveats the author states: 10 runs per arm, one service, one language, low effort, an unusually
  detailed brief; costs are API-equivalent estimates and exclude writing and maintaining the
  harness; guides and sensors were added together, so their shares are unknown.

## Findings in Haive

- **F1. Haive's sensors run only as a final gate, for every model.** 07 (`07-phase-2-implement.ts`)
  is given no verify or test command: its prompt names a command only for the browser re-check on a
  fix round (`browserVerify`). The checks run afterwards as separate steps (07b review, 07c DDEV
  reconcile, 08b tests, 08 verify, 08c review) and reach 07 only through `loop_back`, one round
  later, in a fresh CLI process (`docs/architecture/fix-loop.md`). That is the article's frontier
  arrangement, applied to every model. What 07 does get is generic: the default agent rules
  prepended to every prompt dispatch (`docs/architecture/agent-rules.md`) include "Own the
  verification" (`DEFAULT_AGENT_RULES`, `shared/src/constants/default-agent-rules.ts`), which asks
  the agent to run the tests and a type check this environment can run. So the gap is not "no
  verification asked" but "no exact commands, and nothing Haive classifies or records": the agent
  guesses the commands, and for a DDEV repository it cannot run them at all, since the sandbox has
  no `ddev exec` (`docs/architecture/ddev-runtime.md`).
- **F2. Some of the commands to hand over exist before 07, some do not.** A repository's declared
  commands are read by `loadDeclaredVerifyCommands` (`_task-meta.ts`) and shown by `06-run-config`;
  08 resolves detected ones (`08-phase-5-verify.ts`). Both exist before 07 runs. 08b's file-scoped
  selective test command does NOT: `buildSelectiveCommand` takes the files 08b's own tester reported
  creating or updating, so it exists only after 08b has run, and reaches a later fix round as
  `testRun.command` in the diagnosis. None reaches 07's initial pass.
- **F3. Haive has no notion of a model tier.** No symbol classifies a model as frontier or cheap.
  Deriving one from a model id would key logic on a value that changes with every release, so a
  tier has to be an explicit setting, not a lookup.
- **F4. Spend per step is already recorded** (`docs/architecture/model-pricing.md`,
  `docs/architecture/statistics.md`), and `fix_loop.requested` events count rounds. The article's
  comparison (acceptance, tokens, time, cost per arm) can be read from existing rows.
- **F5. Checks no agent can repair already stay out of the loop**: `classifyTestEnvFailure`, the
  enumerate guard, and the NOT RUN verify slots. The article does not address this; Haive is ahead
  here, and P1 must keep it: a check that is NOT RUN at 08 must reach 07 as NOT RUN, never as a
  defect to fix.
- **F6. Expectation weakening is `aide2-harness-lessons` P6.** 08b's `DECIDE_PER_FAILURE` lets the
  tester decide the test is wrong. P6's cheap half (a prompt line plus a host-side record of test
  edits per fix pass, shown at gate 2) is the plan for that; this article is a second source for it,
  nothing more.

## Phases

### P0. Measure the gap before building anything

Pick one finished workflow task with a detailed spec on a NON-DDEV repository with declared verify
and test commands, so every command can run inside the sandbox and P0 needs no bridge (P1 covers
DDEV). Re-run it from the same base on the dev install, 07 on a cheaper model, in two arms:

- **A:** as today, which includes the default rules' generic "Own the verification" instruction
  (F1). A therefore measures generic verification, not none; the comparison is generic against
  exact commands. The rule is not disabled in A, since that is not a state any user runs.
- **B:** 07's prompt extended by hand (a local patch, never committed) with the commands 08 would
  resolve for this repository (declared, else detected) and the full test command, and the
  instruction to run them before finishing. 08b's selective command is not available on an initial
  pass (F2); on a fix round B also names the last `testRun.command`.

At least three runs per arm, each on its own copy of the repository state (the AIDE² P1 rule). Read
per arm: `fix_loop.requested` rounds, which step sent each one back, gate-2 outcome, and tokens,
time and spend for 07 alone and for the whole task. Repeat once with a frontier model on 07 to see
whether B only adds cost there, as the article found.

Decision rule, written before the run: B is worth building if it cuts fix rounds for the cheaper
model by enough that whole-task spend falls or stays flat. A cheaper 07 alone does not count, since
the article's harness costs 3-4× more inside the implementation step. Local only: the patch and any
CLI preference change are snapshotted and reverted after. Rollback: revert the local patch.

### P1. Checks inside implementation, as an explicit per-step setting (conditional on P0)

A per-repository setting on the Tooling page, beside the declared commands: "Run checks during
implementation", default off. When on, 07 (initial and fix passes) and the DAG coder can ask Haive
to run a check by slot (lint, typecheck, tests, and on a fix round the last selective test run)
and get its classified result back. The agent never receives a raw command to run itself, for two
structural reasons:

- **DDEV.** 08's DDEV slots run host-side through `ddevExec`; the sandbox has no `ddev exec`
  (F1), so a handed-over command cannot run there.
- **NOT RUN is decided after the run, not before.** `classifyTestEnvFailure(framework, output)`
  reads the run's own output, and runner loss is read from `ddevRunnerLife` before and after a
  non-zero exit (`execSlot`, `08-phase-5-verify.ts`). A prompt built before the run cannot know
  either, and both can change while the agent works.

So the check runs host-side through 08's own `execSlot` and the same classifiers, never a second
resolver or runner, and returns one of: passed, failed with its scoped output, or NOT RUN with the
reason. A NOT RUN result tells the agent the check is unavailable and not its to fix, which keeps
the fix-loop rule that no agent effort goes to a failure no agent can repair. How the agent asks
(an MCP tool on the task's existing surface, or a file-based request the step polls) is D3. Rules
the result keeps:

- Lint is scoped as 08 scopes it: only violations at lines the change wrote are the agent's to fix.
- The prompt says not to weaken a check to make it pass; P6 records whether that held.
- 08, 08b and the reviewers still run as today: the final gate stays independent of what the
  implementer ran and reported.

Why a setting and not a tier lookup: F3. Whether the default should flip, or the setting should
follow the step's chosen CLI and model, is D1.

Verification: prompt tests for both setting values; a check request on a fixture repository runs
exactly the command 08 runs for that slot; a missing program and a test-environment failure each
come back NOT RUN, not failed; a DDEV repository's check runs host-side and returns; one live task
with the setting on, where 07's transcript shows the requests and their results, and 08 still runs
its own checks. Rollback: the
setting is additive; off restores today's prompt.

### P2. Config-name mismatch check (parked)

The article's one failure that a cheap deterministic check catches before any test is env-var
names: compare the names a change reads against what the runtime supplies (`.ddev/`, `.env*`,
compose). Parked until a Haive run shows a failure of this shape; none has been recorded. A check
for it must not rely on the framework's error wording.

## Open decisions

- **D1.** P1's default and scope: off for everyone, or on when the step's CLI preference is a model
  the user marked as cost-optimised. Decided by P0's numbers.
- **D2.** Whether P1's check requests are also open to 08b's tester passes, or stay with the
  implementer only.
- **D3.** How the agent asks Haive to run a check in P1: an MCP tool on the task's existing MCP
  surface (`mcp-surface.ts`), or a request file the step watches. Either way the run is host-side
  through `execSlot`, and every CLI 07 can run on must be able to make the request.

## Decided

Nothing yet.

## Relation to other plans

- `aide2-harness-lessons` P6 owns test-expectation weakening (F6) and P7 owns trying cheaper models
  on narrow seats; P0 here can share P7's local snapshot-and-restore procedure.
- `docs/architecture/fix-loop.md` is the rulebook P1 must keep: diagnoses only for project-owned
  high/critical defects, never a round spent on a failure no agent can repair.
