# Plan canvas

`plan_nodes` and friends (`packages/database/src/schema/plan.ts`, migrations 0130/0131) are the durable, per-repo tree of what a project is MEANT to be — the intentional counterpart to the KB, which only describes how the code currently is. One plan per repo, enforced by a partial unique index on the root node rather than a `plans` table. A repo with no remote and no local tree is a first-class `source: 'blank'` repository: the repo-queue INIT job creates the storage dir, `git init`s it and lands one commit, so worktrees, task attachments and the `.haive-data/` mirror all work on a project that does not exist yet.

**One writer.** Every write — LLM turn, UI edit, markdown import — goes through `applyPlanPatch` in `@haive/shared/plan` (NOT the worker: the api writes plans too and cannot import the worker; `global-kb/task-context.ts` is the precedent for a shared package taking an injected `db`). It owns the materialised ancestry (`path`, self-inclusive and slash-terminated so one `LIKE 'prefix%'` selects a subtree), the `version` optimistic-concurrency check (a stale `expectedVersion` is a 409 the UI must SHOW, never a silent refetch), and subtree moves, which rewrite every descendant in one prefix-substitution UPDATE. Within one patch every op is checked against the version its node had when the patch first loaded it, so two ops a person approved together against version 3 both land; a version the node only reaches inside the patch, or a write by anyone else between two of its ops, is still a conflict. An agent's patch must carry that version for every existing node it changes or deletes (`requireExpectedVersion`, set by `applyAgentPatch`): an op without one is dropped and reported, where it used to skip the check and replace whatever a person had changed on the canvas since the agent read the plan. For the same reason it deletes only a node with no children, so a subtree goes leaf by leaf, each delete with its own version: the cascade from a parent would take descendants whose versions it never sent. An ordinal-only reorder is exempt, because the sequencing step writes a whole build order at once and a node-level version would reject it over an unrelated edit to one child (MEASURED: 1,350 of its upserts, none versioned); plan chat is shown every node's version (`withVersions`), which the committed mirror is not. The SQL offset must be cast — `substring(path from $n::int)` — because an untyped bind resolves to Postgres' POSIX-REGEX `substring(text, text)` overload and returns NULL. `importPlanMirror` is the ONE deliberate bypass: a mirror restore recreates nodes with their original ids verbatim (the spec writer and plan.md quote those ids), which the patch contract deliberately cannot express; it runs only when the repo has zero plan rows and refuses whole rather than half-import when the ids collide.

**Plan task types are not in `workflowTypeSchema`.** That zod enum is the create-task REQUEST validator; `plan_build` / `plan_chat` / `advisory` need a node id the generic form has no field for, so they are spawned by their own endpoints (`POST /repositories/:id/plan/...`) — the same arrangement `kb_author` already has. They live in the DB enum and in web's local `WorkflowType` union only.

**Completion greens the node** from the worker's `markTaskCompleted` (the only completion write; cancel and fail have their own functions, which is the point). Only `todo`/`in_progress` advance — `blocked_human` and `not_applicable` are verdicts a person entered, and a task finishing is weaker evidence than that. Status roll-up is DERIVED at read time (`rollUpStatus` in shared, one source for every view) and never stored: a `blocked_human` descendant makes every ancestor render blocked; green requires every descendant `done` or `not_applicable` — `not_applicable` must not prevent green, but must never render green itself either.

