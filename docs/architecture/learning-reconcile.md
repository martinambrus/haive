# Step 11 reconcile measurements

`11-phase-8-learning` records one `learning.reconciled` task event (payload version 1)
for each logical apply attempt, including refinement submissions and failed applies.
The event is measurement telemetry. It changes no prompt, form, learning bytes, promotion,
or step output. Learning files now carry separate P1.2 provenance (below); P1.3 RAG attribution remains separate work.

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
form, apply output, learning content and promotion arguments compare identically after
normalizing the investigation clock and stripping the separately tested P1.2 footer. `step-runner-park-fold.test.ts` pins captured
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

## Learning provenance (P1.2)

Each learning written by `applyLearningOps` carries a trailing HTML comment in the reserved
`haive-learning-provenance` namespace. Its JSON has `version: 1`, `origin` and `updates`. An
insert's origin records the writer's task id, UTC ISO timestamp and `bodyHash`; an update
retains that origin and appends its own task id, UTC timestamp, `beforeHash` and `afterHash`.
`LEARNING_UPDATE_HISTORY_MAX` is **5**: origin is retained indefinitely, the last five updates
are retained, and older update records are dropped. Within one apply, repeated updates to one
target chain from the bytes the preceding operation successfully wrote. An update whose
after-hash equals its before-hash returns the prior file byte-for-byte, without a new date or
history slot, including for legacy files.

Hashes are SHA-256 over the heading and prose with reserved metadata removed, CRLF normalised
to LF, and exactly one final LF. Rendering and both sides of an update use that same
normalisation, so the origin and successive update hashes form one chain. They identify
content, not a signature against direct file changes. No new telemetry is added, and no body
or transcript is copied into a new record. A file without supported provenance reads as
`origin: "unknown"`; updating it keeps that unknown origin while recording the correction.
Never infer an origin from a filename, commit date, task title or the task that first reads
it. Malformed, duplicate, non-trailing or unsupported metadata is also unknown.

The deterministic writer owns the footer. It strips reserved blocks from proposed content to a
fixpoint: removing an inner block can reassemble a marker, so stripping repeats until no
further block can be removed. This includes malformed/unclosed blocks and quoted samples.
Origin comes only from the prior stored file. Removing or forging metadata in a proposed or
staged full-body rewrite cannot remove or replace that origin. A staged draft cleared of prose
is removed even if its footer remains; metadata-only edits do not count as human body edits.
Apply rebuilds the footer after reviewer edits, so hashes describe approved content and dates
for content-changing updates describe the write rather than its earlier preview.

A trailing comment alone leaks into a short learning's 200-character excerpt and RAG chunks.
`learningContent` strips it before `learningExcerpt` takes its heading-free excerpt and before
`extractMarkdownSections` extracts learning sections. Onboarding's `10-rag-populate` and the
workflow's pre-sync/reindex use that same extractor: metadata reaches neither indexed text,
embeddings, chunk hashes nor the step-11 listing. Legacy text without a reserved marker stays
byte-identical. Adding the footer leaves its indexed chunks and hashes identical: **no reindex
is required**. Body corrections use the normal incremental sync.

The existing human knowledge diff shows origin task/date in the step-11 preview and the stored
file at the 11b commit gate. Raw file downloads and Editor/Terminal retain the record. An
agent opening the raw file also sees the footer; provenance is absent from listed and
retrieved text, not from raw-file reads. There is no separate learning management UI/API to
extend. Retrieval and the playground keep showing learning content only. Prompt, form,
admission rules, reconciliation decisions, event counts and apply output retain their
contracts.

Learnings remain repository markdown, not database rows. Commit/push/merge,
clone/import/export, legacy relocation and reset carry or remove the whole file, including
provenance. Learning bodies are not onboarding templates; no manifest or schema-version change
is needed. Local investigations are distinct KB runbooks. Global candidates/promoted
investigations already carry `sourceTaskId`, `createdAt` and supersession links in the global
KB; their formats stay unchanged. Files authored outside the deterministic writer have no
trustworthy task stamp and read as unknown unless they already carry a supported record;
import never invents one.

`shared/test/learning-provenance.test.ts` pins origin, bounded history, before/after identity,
unknown legacy records, nested-marker stripping at depths 3 and 6, unchanged-update replay,
CRLF hash continuity and stable parse/render. Worker `11-phase-8-learning-provenance.test.ts`
pins actual file writes, staged edits, both reader exclusions, nested markers through preview
and staged full-body replacement, unchanged indexed hashes, repeated-target updates and
clearing prose with a footer left. The reconcile snapshot strips only the separately tested
footer from learning files; its original prompt/form/output/content snapshot remains
unchanged.
