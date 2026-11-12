# What TokenEconomizer offers Haive: tell an agent which interpreter its sandbox lacks

> **Not started.** Written 2026-11-12. One source is reviewed: Microsoft TokenEconomizer
> (github.com/microsoft/TokenEconomizer, Apache 2.0) and its paper (arXiv 2610.22732). Verdict: one
> idea carries over, TE's `AbsentTool` environment fact, built from the sandbox image instead of
> learned from failures. Tool pruning, the loop guard, the other learned facts and the cost
> accounting are not ported, for the measured reasons in "The source". The gain is small and was
> measured on one benchmark job: see "What the data can and cannot say". Keep this file current by
> editing the section a change belongs to.

## Context

The user asked what Haive could take from TokenEconomizer (TE). Every Haive claim below was read on
`main` `c9bf7b732` on 2026-11-12. Every number was measured on the dev install that day, read-only,
over the stored stream logs of 974 claude runs (8,183 shell calls) and 842 codex runs (36,311 shell
calls). Line numbers are hints; resolve by symbol.

## The source

TE cuts the token cost of coding agents with three mechanisms. Table 2a of the paper (Claude Code on
SWE-bench, Sonnet 5 / Opus 4.8): tool pruning -13.2% / -17.7%, micro-skills -11.8% / -14.3%, loop
guard -7.1% / -5.4%, all three -23.6% / -30.9%.

- **Tool pruning** removes a tool once it has gone unused for 10 prompts across at least 2 sessions,
  or for 5 sessions, and drops tools a headless run cannot use. For Codex the unit is a capability
  package (collaboration, `features.goals`, `features.view_image`).
- **Micro-skills** are one-line repository facts learned from finished sessions. The LLM-free
  families live in `tokeneconomizer/microskills/envfacts.py`. One is `AbsentTool`: "a bare tool fails
  with command not found, the error naming that tool, and no way of running it works here". A fact
  goes live after 3 confirming sessions, retires on contradiction, and is injected only while it
  fires in at least 40% of the sessions that exercise it; the block is capped at 4 facts and 150
  tokens.
- **Loop guard** folds each tool call into counts (edit churn, error outputs, repeated failure
  signatures), opens a gate past 18 turns, asks a judge model (confidence 0.7) and redirects a stuck
  run at most once.

Tested against Haive:

| TE mechanism | Haive today | Result |
| --- | --- | --- |
| `AbsentTool` fact | No prompt says which interpreter a sandbox lacks | Carried over: this plan |
| Other learned facts (refused hosts, repaired command forms and arguments, env values, empty probes) | Network refusals 37, permission errors 38, git errors 14 failing calls in 1,816 runs | Rejected: too rare to learn |
| Tool pruning | Claude Code defers MCP tools and most built-ins (ToolSearch ran in 19% of 4,871 runs); tools always loaded and never or rarely used cost about 3K tokens, about 1% of cost; codex already runs with `multi_agent_v2` and bundled skills off | Rejected: about 1%, and per-step tool lists would split the shared, cached ~22K prefix |
| Loop guard | Steering, the stall badge, the fix loop's same-check repeat, `_test-env-guard`, DAG stuck detection | Rejected: TE's rules replayed on stored runs find 1.6% of tokens after a stuck point on 574 loop-prone claude runs and about 1.0% on 842 codex runs, both upper bounds; the codex gate opens on 28% of runs at 5-25K tokens per judge call |
| Cost accounting | Subscription claude priced at the 1h cache TTL, `<synthetic>` dropped, usage deduped per `message.id`, cached input subtracted for codex and gemini | Parity |

