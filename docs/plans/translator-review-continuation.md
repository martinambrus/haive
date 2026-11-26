# Translator review: continue without Retry stops, and decide when the call budget runs out (T771, T772)

> Status: approved by the owner 2026-11-26; PR A1 in work.
> Evidence: Codex read-only designs `.claude/tmp/codex-run/T771-S/design/design.md` and `.claude/tmp/codex-run/T772-S/design/design.md` (file:line throughout).

## Context
The owner's sample run (ae8fb29c) exposed two blockers in `tr-review`:
1. After the owner ticks corrections, the step reopens with a form whose only button is Retry (`buildRetry`, `submitAction: 'retry'`), the button failed steps show. Cause: an ordinary `ReopenStepFormError` re-runs detect, prepareForm and form only, never the pre-form agent loop (`step-runner.ts:4030-4088`); only Retry re-enters it.
2. On a 2-unit sample every applied correction touches the neighbour's edge window, so each round invalidated the other unit. Four rounds spent the approved 16 calls and the step FAILED with the generic `Translation attempt allowance exhausted` (`src/db/passes.ts:240/246/306`). The only way on is the admin-only operator `extend` route with no UI.
Owner decisions 2026-11-26: ticks are the consent to the re-review cost, Retry is for failures only, nothing ticked continues; an exhausted budget must not fail but offer a decision (increase the budget or similar), with a specific message. Task ae8fb29c is on hold until this ships.

## Approach
- Ticked corrections apply, then the affected units are re-reviewed automatically: ONE sweep per approved batch. New proposals arrive on a fresh, unticked form; nothing applies without a tick. A clean review finishes the step; the "I have read the outcome" confirm form goes.
- A reached limit parks with a payload-free form instead of failing: `TRANSLATOR_CALL_BUDGET_REACHED` (task ceiling) or `TRANSLATOR_PASS_ATTEMPTS_REACHED` (one pass refused twice, with the refusal reason code and a warning that the same refusal may repeat). It shows pass, unit, review sweep, spent vs approved, and what is left. The task OWNER adds calls (prefilled, bounded, audited, idempotent), not an admin. Accepted work is kept; continuing needs no Retry.
- Host seams, default off, no core migration: `ReopenStepFormError({ rerunPreForm: true })` with an atomic exact-invocation continuation checkpoint; pause deferral on that path (`StepPrepareDeferredError`); a pre-form decision fallback when a follow-up `prepare` returns false; `StepPrepareFormError` for a cap found after the invocation row is inserted.

## PRs
A1. Host, for T771: `rerunPreForm` + exact-invocation checkpoint + recovery shape + pause deferral (`StepPrepareDeferredError`). Docs: SDK, Modules, Worker restarts. xhigh review.
A2. Host, for T772: pre-form decision fallback + `StepPrepareFormError` for a cap found after insert. xhigh review.
B. T767 PR1 (already built, in review) merges on its own.
C. Translator T771: opt in after the committed patch batch; one-sweep bound; drop Retry and confirm forms; page copy discloses the automatic review cost. xhigh.
D. Translator T772: the next free module migration (0012 if it lands before T767 PR2, whose later PRs then renumber) for call waits, owner decisions and refusal codes, common admission for all tasks incl. legacy, owner grants, specific messages, typed refusal reason codes. xhigh.
(E, only if the owner wants it) "Finish review without more calls" with an explicit partial-coverage waiver carried through render and the manifest.

## Decisions (approved by the owner 2026-11-26)
- Grant bounds: one grant at most min(1000, 8U) calls; owner extensions over the task's life at most another 8U (the budget can at most double); one extra attempt per pass decision, at most two per pass. Historical operator grants stay valid. Owner: revisit after a real book.
- Stop: no in-form Stop (that needs another host signal); the form points to the task's Stop button.
- Finish without more calls: deferred to optional PR E (needs render to accept a deliberately partial review).
- Recovery of ae8fb29c: after deploy the owner clicks Retry on the failed review once; it parks on the new budget form without a paid call; the owner decides there.

## Rollback
Default-off host seams; module consumers removed before host symbols revert. T772's module migration is roll-forward only. No history, spend or consent is rewritten.

## Verification
Controls per design section 6/7 (both), red on the parent first. Host: re-entry, exact-id consumption, crash cuts, pause, default reopen unchanged. Module: sweep bound, owner authority (non-admin owner yes, admin non-owner no), arithmetic, stale forms, legacy failed task fixture. Live: the owner resumes ae8fb29c.
