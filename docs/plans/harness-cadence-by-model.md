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
and test commands and its test framework at the repository root, so every command can run inside
the sandbox from 07's working directory and P0 needs no bridge (P1 covers DDEV and frameworks below
the root). Re-run it from the same base on the dev install, 07 on a cheaper model, in two arms:

- **A:** as today, which includes the default rules' generic "Own the verification" instruction
  (F1). A therefore measures generic verification, not none; the comparison is generic against
  exact commands. The rule is not disabled in A, since that is not a state any user runs.
- **B:** 07's prompt extended by hand (a local patch, never committed) with the commands 08 would
  resolve for this repository (declared, else detected) and the full test command, and the
  instruction to run them before finishing. 08b's selective command is not available on an initial
  pass (F2); on a fix round B also names the last `testRun.command`, which is a display string that
  runs correctly from the root only because the fixture's framework sits there.

At least three runs per arm, each on its own copy of the repository state (the AIDE² P1 rule). Read
per arm: `fix_loop.requested` rounds, which step sent each one back, gate-2 outcome, and tokens,
time and spend for 07 alone and for the whole task. Repeat once with a frontier model on 07 to see
whether B only adds cost there, as the article found.

Decision rule, written before the run: acceptance first, cost second. B qualifies only if its
gate-2 outcomes are at least as good as A's (no more rejected or unfinished runs, and no
unrecovered failure that ends a run early, which would cut rounds and spend for the wrong reason).
Only then is B worth building if it cuts fix rounds for the cheaper model by enough that
whole-task spend falls or stays flat. A cheaper 07 alone does not count, since
the article's harness costs 3-4× more inside the implementation step. Local only: the patch and any
CLI preference change are snapshotted and reverted after. Rollback: revert the local patch.

### P1. Checks inside implementation, as an explicit per-step setting (conditional on P0)

A per-repository setting on the Tooling page, beside the declared commands: "Run checks during
implementation", default off. When on, 07 (initial and fix passes) can ask Haive to run a check by
slot (lint, typecheck, tests, and on a fix round the last selective test run) and get its classified
result back. 07 works in `01-worktree-setup`'s integration worktree, the tree 08 checks, so both
read the same files. A DAG coder does not: it edits its own per-issue worktree until the level
merges (`docs/architecture/review-scope.md`), and a check run on 08's path would not see its edits.
DAG coders are therefore out of P1 (D4). The agent never receives a raw command to run itself, for
two structural reasons:

- **DDEV.** 08's DDEV slots run host-side through `ddevExec`; the sandbox has no `ddev exec`
  (F1), so a handed-over command cannot run there.
- **NOT RUN is decided after the run, not before.** `classifyTestEnvFailure(framework, output)`
  reads the run's own output, and runner loss is read from `ddevRunnerLife` before and after a
  non-zero exit (`execSlot`, `08-phase-5-verify.ts`). A prompt built before the run cannot know
  either, and both can change while the agent works.

So each check is resolved and classified by the code its owning step uses, never a second resolver
or classifier (where it executes is D5): lint, typecheck and the full test
command as 08's `execSlot` resolves and classifies them, and the
selective test run as 08b's `runTestCommand` builds it, from a structured `TestCommand` (kind,
args, and a `cwd` for a framework below the root). 08b persists only the flattened display string
(`testRun.command`) today, which cannot rebuild that `cwd`, so P1 has 08b also persist the
structured command it ran. Two inputs those runners take from earlier steps do not exist yet on
07's initial pass, and the request path supplies them itself:

