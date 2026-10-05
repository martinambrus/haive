# Step summaries

The task header's history clock and the fixed header's history clock open the same **Implementation history** panel
(`web/src/components/task-history.tsx`). It is a compact view of existing finished step rows,
not another summary invocation. `web/src/lib/task-history.ts` generates brief outcome
headlines from finding counts/severity, fix counts, and explicit review/check verdicts.
It never clips or reprints the agent's detailed recap or diagnosis; the linked step holds
those details. Reviewer counts describe findings, not unique defects, including typed
findings whose explanatory prose is absent. Bodies render through
`InlineMarkdown`. Only workflow steps from `07-phase-2-implement` through
`09-gate-2-verify-approval` are eligible, in every round; the explicit ID set excludes
planning, setup, commits, learning and unrelated workflow families. An agent step with no
actionable result is omitted rather than represented by a generic completion line.
A successful deterministic step is omitted: an agent entry needs both
`usesCli` and a positive `cliInvocationCount`. Deterministic failures, failing checks and
fix requests remain visible. Skipped and unfinished rows are omitted; entries sort first
to last by `endedAt`, with dates and the task page's existing round labels. Selecting a title opens
the full step, including from another tab, and takes precedence over automatic follow-scroll.

Incomplete/truncated reviews, advisory findings, refutations and checks that did not run
must never turn into a blanket clean-review claim. Validation discloses
`excludedDimensions` even with a `VALID` verdict or applied fixes. An empty audit records no findings, without claiming the audit
was clean: its producer also writes `audited: true` for an unparseable report. Manual
browser checklists are neutral, and `verificationIncomplete` prevents a browser pass
claim even when fixes were applied. Confirmed browser passes require a known test method.
A `done` row's `errorMessage` alone is not a failure: only the failed status or a current `fix_loop.requested` event proves that
outcome. While open, the panel polls only those sparse events via the existing authenticated
events endpoint; an event older than the row's latest `startedAt` belongs to a replaced
attempt and is ignored. Escalation-gate completion rewrites `endedAt` without starting a
new attempt, so it does not discard that attempt's request. Legacy rows without a start
time fall back to their completion time. The panel follows the same lifetime as step cards: separate fix
rounds remain separate, but a manual retry replaces that step row's previous result. The
previous-visit boundary is local to the browser and task: closing stores the last completion
present in the panel. Reopening snapshots a single horizontal divider after that entry
when newer entries exist. There is no divider on the first visit or when there are no new
entries, and live updates never introduce or move it during the current visit. There are
no read/unread indicators or controls. The panel remembers its scroll position per task when closed
and reopened, restoring it before paint. A reader at the end stays there as later entries
arrive; a reader browsing earlier entries keeps their position. Closing also captures the
position synchronously, since Escape can arrive before the browser's queued scroll event.
No worker changes,
migrations, extra LLM calls or historical backfills are needed.

The "What the agent did" panel (`task_steps.summary`) has two producers, and the cheap one wins. `resolveCuratedSummary` (`_step-summary.ts`) lifts `findingsSummary`/`summary`/`notes` straight off the apply output for the steps that emit one — no LLM, and it mirrors its own task-ledger entry. Only when the output carries none of those keys does `maybeEnqueueStepSummary` (`step-runner.ts`) spend a CLI call, and that pass is best-effort throughout: a missing provider, a `skip` dispatch, an empty agent text or a failure all leave `summary` null and never touch the step machine.

**Which CLI writes it is a per-task choice, not the step's.** `tasks.summary_cli_provider_id` (NULL = inherit the step's chain: per-step pref, then `tasks.cli_provider_id`) and `tasks.summary_llm_enabled` (false = skip the pass entirely) are set on the New Task form. The chosen provider is honored only while it is still `enabled`, and that check is load-bearing rather than defensive: handing a disabled id to the dispatcher does NOT fail, because `resolveDispatch` filters to enabled providers and merely ORDERS the preferred one first — an id matching nothing leaves the recap on whichever provider comes first. Falling back to the step's own chain is the predictable answer. MEASURED before the setting existed: claude-code spent 33,945 tokens (24,064 of them cache reads) and 22s writing three sentences.

