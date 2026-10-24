---
name: container-cleanup-smoke-races-cancel
description: 'The container-cleanup worker smoke raced the cancel handler (~1 run in 40, failing on unrelated diffs); FIXED in #179. One PARKED experiment remains and wants a live dev stack — run it during the next test onboarding to close this out'
metadata:
  node_type: memory
  type: project
  originSessionId: e62dac9c-0a5b-41ca-8f3f-eaec5bb75d8c
  modified: 2026-09-20T07:16:31.377Z
---

**`pnpm smoke:container-cleanup` has a structural race and fails roughly 1 run in 40.** MEASURED
2026-09-18 on CI run 35342296114: it failed on a commit whose entire diff was two markdown files
under `docs/plans`, and the **rerun of the same job on the identical sha passed**.

The mechanism, confirmed by reading both sides:

- `packages/worker/test/container-cleanup-smoke.ts:111-120` polls until the task row reads
  `status === 'cancelled'` (200 ms interval, 15 s budget), then reads `stubCalls` at `:133`.
- `handleCancelTask` (`packages/worker/src/queues/task-queue.ts:2453`) writes
  `status: 'cancelled'` as its **FIRST** statement (`:2458`) and only calls
  `cleanupTaskContainers` — which invokes the stub — at `:2495`, two awaited statements later
  (the `task_steps` update at `:2472`, `appendEvent` at `:2494`).
- So the barrier is the wrong signal. When the first poll sample already sees `cancelled`, the
  assertion runs inside that window and sees 0 calls. Log evidence: `[smoke] FAILED` at
  12:01:04.9026 with `cancel-task` job 408 completing at 12:01:05.2256 — 0.32 s LATER.

The failure reads as `[smoke] FAILED: Error: expected cleanup stub called at least once, got 0`,
and the job is **End-to-end smokes**, step **Run worker smokes**. Six smokes in the chain pass
ahead of it (`ONBOARDING_OK`, `ONBOARDING_FULL_OK`, `WORKFLOW_OK`, `WORKFLOW_COMMIT_OK`,
`ENV_REPLICATE_OK`, `ENV_WRAP_OK`), so a green prefix does not mean the job passed.

**Why:** a docs-only or otherwise unrelated PR going red on a worker smoke looks like a real
regression, and the investigation protocol's own first step — rule out your own diff — costs a
full pass through `gh run view --log-failed`, the smoke source and the handler. That work is
already done here.

**FIXED 2026-09-20 in PR #179 (`0d0d6dbf`), branch `fix/container-cleanup-smoke-barrier`.** The
smoke now polls for the `containers.destroyed` event instead of the task status, which is sound
because `cleanupTaskContainers` awaits the cleanup runner and only THEN appends that event,
carrying its return value as `count` — so an event row implies the runner has returned. Three
consequences worth knowing: the old status predicate was the only check that a cancel sets the
status, so it became a plain read plus an explicit assertion; the `cleanupEvents.length < 1` throw
was removed, being the poll's own predicate and therefore an unreachable branch; and `stubCalls`
stayed, as the only thing asserting the INJECTED runner ran rather than `defaultContainerCleanup`.

**How to apply, now that it is fixed:** this failure on a commit that has #179 as an ancestor is
NEW information, not the known flake — investigate it rather than rerunning. On a commit from
before #179, the old advice stands: rerun the single job (`gh run rerun --job <id>`, which prints
NOTHING on success — verify with `gh run list --commit <full sha>` showing `in_progress`) and
compare, because a pass on the identical sha settles it. Never conclude "flake" before the rerun.

**PARKED EXPERIMENT — do this at the next TEST ONBOARDING on the dev stack, then close this out.**
CI going green on #179 did NOT prove the fix: the bug failed ~1 run in 40, so one pass is equally
consistent with the old code, and the only argument on record is structural (the assertion cannot
be reached before the event exists). The decisive test needs a live stack, which was off-limits
when the fix was written — so it waits for a run where the stack is already up for other reasons:

1. In `packages/worker/test/container-cleanup-smoke.ts`, make the injected stub
   `await new Promise((r) => setTimeout(r, 2000))` before `return 3`.
2. Run `pnpm --filter @haive/worker smoke:container-cleanup` (needs `DATABASE_URL`, `REDIS_URL`,
   `CONFIG_ENCRYPTION_KEY`).
3. **Expected:** the CURRENT barrier passes — the poll simply waits the extra 2 s for the event.
   Against the OLD barrier (`git stash` the fix, or check out a pre-#179 sha) it fails EVERY time
   with `expected cleanup stub called at least once, got 0`, because the status is already
   `cancelled` while the runner has not run. That asymmetry is the proof.
4. Revert the delay. It is a probe, not a change to keep.

If the current barrier does NOT pass, that is a real finding and outranks the structural argument —
say so rather than filing it as noise. Nothing in the repo tracks this: there is deliberately no
`docs/plans` entry (a single PR, implemented immediately), so this memory is the only record.

One thing in the same log that is NOT this defect: a `task_events` FK violation warning,
`task.completed event not recorded; task stays completed`, on the PREVIOUS smoke's task. It is a
level-40 warn on a smoke that passed — a second symptom of the same shape, not the failure.

Related: [[gh-run-watch-exit-status-lies]] for why a watcher's exit code is never the verdict,
and [[fixed-tmp-path-in-test-masks-failure]] for the other case where a test's own setup, not the
code, decided whether CI went red.