- **Where a non-DDEV check executes, and under what capacity.** This is open (D5). A DDEV check
  runs in the task's runner through `ddevExec`, which the runtime budget already counts and which
  holds no CLI credentials. A non-DDEV check has no such home, and every obvious transport breaks
  one of four constraints any answer must meet:
  1. **No self-deadlock.** A step command reserves an agent-pool slot (`runStepCommandInSandbox`,
     `docs/architecture/runtime-capacity.md`) while the requesting 07 invocation holds its own
     until it finishes. A second reservation waits on its own caller's capacity: at
     `MAX_PARALLEL_AGENTS=1`, or with every slot held by 07 runs, it times out as NOT RUN.
  2. **No uncounted workload.** Sharing the caller's lease still starts a second sandbox
     container, two agent-sized workloads under one lease, which breaks the pool's RAM cap.
  3. **No credentials.** Project commands run with no auth volume and no provider env, since the
     project's own code runs there (`docs/architecture/sandbox.md`, "A step's project commands run
     in the sandbox"). 07's own container has both, and clearing the exec's env leaves the mounted
     credentials readable, so executing inside 07's container is out.
  4. **Killable.** A timed-out or cancelled check must stop without stopping 07, and must not keep
     writing the worktree or holding capacity after its result is returned. The current runner
     gets that by force-removing its disposable container; a killed `docker exec` client leaves
     its process running (`runtime-capacity.md`, "A runner is settled only when nothing runs in
     it").
  The candidate that meets all four: a disposable, credential-free check container as today,
  whose capacity is reserved when 07 is admitted with the setting on (the invocation is admitted
  at the weight of both), so the check never queues behind its caller. Whether admission can
  carry that combined weight is what D5 settles before P1 is built.
- **The test framework.** 08 reads it from 08b's persisted detect (`08-phase-5-verify.ts`), which
  does not exist before 08b runs. Without it a Playwright slot gets no browser provisioning and
  `classifyTestEnvFailure` runs with `null`, so a missing browser would come back failed rather
  than NOT RUN. The request path runs 08b's `scanTestInfra` itself.

A check returns one of: passed, failed with its output, or NOT RUN with the reason. A NOT RUN
result tells the agent the check is unavailable and not its to fix, which keeps the fix-loop rule
that no agent effort goes to a failure no agent can repair. How the agent asks (an MCP tool on the
task's existing surface, or a file-based request the step polls) is D3. Rules the result keeps:

- Lint keeps 08's scoping, which is partial. Only a direct phpcs run is filtered to the lines the
  change wrote (`_lint-scope.ts`); a package.json or composer lint script and a declared lint
  command are unscoped, and their exit decides alone (`docs/architecture/fix-loop.md`). A scoped
  result names the change's own violations. An unscoped failure is returned marked unscoped, with
  its output, and the prompt tells the agent to fix only violations at lines it changed and to
  leave the rest, as 08's own diagnosis does for pre-existing phpcs violations.
- The prompt says not to weaken a check to make it pass; P6 records whether that held.
- 08, 08b and the reviewers still run as today: the final gate stays independent of what the
  implementer ran and reported.

Why a setting and not a tier lookup: F3. Whether the default should flip, or the setting should
follow the step's chosen CLI and model, is D1.

Verification: prompt tests for both setting values; a selective test request for a framework below
the root runs from that framework's directory, as 08b ran it; a check request on a fixture repository runs
exactly the command 08 runs for that slot; a missing program and a test-environment failure each
come back NOT RUN, not failed; a check requested at `MAX_PARALLEL_AGENTS=1` runs rather than
waiting on its own caller's slot, sees no CLI credentials, and leaves no process behind after a
timeout or a Stop; a DDEV repository's check runs host-side and returns; one live task
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
  surface (`mcp-surface.ts`), or a request file the step watches. Either way the run goes through
  the owning step's runner, and every CLI 07 can run on must be able to make the request.
- **D4.** DAG coders: leave them to the final gate, or run their checks against the requesting
  issue's own worktree, which needs that worktree's path (and, for DDEV, a runtime bound to it)
  carried into the request.
- **D5.** Where a non-DDEV requested check executes. It must meet P1's four constraints (no
  self-deadlock, no uncounted workload, no credentials, killable). The candidate is a disposable
  credential-free container whose capacity 07 reserves at admission; the alternative is a separate
  check lane in admission. Rejected, each for one constraint: a second lease (1), sharing 07's
  lease (2), executing inside 07's container (3 and 4).

## Decided

Nothing yet.

## Relation to other plans

- `aide2-harness-lessons` P6 owns test-expectation weakening (F6) and P7 owns trying cheaper models
  on narrow seats; P0 here can share P7's local snapshot-and-restore procedure.
- `docs/architecture/fix-loop.md` is the rulebook P1 must keep: diagnoses only for project-owned
  high/critical defects, never a round spent on a failure no agent can repair.