Two lessons are kept without code. A failure detector keys on exit status, never on output text:
codex reads files with `sed -n` and `nl -ba`, so a text rule flagged 61 of 842 codex runs as stuck
and an exit-code rule 3 (TE fixed the same bug in its #128). And TE's Table 1 measured RTK at -1.1%
to +4.5% cost; Haive has `repositories.rtk_enabled` on by default (78 of 79 repositories) and no
measurement of its own.

## The defect

Agents rediscover on every task that their sandbox cannot run the project's interpreter.

- Codex, 2026-07-22 to 2026-08-25: 419 failing calls in 207 runs ran a command naming `php` and got
  "command not found". By step: `07b-phase-4-validate` 312 calls in 135 runs, `06c-dag-execute` 67 in
  46, `07-phase-2-implement` 20 in 12, `08c-code-review` 12 in 8, four other steps 8.
- Most were `php -l` syntax checks (222); `php -r` (32) and `php -d` (20) follow. No codex run ever
  ran `ddev exec`.
- All nine tasks are the "Add DDEV" benchmark job on six PHP repositories (primary language `php`),
  so for most of a run no DDEV container exists yet. 126 runs had an env-template image
  (`FROM ubuntu:24.04`, no php); the other 81 had no template Dockerfile to compose from and ran on a
  provider image, whose base has no php either. The fact belongs to whichever image an invocation
  gets.
- Today's prompt does not say it. The `ddev-control` line of `mcpSurfacePrompt` (`mcp-surface.ts`,
  added 2026-08-09 in `853ff45c4`) says that server cannot run tests, a linter or a syntax check,
  never that the sandbox has no php. On those repositories the share of codex invocations with a php
  failure was 7.0% before that line (125 of 1,795) and 9.7% after (82 of 845); 64 of the 82 later
  prompts carried it.
- Claude barely does this: 33 command-not-found calls in 974 runs.
- Haive's learning paths cannot see it. The task-history digest reads structured outputs, never
  transcripts. `step_guidance` (`11e-prompt-guidance`) is off (`config:guidance:stepGuidanceEnabled`
  defaults to `false`; 0 of 727 capture prompts since 2026-08-21 carried its instruction, 0 rows),
  and even when on it asks agents to omit environment causes and attaches every lesson to
  `07-phase-2-implement` (`GUIDANCE_TARGET`), never to 07b.

## The rule

Before its first command, an agent is told which of its repository's interpreters the image it runs
in cannot execute. The fact is read from that image, by the exit status of `command -v` inside it,
never from an agent's failure text. A dispatch that cannot prove the fact states nothing, so the
block never claims an absence it did not observe.

TE's learned version is not ported: it needs 3 confirming sessions, keys on the wording of an error,
and arrives after the waste it describes. Haive builds the image, so it can ask it before the first
run.

## The change (one PR)

**Probe.** New `sandbox/toolchain-probe.ts`, shaped like `imageRunsRtkHook`
(`sandbox/task-auth-volume.ts`): one `docker run --rm` of the image with the entrypoint cleared and
`sh -c 'command -v <name> >/dev/null 2>&1'`, bounded by a timeout. Exit 0 is present, exit 1 is
absent. Anything else (no status, a timeout, a spawn failure) is unknown, is not cached, and is asked
again next time. The answer is cached as a promise per image ID and name, so concurrent dispatches
share one run. The image ID comes from `runner.inspect`, not the tag: composed and per-provider tags
are content hashes, but the no-derived-image fallback runs the base under the mutable `:latest`.