**Both New Task CLI dropdowns remember their last choice per repository, and the memory is the CHOICE, not the column.** `GET /tasks/last-cli` used to read the FK columns alone, and a NULL there cannot say whether the user picked "none"/"inherit" or never picked — so only a picked provider was ever remembered and the summary dropdown reset to inherit every time. `tasks.cli_choice_recorded` / `summary_cli_choice_recorded` carry that missing bit, set from the PRESENCE of the field in the create request (the form always names all three; the plan, kb_author and upgrade-rollback spawners name none, which is why "most recent task on this repo" could not be read as a choice). The route's WHERE still admits the legacy predicate and orders flag-first, so rows written before the columns existed answer exactly as they did and no backfill was needed — `packages/database/migrations/pre-baseline/` is a parity record and the applier (`drizzle-kit push --force`) syncs DDL only, so an `UPDATE` there would never have run. `cliProviderId` in that response keeps its old meaning — the provider this repo last RAN on — because the plan chat and merge-conflict pickers render it as "the CLI that will run" and must stay aligned with `resolveProvider` in `routes/plan.ts`. A plan task started with a picked CLI is spawned with `ignore_saved_step_clis` set, or a saved per-step preference runs instead of the pick — MEASURED, a plan chat whose picker named codex ran on Claude through an explicit `01-plan-chat` preference saved days earlier. The chat panel reads the step's effective CLI (`stepCliProviderIds`) rather than the task column for the same reason: changing the CLI mid-conversation records a step choice for that task and leaves the task column alone.

**A step's CLI picked during a task belongs to that task.** The step card, the CLIs tab and the skill-verification gate's "CLI for the fix" (`09_6`, for the repair or regeneration it routes to) write `task_step_cli_choices` (task, step, role), which every resolver reads before the saved `user_step_cli_preferences` (`resolvePreferredCli`, `enrichStepsWithCliPreferences`, `resolveCurrentStepCliProviderIds`), and the saved preference is rewritten only when the person ticks "Also for my later tasks" (`remember`). A pick used to rewrite it every time, so a CLI switched to rescue one stuck run became the default of every later task of that user — observed twice: a plan chat switched twice in 8 s moved `01-plan-chat` for good, and a live check left `01-plan-build` on a test model. A NULL choice is the task clearing the slot, so the saved preference stays out of it there; a role it clears falls to the step's default slot, as an unset role always did. `task_step_cli_touched` is no longer written and is read only for the tasks that predate the choices.

**The invocation is unlinked but attributed.** `task_step_id` stays NULL — that column is what places a row in the step terminal, the retry blocker, park folding, the step's invocation count and the `cli_invocations_one_live_per_step_idx` partial unique index, and a recap written after the step finished is none of those. `summary_for_step_id` carries the SPEND home instead, so `enrichStepsWithCliStats` folds it into the step's token/cost badge by `coalesce(task_step_id, summary_for_step_id)` while both COUNTERS stay on `task_step_id`. `sumTaskTokens` and `sumTaskProviderBreakdown` accept `task_step_id IS NOT NULL OR summary_for_step_id IS NOT NULL` — deliberately not "no filter", because a summary row written before that column existed carries neither and must stay out of both sides, which keeps a task's list total equal to the sum of its per-step badges on old tasks with no backfill. Cost resolution needed no change: `resolveInvocationCost` already runs before the `step_summary` branch returns.

**The fan-out prompt is capped, and the cap is the point.** `buildAgentMiningSummaryPrompt` used to divide 7,000 chars by the agent count but floor the result at 800, which grows without bound past ~8 agents; its comment assumed "2-6 depending on QA level", from before plan mining fanned out to 61-623 agents on one step. MEASURED across every step-summary invocation on the dev install: 71 agents produced a 62,212-character prompt, 70 produced 52,875 and 623 produced 53,720, and all three were killed by the pass's own 60s budget having written nothing, while the three near 8,000 characters all succeeded. `SUMMARY_AGENT_TEXT_BUDGET` and `SUMMARY_AGENT_LIMIT` are both hard caps now, the elision is stated in the prompt, and past the limit the closing instruction asks for an overall summary instead of one line per agent — 70 lines was never the recap the panel is sized for.