**Two triggers, one builder.** `createPlanBuildStep` (steps/plan/01-plan-build.ts) serves both the standalone `plan_build` task and the onboarding wrapper `10_8-plan-build` (index 14.5, after the KB and RAG exist, before the mirror is staged), because `onboarding_upgrade` reconciles template artifacts only and never re-runs onboarding steps — an already-onboarded repo can reach the builder no other way. The onboarding wrapper is opt-in (`askToRun`): its form warns of the token cost, defaults to skip and points to the Plan view's "Build from the knowledge base", the same builder later. The form keys on `askToRun` in the DETECT output, not on the option: the runner builds a form for any row with no saved schema, a `waiting_cli` one included, and reuses saved detect output, so a build in flight when the form shipped would otherwise park mid-build and drop its folded waves on the default skip. Only an explicit `buildPlan: 'skip'` declines (`planBuildDeclined`). The build is LEVEL-BY-LEVEL (wave 0 drafts root + level 1 via `selectAgents`; each later wave is thrown from apply() as a `MiningWaveError`, one agent per frontier node) because one pass cannot emit 400 nodes without truncating. Do NOT move it to `loop`: the runner's loop re-entry calls `resolveLlmPhase`, which asserts `stepDef.llm` exists — a mining-only loop step dies on its second pass with "reading 'prepare'" (measured, on a real repo). The frontier is recomputed from the DB every wave, and excludes `research`/`external` nodes (a blocker waiting on a person is not a system to decompose) and `taskable` leaves; per-wave agent ids (`plan-expand-<nodeId>-p<N>`) double as the asked-set, so a node is never re-asked even though apply passes are independent calls. Because a wave re-runs apply() with the CUMULATIVE result set and temp-ref creation is not idempotent, the fold is over `newAgentMiningResults` — `task_step_agent_minings.consumed_at` (migration 0132) is stamped on every row apply has folded right before the next wave dispatches and cleared on a re-roll, each row only at the run apply read (`consumeFoldedMiningRows`), so one another pass re-rolled meanwhile keeps its reply; for steps that never throw MiningWaveError the new field equals the cumulative set, so existing steps are unchanged. That set is decided once per pass, so each reply is also CLAIMED as it is folded (`applyAgentPatchOnce`, `_plan-prompt.ts`): its row's `consumed_at` is set, only while unset, in the same transaction as its patch, and so is the row's partial-apply note, since every later pass skips a claimed reply and a note written after the commit could be lost for good. Two apply passes over one wave, or one pass that re-runs apply in place after a wave that sent nothing, then write a reply once, and a reply another pass claimed counts as applied, so the builder's whole-wave re-roll does not fire on a wave that did land. 01, 02 and 03 all fold this way. A `ReopenStepFormError` consumes the rows apply folded and clears its detect output, form and answers in ONE transaction with `pause_form_on_retry` set, before it detects afresh, and writes the row only while the pass still owns it, since a Retry's reset keeps its own hold; a worker that dies before the new form is parked re-detects and stops at the form instead of re-sending the answered items with the old answers. The submit that led there can be redelivered, still carrying those answers, and a form submit carries no epoch to drop it by. While the hold is set, values a job carries are ignored, since the form has not been offered since. Once the form is parked, `isStaleSubmit` drops a submit older than the park. Every form park is stamped (`waiting_started_at`) in the write that parks it, not after, so there is no moment when a parked form has no park to be older than. A pass that dies between that write and marking the task waiting leaves the task `running`, and a stale submit landing on one parks the form again (`staleSubmitAction`) rather than only being dropped.

**Two modes, and the difference is the node status.** `from_repo` mines the KB and its nodes
arrive `done` because they describe code that exists; `greenfield` takes a written brief plus
any number of attachments and leaves them `todo`. A brief used to ride `from_repo`, which was
not inaccurate prompt copy but a project rendered as already finished. `from_md` (one inline
markdown document) is RETIRED from `planBuildRequestSchema` and deliberately alive in the
worker's `BuildMode`, so stored tasks stay retryable. An unrecognised stored value falls to
`from_repo` — a default rather than a throw, because that is what a revert would also produce.

**Clarifying questions come before the expansion** (`00b-plan-clarify`, index -0.5, opt-in per
task through `tasks.metadata.planClarify`, which the build route sets by default for a brief and
only on request for a knowledge-base build). The planner drafts root + level 1 from what the inputs
state, every assumption and conflict an open `decision`/`research` node directly under the root; a
questioner asks about it; the planner folds each round's answers in as a patch and marks every
answer `settled` or `open`, and open ones are asked again. The owner ends it, and 01 expands the
outline (its depth form says so through `outlineFromThisTask`). Planner and questioner are mining
SEATS (`STEP_MINING_SEATS`), not loop roles, so each runs on its own CLI; the route seeds the
questioner as a task step choice. Three decisions to keep. It cycles like 02, by waves and
`ReopenStepFormError`, NOT plan chat's self-revise: that reset deletes every round's agent rows and
supersedes their invocations, dropping the spend from statistics. Rounds live in
`plan_clarify_rounds`, and every move (`nextMove`) is decided from that table and the plan root, so
a Retry, a reopen and a redelivered submit all land on the same step; answers are written only
while `answered_at` is null, and a field id carries its round, so a stale submit for an earlier
round reopens the form instead. Its folds drop any node placed below the root
(`outsideOutline`): 01's frontier expands component LEAVES only, so a decision put under a
component would take that component out of the build with nothing reporting it.

