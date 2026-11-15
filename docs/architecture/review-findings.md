# Review findings and waivers

`review_findings` is the durable record of what every reviewing step raised — 07b's validator, 08c/08c2, 08d's adversaries. Findings otherwise live only in `task_steps.output`, which a manual retry nulls, so nothing could say whether a reviewer change helped. `recordReviewFindings` (`_review-findings.ts`) is the only core insert (a module may record its own rows under the rules in [Modules](modules.md#core-row-writes)), and its two readers only inform: `loadFindingRecurrence` counts earlier rounds for `recurrence_count`, and `GET /stats/quality` aggregates it. No behaviour gates on it, which is why every write there is best-effort and never throws — telemetry must not fail the review that produced it.

`disposition` is the verdict on a finding. Every value that is written has exactly one core writer (module writes follow [Modules](modules.md#core-row-writes)):

- `open` — default. Nobody has ruled on it.
- `dismissed_refuted` — 08c's refuter panel disproved it. Written at INSERT, because the insert happens on the final apply() after refutation ran.
- `dismissed_human` — the developer picked a subset at gate 1.5 (`08d2`) and left this one out. Written by `dispositionReviewFindings`.
- `accepted_risk` — the fix loop hit its round cap (or oscillated), and the developer accepted the remainder at the escalation gate. Written by `acceptRemainingReviewFindings` from the queue's gate resolver, which is why that one takes a `db` rather than a `StepContext`.
- `fixed` / `recurred` — declared, SUPERSEDED, and must stay unwritten. Recurrence lives on `recurrence_count` instead (below); `fixed` should never be written at all, because absence of a finding is not evidence it was fixed — a reviewer that was skipped, budget-killed, or simply reworded it produces an identical absence. Do not read `open` as "still outstanding".

Both UPDATE paths are scoped to the CURRENT round and guarded on `disposition = 'open'`. The round scope matters because the same fingerprint recurs on its own row every round, so an unscoped update rewrites the history of rounds the developer never saw — and because with no `fixed` writer, an earlier round's rows are `open` whether they were fixed or recurred. The `open` guard keeps the more specific verdict: a refuter's disproof and a gate-1.5 waiver both outrank a blanket acceptance. Findings raised AFTER the acceptance stay `open` and are NOT swept into it — the developer accepted the remainder they had been shown, not findings nobody had seen yet. That is the normal case, not an edge one: acceptance stands down the FIX loop only, while `restartLoop` (a gate-2 reject) is suppression-immune, so a later round runs and records more. MEASURED on the dev install, every accepted task has findings past its accepted round (accepted 7 / findings to 9, 4 to 5, 5 to 7, 6 to 9). Those surface at gate 2, where the call is the developer's again.

A waiver is CONTEXT, never SUPPRESSION. Nothing reads `dismissed_human` back, and 08d2's detect deliberately does not fold on it. A verdict is about a MOMENT, not about the defect — the reason 08d gives where it carries its disproved set forward, and a human declining to spend a round on something is far weaker evidence than a PoC a verifier actually ran and could not reproduce. What a partial fix round leaves behind instead is a task-ledger entry (`formatWaiverLedgerEntry`) whose wording invites a re-raise and asks what changed; `augmentPromptWithLedger` already carries it into the next round's prompts, so it needs no plumbing of its own. Accept-as-is at gate 1.5 records NOTHING — those findings still surface advisorily at gate 2, so the call is deferred rather than made.

`recurrence_count` records how many EARLIER rounds of the task already saw that reviewer flag that FILE, stamped at insert by `recordReviewFindings` from `loadFindingRecurrence`. A counter beside the verdict rather than a disposition value, for two reasons: recurrence is orthogonal to a ruling (a finding can be both refuted and recurring, and `disposition` holds one value), and both disposition UPDATE paths are guarded on `disposition = 'open'`, so a `recurred` written there would hide exactly the most-repeated findings from a gate-1.5 waiver and from the escalation gate's acceptance. Surfaced two ways: `recurrenceTag` prefixes gate 2's finding lines with `[repeat xN]` plus a one-line legend, and `buildRecurringNote` (08c) hands the next fix round an "Already tried" block, since each round is a fresh `claude -p` and `loadPriorFixContext` dedupes prior diagnoses by prose.

The key is `(reviewerId, normalised path)` — deliberately NOT `fingerprint`. MEASURED across 9,750 findings in 68 multi-round tasks: the fingerprint matches across rounds 5 times (0.05%) because it hashes the issue TEXT and two rounds' descriptions of one defect are different sentences, while (reviewer, path) matches 1,408 of 3,294 (42.7%) and reading the rows confirms those are one complaint re-raised — one across 19 rounds, every row still `open`. The cost of the coarser key is that two DISTINCT defects in one file count as a repeat, which is why every surface says "this reviewer already flagged this file" and never "the same defect". Nothing branches on the count; it informs a human and a prompt.

`fingerprint` is `sha256(reviewerId, path, normalised issue)` — line numbers and ids stripped, path KEPT, since the same defect in two files is two findings. Rows are written PRE-merge, one per adversary that reported a finding, while every later step sees only the survivor of 08d's location merge and has no reviewer id to rebuild a key from. That is why 08d attaches the collapsed set to each surviving finding as `fingerprints[]` (same shape and reason as 08c's `RefutableFinding.fingerprints`), on the OUTPUT copy only so the merge's own objects and `raw` stay untouched.

The canonical `findingFingerprint` implementation lives in
`packages/shared/src/step/review.ts`, re-exported by the worker's `_review-findings.ts`.

## Insight application journal

`insight.batch` task events are required state, separate from review telemetry. Protocol
and envelope version 1 record `manual_08e`, `auto_08e` or `gate3` intent, reservation, invocation and outcome stages.
The intent names the source step row, explicit rerun generation, stable occurrence ids and
loader identities, and starts every selected item as unconfirmed. Each stage is deduplicated
by batch/stage/generation while holding the owned source-row lock and the task owner/epoch
fence; dead and terminal task states refuse writes. Pause lets an existing intent finish; a new automatic intent is held. A failed required write prevents
dispatch. Reservation references share the mining insert transaction.

The editor reports exactly the selected id set, with `applied`, `already_handled` or
`not_applied`, change descriptions and a reason. Applied requires a nonempty change list.
Malformed replies and legacy scalar reports remain unconfirmed per item; the editor is never
automatically rerolled. Write and replay paths refuse unknown or unreadable stored records.
The acted-insight projection skips those records with a payload-free warning, leaving the
items unacted so they are offered again. Selecting such an item still fails at the strict
intent write while the unreadable record remains; only an empty submit passes. Reports describe agent
claims, never verified repairs, and never write `review_findings` dispositions. The journal
survives output-clearing Retry; an intent without a settled report remains unconfirmed.

## Insight continuation state

A nonempty settled manual outcome containing an applied report can authorize a v1
`insight_revise` continuation. Its source row, generation, batch and fresh check round
are persisted in the output/routing verdict and required `insight.continuation` event.
The event and any `validation.recheck_requested` return address commit with the task
pointer under owned fences; neither is best-effort telemetry. Continuations never alter
review dispositions or report an item as verified merely because its writer said applied.
The configured check tail returns to an owned 08e checkpoint. Manual applications end
there without another selection; automatic applications refresh the inventory for the
next bounded cohort. Gate-3 picks use the same journal and the gate-3 continuation mode described below.

`insight.auto_round_started` is required protocol-v1 state. The owned source-row lock
precedes a task-row lock, serializing task-wide admission and the event insert.
Each task has at most three claims, including failed classifier opportunities. Retry
and Resume retain these events; epoch takeover reuses the same source generation.
Claim reads pick their known input fields and tolerate additive loader metadata;
unknown claim protocol versions and invalid required fields still refuse replay.
`insight.classified` records the exact id set, normalized consequence, host eligibility
and classifier invocation references before an `auto_08e` writer intent is dispatched.
Missing, duplicate, invented or malformed classifications get at most one second
classifier attempt, then a manual reoffer with unclassified items. Security, data-loss
and regression kinds are forced consequential on the host. Unknown ownership,
unsafe/protected/missing/linked locations and upstream/framework source cannot authorize
automatic edits. Minor and nit results remain listed, never selected automatically.
New identities after the third claim remain unclassified with `cap_reached`.
These are agent classifications and application reports, never verified-repair telemetry.

A justified `not_applied` is a settled decline, not an interruption: it stays selectable
manually and does not prevent new identities from being classified in the next round.
Only `unconfirmed` or a missing writer outcome holds new automatic work for inspection.
Claims without results and eligible consequential results without a journal selection
are reoffered manually after explicit Retry, with `pending_writer`; spending a classifier
opportunity never silently settles an unwritten improvement.

## Insight summary reports

`InsightSummary` is a deterministic protocol-v1 projection of inventory, classifications
and the required batch journal. Class is independent of outcome. Shifted aliases are
grouped, every selected occurrence retains its attempt, legacy picks stay unconfirmed,
and conflicting reports within one batch show mixed rather than an applied claim.
Item, field, provenance and attempt display copies are bounded with explicit omissions.
Neither the summary nor an agent's applied report writes a review disposition or claims
that checks passed without evidence.

For tasks with insight identities, gate-3 FormSchema sections show the summary and
apply persists `findingsSummary`. Zero-identity tasks retain their existing LLM recap.
Automatic history is loaded in `(created_at, id)` order; the summary uses the shared
`INSIGHT_AUTO_ROUNDS` bound for both its stop reason and cap-reached item outcomes.
A generic report link remains readable after completion, including quick paths without
learning. Required `task.markdown_report` events hold complete immutable snapshots,
one per source generation, written under source ownership and task owner/epoch/dead/
terminal fences. Each insight and each attempt is a separate bounded report entry. Full original
occurrence fields and every source reference follow in deterministic chunks of at
most 2,000 source characters before escaping; clipped form copies do not replace
complete report evidence.
The owner-scoped `GET /tasks/:id/reports/:reportId` pages entries, and `/events` bounds
its item copies too. Unsupported report payloads return typed HTTP 422 rather than
an internal-server error. The generic reader renders every body through MarkdownView.
`insight.page` and `task.markdown_report` stay available through the API and are hidden
from the human Activity feed alongside insight batch records.