**Which names.** A Haive-owned map from the primary language of `resolveTaskFacets`
(`@haive/shared/global-kb`, read from 01-env-detect and the user's confirmation) to interpreter
names. v1 holds `php` -> `php`, the measured case. Another language is one entry, added when its own
not-found count says so (method under "Verification"). Names never come from the repository, so
nothing repository-written reaches the prompt line. `node` is never probed: it is on every sandbox
image ([Sandbox](../architecture/sandbox.md)).

**Which image.** New `peekSandboxImageTag` beside `resolveSandboxImageTag`
(`queues/cli-exec/images.ts`): the same order (the task's composed image when its env template is
ready and has a Dockerfile, else the provider's image, else the base that `runInSandbox` falls back
to), answered only when `runner.inspect` finds the image, and never building. The composition half
of `ensureComposedImage` (`sandbox/composed-image-cache.ts`) moves into one function both paths call,
so the peek and the build cannot disagree on a tag. The peek reads the base image ID by inspect only:
it must not call `ensureSandboxCoreImage`, since a dispatch must never start a base build. An image
not built yet answers null, so the first dispatch on a new env template states nothing and the next
one does. The cost is one inspect per enabled provider per dispatch, and one container run per image
and name per worker boot.

**Dispatch.** `resolveTaskDispatch` (`orchestrator/dispatcher.ts`) resolves the facts beside its
other context, in its `Promise.all`, for every enabled provider in `req.providers`, since the pure
`resolveDispatch` picks the provider afterwards. The request carries `sandboxToolchain`, the absent
names per provider id. `buildCliSidePlan` hands `adaptPrompt` the entry of the provider it builds
for, and a new `withSandboxToolchain` applies it right after `withAppReach`, so sub-agent and
synthesis prompts get it too. It is a marker-led block like its neighbours (`hasLeadingHaiveBlock`),
so a re-dispatched stored prompt is not given a second one. It is skipped when the dispatch has no
shell, by the same predicate as `withMcpSurface`'s `noBuiltInTools`.

**The block** states only what the probe proved, roughly: "Not installed in this sandbox: `php`.
Anything that runs PHP (`php -l`, `composer`, `vendor/bin/*`) fails here with command not found, so
do not run it; read the code instead." It makes no promise about later steps. A DDEV project's PHP
checks do run in its container at `08-phase-5-verify` (`buildVerifyCommand` under `ddevMode`), but
the dispatcher cannot prove DDEV mode without step-engine helpers, the measured tasks were still
adding DDEV, and the existing `ddev-control` line already says the container cannot be exec'd from
the sandbox.

**Docs.** A paragraph in [Sandbox](../architecture/sandbox.md) beside "A step's project commands run
in the sandbox": what the probe asks, why by exit status and image ID, and that a peek never builds.

**Not changed.**

- php is not installed into sandbox images. Its version would drift from the PHP in the project's
  DDEV container, and the checks stay in deterministic steps by design: `08-phase-5-verify` runs a
  DDEV project's PHP checks with `ddev exec`.
- The `ddev-control` line, `step_guidance` and the task-history digest.
- Claude dispatches get the block too, since the fact is the image's, though claude rarely makes the
  mistake.

## What the data can and cannot say

- The friction comes from one benchmark job: "Add DDEV" on six rs_* repositories, nine tasks, July
  and August 2026. The dev install has 13 invocations since 2026-09-01. The absolute saving is small
  (the assessment put it near 0.7% of tokens) and almost all codex.
- The cause is not specific to the job: the sandbox base has no php, and an env template need not
  install it, so any PHP repository without a php-installing template gives agents the same image.
  No non-benchmark PHP task on this install shows it yet, because none ran.
- The before/after split around the `ddev-control` line is confounded by task mix. It shows that the
  line did not stop the attempts, not that it caused more.
- Nothing yet shows that the block stops them; that is the live check under "Verification".
- The 2026-11-12 scripts were session scratch and are not kept. The count is rebuilt as written
  under "Verification".

## Steps

1. Before saving worker source: check no CLI run is in flight on the dev stack (a tsx reload of the
   worker kills it): `cli_invocations` with `started_at` set, `ended_at` and `superseded_at` null.
2. Tests first, then code, then the sandbox doc paragraph.
3. After merge: mark this plan's README row and status line shipped, and update the memory
   `tokeneconomizer_assessment`.

## Verification

Tests, written first:

- `toolchain-probe.test.ts`: exit 0 is present, exit 1 absent; no exit status, a timeout or a spawn
  failure is unknown and asked again on the next call; concurrent calls share one run; two tags of
  one image ID share one run; a tag whose ID changed is asked again.
- A new `sandbox-image-peek.test.ts` beside `sandbox-image-tag-turn.test.ts` (`packages/worker/test/`):
  the peek never builds and never calls `ensureSandboxCoreImage`; it agrees with
  `resolveSandboxImageTag` on the composed arm, the provider arm and the base fallback; a missing
  image answers null.
- Dispatcher tests: of two providers, the one whose image lacks php gets the block and the other
  does not; a language with no map entry, an unknown probe and a dispatch with no shell get none; a
  stored prompt dispatched again carries one block.
- `pnpm --filter @haive/worker test toolchain-probe sandbox-image-peek dispatcher`, then the full worker suite,
  `pnpm typecheck`, `pnpm format:check`.

Live check: a codex workflow task on a PHP repository whose sandbox lacks php. Its 07b prompt
carries the block, and its stream logs hold no `php` command-not-found call. The count per run is
the number of codex `item.completed` items of type `command_execution` with a non-zero `exit_code`,
a `command` naming `php` and "command not found" in `aggregated_output` (for claude, a Bash
`tool_use` whose `tool_result` has `is_error`). Baseline 2026-11-12: 82 of 845 codex invocations on
the six rs_* repositories after 2026-08-09. Run the same count for other interpreter names before
adding a map entry.

Rollback: revert the commit. No schema, config or data change: the cache is in memory, and the
change is prompt text plus one container run per image and name per worker boot.