**plan_chat** is one conversation on one card: a self-targeting `reviseLoop` re-parks the form every turn and the user ends it by submitting nothing. The transcript lives in `plan_node_messages` precisely because that revise resets the step row each cycle. The agent is handed the WHOLE plan (via `renderPlanMarkdown`, the same render committed as `.haive-data/plan.md` — one function so what the agent reads and what is committed cannot drift), so a request made while looking at one node can correctly patch another. **advisory** researches a non-code blocker and then STOPS: `02-advisory-decision` parks on a form and only the USER closes it — an agent concluding an unsigned contract is fine would turn a real blocker into a green tick.

**A sibling run too wide for one agent's reply is named, never sent.** The build-order step
(`03-plan-sequence`) asks one agent per undecided run for an upsert per child plus the links it
adds, and a patch holds `PLAN_PATCH_MAX_OPS` (500) ops, so a run past `SEQUENCE_MAX_RUN_CHILDREN`
(half of that) keeps its stored order and the finished step names it (`degradedNote`), and the
prompt states the op budget its reply has. `tooWideToSequence` is the one rule the fan-out and the
plan page's Order count (`computeSequenceProgress`) share, so the count never promises a pass that
would skip a group. A group counts as asked (`askedParents`) only while its agent row is `done`: a
reply rejected at apply (no patch, or one the applier refused) sets the row `failed`, so the next
pass asks that group again and the Order count keeps it. Each agent sees its node's neighbourhood, never the whole plan:
`buildPlanExpansionContext`, the helper 01 and 02 use, with the build-order number `#N` on every line
and no dependency information, and the context and the child list share one bound,
`SEQUENCE_CONTEXT_BUDGET` (96,000, as `PLAN_EXPANSION_CONTEXT_MAX_CHARS`). A child list at the cap
stays under it since `safeTitle` caps a title at 200 characters (MEASURED: no stored run came near the
cap, widest 33), and the helper keeps its own cap on a deep ancestor chain by dropping the most distant
ancestors behind one line that counts them. MEASURED on committed plan snapshots: the prompt p50 went
from 148,443 to 106,629 characters on a 7,983-node plan (870 agents) and from 119,003 to 106,622 on a
4,106-node one, while a 1,044-node plan grew slightly (103,099 to 106,909) as the sampled outline fills
the budget. Of the 9,312 `depends_on` ops sequence agents ever wrote, 9,288 joined two nodes of the
agent's own section and 24 were malformed, so the bounded view cuts no link an agent made.

