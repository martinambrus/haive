# Step 11 reconcile measurements

`11-phase-8-learning` records one `learning.reconciled` task event (payload version 1)
for each logical apply attempt, including refinement submissions and failed applies.
The event is measurement telemetry. It changes no prompt, form, learning bytes, promotion,
or step output. P1.2 learning provenance and P1.3 RAG attribution remain separate work.

## Identity and replay

`_learning-outcome.ts` derives the event's UUID primary key from the event name, task id,
step-row id, round, invocation id (null on bypass), and `rerun_generation`. The runner
captures that generation in `StepContext` from its row, rather than reading mutable state
at the end of apply. Explicit resets increment it; recovery preserves it, even when it
bumps the orchestration epoch (see [Worker restarts](worker-restarts.md)). An epoch is
therefore deliberately absent from the key. No schema change is needed.

The insert uses `ON CONFLICT (id) DO NOTHING`. Concurrent inserts and a replay cannot
create a second event. A deliberate Retry with the same retained invocation/form gets a
new event through its generation. The first recorded observation wins: replay must not
replace an earlier failure's counts with a reconciliation against files it already wrote.
This does not make the existing filesystem apply idempotent. A hard process kill before
`finally` cannot record its unfinished observation; replay records its observation under
the same key. Counts describe completed operations observed by the recorded apply, not
an atomic filesystem/database commit or a reconstruction of writes before a hard kill.

## Payload v1

Only counts, fixed rule ids/ops, status and the bounded invocation/round/generation
identity are recorded. No title, learning id, body, repository path, instruction or
transcript is copied into the event. The task and step ids occupy their existing columns.

- `listed`: `total` includes only ids the prompt can list; `withExcerpt` counts nonblank,
  collapsed excerpts among them; `omitted` includes cap omissions and unlistable ids.
- `learnings.proposed` counts raw array entries. `parsed` counts structurally valid
  entries before admission; `invalid` counts malformed entries. `rejected.file_line_evidence`
  counts only structurally valid insert/update entries rejected for missing file:line
  evidence. Deletes require a target but no citation. Prompt advice such as general
  training or CI coverage is not machine checked and has no rejection counter.
- `learnings.kept` counts admitted agent ops by insert/update/delete. `downgraded`
  separates unknown updates becoming inserts from unknown deletes dropped by the planner.
  `planned` counts the resulting operations, including deterministic fallback entries
  when `source = stub`; fallback entries are never counted as agent proposals.
- `learnings.human` separates inline clears (`removed`), body changes (`edited`, ignoring
  trailing newlines) and the surviving ops excluded by the writeFiles checkbox
  (`excluded`). `approved` counts the final enabled ops by kind. Edited and excluded may
  overlap. `reviewed = false` means apply failed before staged review completed, or the
  person asked for a refinement (`status = refine_requested`); zeros there are not evidence
  that the person accepted or rejected everything.
- `investigation` counts a proposed nonnull block, valid parsed blocks, final `kept`,
  inline `humanRemoved` and `humanEdited`. The staged frontmatter date and trailing
  newlines do not count as edits. `reviewed` distinguishes failure before its staged
  review. Bug-fix eligibility, the write checkbox and the local/global destination keep
  their existing behavior.
- `globalCandidates` has separate proposed/parsed/invalid/file-line rejection counts.
  Its `kept` is the valid selected set, gated by repo-stack availability; it is known
  before filesystem writes so a later failure does not erase the person's approval.
- `writes` separates attempted, succeeded and failed operations. Learning counters are
  by op; investigation and global counters also have `notWritten` for a promotion that
  returns null. A failure records completed earlier writes and the failing operation,
  then rethrows the original error. A failed filesystem operation may have partially
  changed its target; success counts only an operation that returned successfully.
- `status` is `completed`, `refine_requested`, or `failed`. Refinement records proposals
  but no approvals or writes. `source` identifies parsing versus deterministic fallback.

The event insert runs in `finally`; a refused insert warns and never replaces a step
result or its original failure. This is not a required security/audit write.

## Readers and checks

The authenticated events API returns these rows unmodified and accepts
`?type=learning.reconciled` for benchmark consumers. The web Activity feed filters this
measurement type through `activityEvents`; an all-measurement list uses the normal empty
state. Task history, steering, learning refinement, merge/dead/stop recovery, estimates,
statistics and timing backfills already select their own event types. Event types and
payloads in the database/API/web contracts are open strings/records; there is no closed
union or exhaustive switch to extend. Readers checked: learning refine and accepted
(`_learning-feedback.ts`), the history digest, fix loop, merges, the statistics module and
the timing backfill scripts all filter by type; the only unfiltered reader is
`GET /tasks/:id/events`.

`11-phase-8-learning-outcome.test.ts` exercises each stage, replay and deliberate Retry,
partial insert/update/delete/investigation/promotion failures, failed event insertion,
and body-free payloads. Its snapshot was captured on unchanged production code: prompt,
form, apply output, written bytes and promotion arguments compare identically after
normalizing only the investigation clock. `step-runner-park-fold.test.ts` pins captured
generation delivery. The committed tests pin deduplication through a fake store; the real
`ON CONFLICT` path was checked once on a throwaway PostgreSQL before merge (one row after
replay, two after an explicit Retry) and has no committed test.

## Reading the events

A step can carry several events: one per round and per `rerun_generation`. For counts of
what a run finally did, read the latest generation per (step row, round). A Retry replays
the agent's ops against files the first pass already wrote, and an insert whose target
exists gets a suffixed id (a pre-existing behaviour of the insert path), so a retried run's
events over-state real inserts if summed across generations. Drafts rejected in full are
re-rolled before the form (`shouldRetryPreForm`); only the final invocation's reply is
counted, so machine rejections on earlier re-rolls leave no trace.
