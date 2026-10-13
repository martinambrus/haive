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
  arrangement, applied to every model. An agent may still run tests on its own initiative from the
  repository's own instructions; Haive neither asks for it nor records it.
- **F2. The commands to hand over already exist.** A repository's declared commands are read by
  `loadDeclaredVerifyCommands` (`_task-meta.ts`) and shown by `06-run-config`; 08 resolves detected
  ones (`08-phase-5-verify.ts`); 08b builds a file-scoped selective test command. None reaches 07.
- **F3. Haive has no notion of a model tier.** No symbol classifies a model as frontier or cheap.
  Deriving one from a model id would key logic on a value that changes with every release, so a
  tier has to be an explicit setting, not a lookup.
- **F4. Spend per step is already recorded** (`docs/architecture/model-pricing.md`,
  `docs/architecture/statistics.md`), and `fix_loop.requested` events count rounds. The article's
  comparison (acceptance, tokens, time, cost per arm) can be read from existing rows.
- **F5. Checks no agent can repair already stay out of the loop**: `classifyTestEnvFailure`, the
  enumerate guard, and the NOT RUN verify slots. The article does not address this; Haive is ahead
  here, and P1 must keep it: a check that would be NOT RUN at 08 must not become a demand on 07.
- **F6. Expectation weakening is `aide2-harness-lessons` P6.** 08b's `DECIDE_PER_FAILURE` lets the
  tester decide the test is wrong. P6's cheap half (a prompt line plus a host-side record of test
  edits per fix pass, shown at gate 2) is the plan for that; this article is a second source for it,
  nothing more.

## Phases

### P0. Measure the gap before building anything

Pick one finished workflow task with a detailed spec on a repository with declared verify and test
commands. Re-run it from the same base on the dev install, 07 on a cheaper model, in two arms:

- **A:** as today.
- **B:** 07's prompt extended by hand (a local patch, never committed) with the declared and
  detected verify commands and 08b's selective test command, and the instruction to run them before
  finishing.

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
implementation", default off. When on, 07 (initial and fix passes) and the DAG coder get one block
naming the commands to run before finishing and what a red result means. The commands are the ones
08 and 08b would run, resolved by the same functions, never a second resolver. Rules the block keeps:

- A command that would read as NOT RUN at 08 (missing program, lost runner, a test environment
  `classifyTestEnvFailure` rejects) is left out, or named as unavailable, never handed over as a
  demand.
- Lint is scoped as 08 scopes it: only violations at lines the change wrote are the agent's to fix.
- The block says not to weaken a check to make it pass; P6 records whether that held.
- 08, 08b and the reviewers still run as today: the final gate stays independent of what the
  implementer ran and reported.

Why a setting and not a tier lookup: F3. Whether the default should flip, or the setting should
follow the step's chosen CLI and model, is D1.

Verification: prompt tests for both setting values and for a NOT RUN command left out; a fixture
repository whose declared commands reach 07's prompt exactly as 08 runs them; one live task with the
setting on, where 07's transcript shows the commands run, and 08 still runs them. Rollback: the
setting is additive; off restores today's prompt.

### P2. Config-name mismatch check (parked)

The article's one failure that a cheap deterministic check catches before any test is env-var
names: compare the names a change reads against what the runtime supplies (`.ddev/`, `.env*`,
compose). Parked until a Haive run shows a failure of this shape; none has been recorded. A check
for it must not rely on the framework's error wording.

## Open decisions

- **D1.** P1's default and scope: off for everyone, or on when the step's CLI preference is a model
  the user marked as cost-optimised. Decided by P0's numbers.
- **D2.** Whether P1's block also goes to 08b's tester passes, or stays with the implementer only.

## Decided

Nothing yet.

## Relation to other plans

- `aide2-harness-lessons` P6 owns test-expectation weakening (F6) and P7 owns trying cheaper models
  on narrow seats; P0 here can share P7's local snapshot-and-restore procedure.
- `docs/architecture/fix-loop.md` is the rulebook P1 must keep: diagnoses only for project-owned
  high/critical defects, never a round spent on a failure no agent can repair.