**"Start next" is STRICTER than the gate that refuses a task, deliberately.** `computePlanReady`
(`shared/plan/ready.ts`) picks the lowest-numbered node that is startable now: `todo`, no unmet
`depends_on` of its own, **no ANCESTOR with one**, no open task on it, and a unit of work
(`taskable` for components and developer-task decisions; a leaf for human decisions,
research and external work, which carry `taskable` only sometimes — MEASURED 10 of 16 research
and 4 of 12 external nodes). A non-taskable leaf decision is still something a person can
resolve: MEASURED on the 20-node elmont_novy plan, the four foundation tasks and hosting were
done, but the unanswered domain decision was not taskable, leaving the ready set empty while
both catalogue and revisions waited on it. Such decisions now appear as **Decide next**, which
opens their panel to record the answer and mark Done; `taskable` decisions still open the
new-task form. `nextUp.node.taskable` tells the browser which action to offer. The ancestor
half is the point, and it is the half `blockedById` deliberately omits: MEASURED, 1,286 of
7,079 taskable nodes in one plan carry no prerequisite of their own and 23 also have a clean
ancestor chain, and on another plan the
lowest-numbered node the DIRECT rule calls ready (#28) sits under two containers that are
themselves waiting, while the strict rule picks #65. Do NOT reconcile the two readings: a rule
strict enough to CHOOSE must not REFUSE, because choosing badly wastes a click while refusing
badly turns one wrong-direction edge (15 of 16 unsatisfiable deps were exactly that) into a
locked subtree. `POST /tasks` stays direct-only; the node panel's `ancestorBlockers` banner is
what explains the skip, and says out loud that it does not stop you. Cycles need no test of
their own — their members never lose their blockers, so rules 2 and 3 already exclude them and
everything beneath them. `nextUp` rides the plan overview (a property of the PLAN, like
`ordering` and `defects`); the SET behind the count is `GET /plan/ready`, served in the exact
shape `/plan/search` returns so the page filters it with the machinery it already has, capped
at 200 and REPORTING the cap.

**Human resolutions have a direct form.** A non-taskable decision is labelled **Needs your
decision**, and an external item **Needs action outside Haive**, with **Record decision** /
**Record outcome** actions. Neither offers a developer task or the grid's task checkbox;
taskable decisions still do. Decision kind badges are visible even though the creation picker
does not offer that kind. The form uses `FormSchema` / `FormRenderer`, shows the existing
question, requires an answer, and offers **Resolved**, **Still waiting**, and **Not applicable**.
Unresolved items default to Still waiting so recording partial progress does not green them.
An item's own `done` or `not_applicable` status changes the panel to **Human item settled**,
with guidance for reopening it instead of instructions to act. Resolution and advisory buttons
are hidden until its status is reopened; Still waiting keeps both available. The description
and recorded answers remain visible. A successful write that reloads a settled status also
closes an open resolution form, including when the status editor settled the item.
The endpoint `POST /plan/nodes/:nodeId/resolution` checks repository ownership and the item's
kind, then passes one versioned body-and-status upsert through `applyPlanPatch`. The question
and prior answers remain verbatim, with a new `## Decision` / `## Outcome` section appended;
an unclosed top-level fence is closed through `scanFences` before that section. The form holds
the question and version it opened on, so a concurrent edit returns 409 and keeps the draft.
No migration or CLI invocation is needed to record an answer. **Help me evaluate the options**
is a separate optional advisory run; research still ends at a human decision gate. The pure
`@haive/shared/plan-resolution` subpath holds the shared UI/API policy and form without pulling
the database or host filesystem into the browser.

**An advisory holds its question.** Open advisories are linked by `tasks.metadata.planNodeId`,
not by `plan_node_tasks`: they neither implement a node nor touch its code. Readiness includes
those metadata links in its open-task exclusion. The node detail names an open advisory so
the panel offers **Continue research**. Advisory starts lock the plan node, reuse an existing
open advisory, or insert the new task in that transaction through `spawnPlanTask`'s injected
writer with `enqueue: false`; `enqueuePlanTask` delivers START only after commit. Two tabs
therefore continue one run. The advisory's final form writes with its detect-time node version,
matching the question and body it actually showed: a direct answer or plan chat landing while
it is parked must conflict rather than be overwritten with stale text or status. A freshly read
version with a detect-time body used to bypass that protection.

**Impact answers "if I change this, what else must change?"** (`shared/plan/impact.ts`): an explicit BFS with a visited set, because the edge graph has cycles by construction and a recursive CTE without dedup would not terminate while one with dedup could not say where it stopped. Both caps are REPORTED, never applied silently. The mermaid source encodes nodes as a `pnode<32 hex>` token; the browser recovers the uuid from THAT, unanchored — mermaid prefixes rendered ids with its own render id, so a `^flowchart-` anchor binds zero handlers and fails silently.

The walk takes a SET of origins, because gate 1 asks the question of every component a spec named rather than of one of them. Two consequences. `depth` is then the distance to the NEAREST origin, which is the honest number — the per-origin walks it replaced recorded whichever origin reached a node first in list order, and MEASURED on a real task that reported 1 node at one hop where the multi-origin walk finds 72. And every origin is seeded as visited, so the walk never discovers an edge BETWEEN two origins: `renderImpactMermaid`'s `edges` option exists to draw those, and without it a multi-origin picture is a row of disconnected boxes. The diagram's `maxNodes` bounds HOPS only — origins are always drawn, so a caller with more origins than a picture can hold must decide not to draw one. **Code links** have one writer (the applier; the builder only links files it actually opened, with `evidence`) and rot is flagged, not guessed away: `11c-rag-reindex` marks links stale for the paths in `tasks.changedPaths`, and only re-assertion by an agent clears the flag — the difference between an impact view that is wrong and one that is merely old.

**Spec-writer integration:** when the repo has a plan, 04-phase-0b is handed a compact component index and must emit an `## Affected components` section naming `node:<uuid>` ids. `resolveAffectedComponents` (`workflow/_affected-components.ts`) parses those IDS — never the agent's prose, because name-matching picks the wrong node the first time two read alike — and walks the edge graph from all of them. It lives in its own module because two steps must agree on the answer: 04 stores it for the implementer's prompt (`_plan-impact.ts`, which states the invariant — agent and human reading different blast radii is worse than either reading none) and 06 renders it to the approver.

**Two things bound what the plan can do to that prompt, and both were measured on a 544-node plan.**

`recordTouchedPlanNodes` writes a `touched` link for every component the spec named, and `loadSeededPlanNodes` reads `implements` ONLY. Reading both made the step feed its own output back in: MEASURED on task 681f0f99, 5 links at task creation, +157 the moment 04 round 0 ended and +201 the moment round 1 ended, so 363 nodes were re-rendered IN FULL WITH BODIES — the seeded block went 9,493 to 232,365 chars and the whole spec prompt 219,412 to 441,506, against 43,641 for the same task with no plan. It compounds every round. That is the same role split `completePlanNodesForTask` relies on to avoid greening a node the task merely touched, so a reader that ignores the role is the bug, not the column.

`renderBoundedPlanIndex` then steps the index's DEPTH down until it fits `PLAN_INDEX_MAX_CHARS`, stating the reduction in the prompt. Depth, not a character slice: a slice ends mid-node and leaves a truncated `node:<uuid>` the writer can quote back as whole. The bound is a GUARD RAIL — 120k sits above every index measured on a run that went well, so nothing observed working is trimmed. Worth knowing before tuning it: the index is the DOMINANT term in every planned run, MEASURED at 93,035 of 124,215 chars (75%) for a 174-node plan, 115,620 of 133,331 (87%) for 193 nodes and 158,274 of 219,412 (72%) for 544. Whether a shallower index costs spec quality has NOT been measured; ~40k halves the spec prompt and is the experiment to run.

**The gate renders it as the plan canvas's own Impact view, not as prose.** The section carries `planImpact` on the form schema (`shared/schemas/form.ts`) and `PlanImpactSection` (`web/components/plan/`) draws depth groups → relation sub-groups → click-through rows, reusing the `PlanImpactList` the detail panel's Impact tab uses. It replaced one markdown list: MEASURED on a real task, 363 flat bullets in a `max-h-96` scroller holding 10,459px, with the distance an impact answer is ABOUT reduced to a `(2 hops)` suffix, nothing clickable, and a diagram seeded from `named[0]` ALONE that drew 19 of the 363 while reporting `mermaidOmitted: 0`. `body` is empty on such a section — one rendering, not two — and a section persisted before `planImpact` existed has neither and still renders as markdown, which matters because `task_steps.form_schema` is STORED and only rebuilt when it is null. 06's detect re-walks a payload that predates `mermaidDepth` rather than defaulting `reversed`, since a fabricated direction inverts every "Depends on" / "Depended on by" heading.

**The radius is a control, not a constant.** The gate carries the same reach buttons the Impact tab has, but over a FROZEN snapshot — so the resolver renders one bounded diagram per radius the walk reached and the buttons switch between them. The browser cannot draw its own: a hop in the payload carries no `viaNodeId`, and re-deriving a traversal there would put the cycle guard and the caps in two places. Only radii the walk actually reached get a button, because the panel's fixed 1-4 can afford one that returns nothing (it re-fetches) and a snapshot cannot.

`IMPACT_DIAGRAM_MAX_NODES` is the whole picture's budget, spent on ORIGINS first and on neighbours with what is left, so a wide named set draws origins alone. That is a real subgraph, not a row of loose boxes: MEASURED on the 161-named task, the first 40 named components carry 40 edges between them and only 4 of the 40 are isolated (217 edges among all 161) — which is why an earlier version that refused to draw past 40 origins was wrong. Origins are taken in SPEC order because which 40 got drawn has to be answerable, and "the ones the spec cites first" is checkable where a connectivity ranking is not. `namedOmitted` states the rest. A consequence worth knowing: nearest-first ordering means a wider radius only appends nodes that the budget then cuts, so once the picture is full it stops changing with the radius while the list keeps growing — the omission line says so. No count is ever subtracted from another: the diagram and the list walk different radii from different origin sets, so no arithmetic between them would be true.

The mirror (`worker/src/plan/mirror.ts`) writes `.haive-data/plan.json` + `plan.md` from every plan-step apply and from `12-post-onboarding`; `persistDetection` imports it on clone. `CONFIG_KEYS.PLAN_CANVAS_ENABLED` (admin toggle) off refuses new plan tasks and makes the onboarding step self-skip; existing plans stay readable and editable — hiding a plan someone made reads as data loss. Web: drill-down grid, not a graph engine (`components/plan/`); `plan-status.ts` is the single status→colour source; counts are server-computed. Live-Postgres coverage: `pnpm --filter @haive/worker smoke:plan-canvas` (107 checks).
