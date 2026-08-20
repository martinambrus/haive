# Project Plan Canvas — implementation plan

## Context

Haive can execute a task end-to-end but has no durable, project-level picture of *what the
system is*. Every planning artifact it produces today is **task-scoped and terminal**: the
business-requirements doc (`03b`), the technical spec (`04-phase-0b-pre-planning`), and the
sprint DAG (`06b`/`06c`, rows in `task_dag_*`) all die with the task that made them. The KB
(`.claude/knowledge_base/`, written by onboarding `08`) is the only durable artifact, and it is
*descriptive* — how the code currently is — not *intentional*.

Consequences the user hit:

- A brand-new project cannot be planned in Haive at all. Everything is repo-anchored, and there
  is no way to create a repo that does not already exist (`repoSourceEnum`,
  `packages/database/src/schema/repos.ts:20-27`).
- The spec writer re-derives the system's shape from scratch on every task.
- Nothing can answer "if I change the backend here, what else must change?"

This plan adds a **plan canvas**: a durable, per-repo tree of components with typed cross-links,
statuses, per-node LLM refinement, and an impact view. It becomes the project-level counterpart
to the task-level spec chain, and feeds that chain rather than duplicating it.

**Outcome:** a repo (existing or greenfield) has one plan; the plan drills down from "the whole
product" to taskable leaves; leaves spawn workflow tasks and go green when they merge; non-code
blockers (legal, domains, hosting) are first-class and gate their ancestors; and the technical
spec writer is handed the component graph so its "affected components" section is grounded.

---

## Resolved design decisions

| Question | Decision | Why |
|---|---|---|
| Plan scope | One plan per repo | User decision. Enforced by a partial unique index on the root node, not a separate `plans` table. |
| Travels with clone | Yes, `.haive-data/` mirror | Same mechanism as onboarding state (`12-post-onboarding.ts:309`, restored at `repo/clone.ts:87`). `.haive-data/` is already in `BASE_STAGE_PATHS` and is deliberately distinct from `.haive/`, which `01-worktree-setup` adds to `.git/info/exclude`. |
| Import format | Arbitrary markdown | One-shot LLM decomposition into nodes. Not a sync. |
| Source of truth | **DB rows.** MD is a projection. | The agent gets the whole plan rendered as markdown *as prompt input*, and returns **structured node patches**, never edited markdown. One writer, auditable diffs, no lossy round-trip. `_fenced-json.ts` (`parseJsonLooseValidated`) already does this parsing everywhere else. |
| Chat primitive | Self-targeting `reviseLoop` | Already shipped: `11-phase-8-learning.ts:1125-1130` — uncapped, human-gated, form re-parks every cycle, one card. Transcript lives in its own table because a revise resets the step row. |
| Graph rendering | Reuse mermaid at `securityLevel: 'strict'` | `mermaid-block.tsx:12`. Click + zoom added by a wrapper around the rendered SVG. Never `'loose'` — these diagrams are LLM-authored. |
| Drill-down UI | CSS grid of cards + breadcrumb | No canvas/graph engine dependency. The described interaction is navigation, not free-form layout. |

---

## Data model

New file `packages/database/src/schema/plan.ts`, exported from `schema/index.ts`.

```
plan_nodes
  id, repository_id -> repositories(cascade)
  parent_id -> plan_nodes(cascade)          -- NULL = root
  path text                                 -- '/<uuid>/<uuid>/…', for subtree queries
  ordinal int                               -- sibling order
  title varchar(512)
  kind plan_node_kind                       -- 'component' | 'decision' | 'research' | 'external'
  body text                                 -- the node's plan section, markdown
  status plan_node_status                   -- 'todo'|'in_progress'|'blocked_human'|'done'|'not_applicable'
  taskable boolean                          -- leaf that a workflow task can be created from
  version integer                           -- optimistic concurrency
  created_by varchar(16)                    -- 'user' | 'llm' | 'import'
  source_task_id uuid                       -- which task last wrote it (no FK; mirrors dag rows)
  created_at, updated_at
  UNIQUE (repository_id) WHERE parent_id IS NULL     -- one plan per repo
  INDEX (repository_id, parent_id, ordinal)
  INDEX (path text_pattern_ops)

plan_node_edges
  id, repository_id, from_node_id, to_node_id, kind plan_edge_kind
  kind: 'depends_on' | 'affects' | 'implements'
  note text
  UNIQUE (from_node_id, to_node_id, kind)

plan_node_code_links                        -- impact analysis
  id, node_id, repo_path text, symbol text
  evidence text                             -- why the agent linked it
  derived_at_commit varchar(40)
  confidence real
  stale boolean default false
  INDEX (node_id), INDEX (repository_id, repo_path)

plan_node_messages                          -- per-node chat, survives step resets
  id, node_id, task_id, role varchar(16)    -- 'user' | 'assistant'
  body text, patch_json jsonb, created_at
  INDEX (node_id, created_at)

plan_node_tasks                             -- node <-> workflow task, many tasks per node
  id, node_id, task_id -> tasks(cascade), created_at
  UNIQUE (node_id, task_id)
```

Enum values added to existing enums:

- `workflow_type` (`schema/tasks.ts:50`) += `plan_build`, `plan_chat`, `advisory`
- `repo_source` (`schema/repos.ts:20`) += `blank`

**Status roll-up is derived, never stored.** A parent renders green only when every descendant is
`done` or `not_applicable`; any `blocked_human` descendant makes ancestors render blocked.
Computed in the list endpoint with one recursive query — storing it would need a trigger and
would drift.

**Migration:** `packages/database/src/migrations/0122_plan_canvas.sql` (next free number; 0121 is
current), plus `pnpm db:push` in dev. Rollback is `DROP TABLE plan_node_tasks,
plan_node_messages, plan_node_code_links, plan_node_edges, plan_nodes; DROP TYPE …;` — all five
tables are new and nothing else references them. The two enum additions are additive and are the
only part that cannot be dropped cleanly (Postgres cannot remove an enum label), so they are
left in place on rollback; unused labels are inert.

---

## Shared (`@haive/shared`)

- `src/schemas/plan.ts` — zod for node/edge/patch/import payloads. The **patch contract** the LLM
  must emit is defined once here and reused by every plan step:
  `{ ops: [{op:'upsert'|'delete'|'link'|'unlink', nodeRef, parentRef, title, body, kind, status, expectedVersion?, …}] }`.
  `nodeRef` is either an existing uuid or a builder-local temp id, so one turn can create a
  subtree and link into it.
- `src/types/index.ts` — extend `HAIVE_DATA_FILES` (`:209-213`) with
  `plan: '.haive-data/plan.json'` and `planMarkdown: '.haive-data/plan.md'`, plus
  `PLAN_MIRROR_SCHEMA_VERSION`. Follows the existing schemaVersion-gated mirror convention.
- `src/schemas/tasks.ts` — add `plan_build`, `plan_chat`, `advisory` to `workflowTypeSchema:3-8`;
  add optional `planNodeId` to `createTaskRequestSchema`.
- `src/schemas/repos.ts` — add `blank` to `repoSourceSchema:3-9`; `superRefine` must not demand
  `remoteUrl`/`localPath` for it.
- `src/constants/index.ts` — `REPO_JOB_NAMES.INIT = 'init-repo'` (`:33-40`).
- New `CONFIG_KEYS.PLAN_CANVAS_ENABLED` (default on) so the onboarding step can be switched off
  globally without editing the registry.

---

## API (`@haive/api`)

New `packages/api/src/routes/plan.ts`, mounted in `src/index.ts` next to the other repo-scoped
routers (`app.route('/repositories', planRoutes)`, matching how `upgradeRoutes` /
`toolingUpgradeRoutes` mount at `:81-82`).

```
GET    /repositories/:id/plan                 root + level-1 children + derived counts
GET    /repositories/:id/plan/nodes/:nodeId    one node, its children, edges, code links, tasks
GET    /repositories/:id/plan/tree             id/title/status/parent only (tree view)
GET    /repositories/:id/plan/search?q=        server-side filter, returns matching node paths
POST   /repositories/:id/plan/nodes            create (manual)
PATCH  /repositories/:id/plan/nodes/:nodeId    rename/move/status/body — requires expectedVersion
DELETE /repositories/:id/plan/nodes/:nodeId    cascade subtree
POST   /repositories/:id/plan/edges            create link
DELETE /repositories/:id/plan/edges/:edgeId
GET    /repositories/:id/plan/impact/:nodeId   transitive affected set + code links (mermaid src)
POST   /repositories/:id/plan/build            spawn plan_build task (mode: from_repo | from_md)
POST   /repositories/:id/plan/nodes/:nodeId/chat   spawn or continue a plan_chat task
GET    /repositories/:id/plan/nodes/:nodeId/messages
POST   /repositories/:id/plan/nodes/:nodeId/advisory  spawn an advisory task
```

**Counts** (`(3 / 412)` on each card) come from SQL over `path`, never from the client:
`COUNT(*) WHERE path LIKE node.path || '%'` for the subtree, direct children by `parent_id`.

**Impact traversal** walks `plan_node_edges` transitively with a visited set — the edge graph has
cycles by construction, so a naive recursive CTE without `UNION` dedup would not terminate.
Depth-capped and result-capped, with the cap reported in the response rather than silently
truncating.

The three task-spawning endpoints copy `global-kb.ts:295-385` verbatim in shape: validate repo +
provider ownership, insert the `tasks` row with `metadata`, enqueue `TASK_JOB_NAMES.START` on
`getTaskQueue()`. That is the established "UI button → LLM work" path.

Also changed:

- `routes/repos.ts:157` — accept `source: 'blank'`; skip the local-path checks; enqueue
  `REPO_JOB_NAMES.INIT`.
- `routes/tasks/index.ts:316` — accept `planNodeId` and insert the `plan_node_tasks` row.
- `routes/tasks/_helpers.ts` — on task completion, flip the linked node to `done`. (Task
  completion already has a single write path; hook there, not in the worker, so a cancelled task
  does not mark a node done.)

---

## Worker (`@haive/worker`)

### Blank repo

`packages/worker/src/repo/clone.ts` — new `handleInit(payload, db)`: mkdir under the repo storage
root, `git init`, write a minimal `README.md`, one initial commit, then call the existing
`persistDetection()` so the row lands `ready` with `storagePath` set. Wire into
`queues/repo-queue.ts:16-22` alongside CLONE/SCAN/EXTRACT/COPY.

### Plan mirror (travels with the clone)

New `packages/worker/src/step-engine/steps/plan/_plan-mirror.ts`:

- `renderPlanMarkdown(db, repositoryId)` — the whole plan as one markdown document, headings
  nested by depth, each section stamped with its node id. This is **the prompt input** for every
  plan LLM turn and the `.haive-data/plan.md` mirror. One function, one format, so what the agent
  reads and what is committed can never disagree.
- `writePlanMirror(db, repositoryId, repoPath)` — writes `plan.json` (nodes + edges, schemaVersion
  stamped) and `plan.md`. Called from plan-step `apply`, and from
  `12-post-onboarding.ts` `writeHaiveDataMirror()` (extend it; `.haive-data/` is already staged
  via `BASE_STAGE_PATHS:65-79`).
- `importPlanMirror(db, repositoryId, storagePath)` — called from `importHaiveDataMirror()` in
  `repo/clone.ts:87`. Non-clobbering and schemaVersion-gated exactly like the existing branches:
  only runs when the repo has zero `plan_nodes` rows.

### Plan applier — the single write path

`steps/plan/_plan-patch.ts`: `applyPlanPatch(db, repositoryId, patch, opts)` validates against the
shared zod contract, resolves temp refs, enforces `expectedVersion`, recomputes `path` for moved
subtrees, bumps `version`, and writes `plan_node_messages.patch_json`. **Every** LLM and UI write
goes through it. A patch that fails validation raises `RetryableParseError` (existing symbol,
`step-definition.ts`), which the runner already re-prompts on.

### New step sets

`steps/plan/` registered as three workflow types in `step-engine/steps/index.ts`.
`buildRunList` (`queues/task-queue.ts:152-170`) needs **no change** — any type other than
`workflow`/`run_app` runs its full registered list.

**`plan_build`** — `01-plan-build.ts`

- `detect`: mode (`from_repo` | `from_md`), existing node count, KB file inventory,
  attachment list.
- `form`: depth budget, breadth cap, whether to replace or merge into an existing plan.
- `llm` + `agentMining` + `loop`: **level-by-level expansion**. One LLM pass cannot emit 400
  nodes — the runner already names that failure (`truncationRetries`,
  `step-definition.ts:353-358`). Pass 0 produces the root plus level 1; each later pass fans out
  one mining agent per frontier node (`agentMining.selectAgents` re-runs at the start of every
  loop pass — see the `loop?` comment on `StepDefinition`), each returning a patch for its own
  subtree. `shouldContinue` stops when the frontier is empty or the budget is spent.
- Source material: `from_repo` reads `.claude/knowledge_base/` plus `rag_search`
  (`toolProfile: 'rag_only'` on the mining spec); `from_md` reads the uploaded markdown from
  `.haive/task-uploads/<taskId>/` — the existing attachment path, which is why the blank-repo
  work has to land first (`routes/tasks/attachments.ts:46-48` hard-fails without a repository).
- `apply`: `applyPlanPatch` + `writePlanMirror`.

**`plan_chat`** — `01-plan-chat.ts`

- `detect`: the node, its ancestry, prior messages.
- `form`: one textarea. Blank submit = end the conversation.
- `llm`: prompt = `renderPlanMarkdown()` (whole plan — this is what lets a chat rooted at
  "Android" also patch the QA node) + the node in focus + the transcript.
- `apply`: append both messages, `applyPlanPatch`, `writePlanMirror`.
- `reviseLoop`: self-target when the submitted text is non-blank — the exact shape of
  `11-phase-8-learning.ts:1125-1130`.

**`advisory`** — `01-advisory-research.ts`, `02-advisory-decision.ts`

For `kind: 'research' | 'external'` nodes: hosting comparisons, trademark checks, domain
availability. Research is a normal CLI invocation (the sandbox has network —
`sandbox/docker-runner.ts:326` — and tool control is a deny-list only, so `WebSearch`/`WebFetch`
are available on the claude-family adapters). The decision step parks on a form; **the user marks
it done, the agent never does.** Findings are written into the node body.

### Onboarding integration

New `steps/onboarding/10_8-plan-build.ts`, `index: 14.5` — after `10-rag-populate` (index 14,
`10-rag-populate.ts:490`) and before `11-final-review` (index 15,
`11-final-review.ts:189`). Registered in `steps/onboarding/index.ts`.

Slotted there deliberately: the KB is written (`08`), its gaps are closed by the QA chain
(`09`–`09_3`), and RAG is populated, so the builder has both the finished KB *and* retrieval over
the code. It lands before `12-post-onboarding` (index 16), which writes and stages the mirror.

`shouldRun` is false when `PLAN_CANVAS_ENABLED` is off or the repo already has a plan.

**Gap this does not close:** `onboarding_upgrade` only reconciles template artifacts
(`steps/onboarding-upgrade/`) — it does not re-run onboarding steps, so already-onboarded repos
never reach this. That is why `plan_build` is a standalone task type with a "Build plan from KB"
button, and the onboarding step is a thin wrapper that calls the same builder. One
implementation, two triggers.

### Impact analysis feeding the spec writer

- `steps/workflow/04-phase-0b-pre-planning.ts` — when the repo has a plan, the prompt gains a
  compact component index (id + title + one-line purpose, from `renderPlanMarkdown` at reduced
  depth) and the spec contract (`:283`) gains a required **Affected components** section naming
  plan node ids.
- `04`'s `apply` deterministically parses those ids, resolves them through `plan_node_edges`
  (transitive, cycle-guarded), and stores the resolved set on the step output. The parse is by
  node id — a stable identifier — not by matching the agent's prose.
- `06-gate-1-spec-approval.ts` renders it as an `InfoSection` containing a fenced mermaid
  diagram; `markdown-view.tsx` already renders those.
- `steps/workflow/11c-rag-reindex.ts` — after reindex, mark `plan_node_code_links` whose
  `repo_path` changed in this task as `stale = true`. **Link rot is the failure mode that makes an
  impact view lie**, and a stale flag is the difference between a wrong answer and an old one.

---

## Web (`@haive/web`)

New route `packages/web/src/app/(app)/repos/[id]/plan/page.tsx`, matching the existing repo
sub-page shape (`estimates/page.tsx` is the smallest reference: `useParams`, `usePageTitle`,
api-client call, `Card`). Entry button on the repo card in `repos/page.tsx:397-402`, beside
Estimates.

New components under `packages/web/src/components/plan/`:

- `plan-canvas.tsx` — breadcrumb + responsive card grid. Each card: title, status dot,
  `(immediate / total)`, kind badge. Click = select (right panel), double-click or the card's
  enter affordance = descend. Descend fetches one level; nothing preloads the whole tree.
- `plan-tree.tsx` — hierarchy-only tree (no edges, per the user's explicit call). Lazy children.
- `plan-detail-panel.tsx` — collapsible right panel: body via `MarkdownView`, status control,
  rename, create-task, chat tab, advisory tab, links list. Also the tablet-friendly home for
  actions that are hover-only on desktop.
- `plan-chat.tsx` — transcript + composer. Drives the parked `plan_chat` step through the
  existing `POST /tasks/:id/steps/:stepId/submit`; no new transport.
- `plan-graph.tsx` — mermaid `flowchart` of the selected node's neighbourhood or the impact set.
  Pan/zoom via a CSS-transform wrapper + wheel handler; click-through by attaching listeners to
  the rendered SVG's `[id^="flowchart-"]` nodes.
- `plan-status.ts` — status → colour/label map, unit-tested. Single source for both views.

`markdown/mermaid-block.tsx` — extract the module-level `loadMermaid()` singleton (`:8-16`) into
`markdown/mermaid-loader.ts` and import it from both. Mechanical, no behaviour change; keeps the
~1.5 MB chunk loading once.

`lib/api-client.ts` — typed wrappers for the new endpoints, following the existing exports.

---

## Work order

1. `blank` repo source — shared enum, API create branch, `handleInit`, repo-queue wiring, form
   option. **Unblocks greenfield, attachments, and the mirror location.**
2. Schema + migration 0122 + `plan.ts` exports.
3. `_plan-patch.ts` applier + `_plan-mirror.ts` render/write/import + clone-path hook.
4. Plan API router + api-client wrappers.
5. Drill-down canvas, tree view, detail panel, status colours.
6. `plan_build` step (both modes) + `POST /plan/build` + onboarding `10_8` wrapper.
7. `plan_chat` step + chat panel.
8. Node → workflow task seeding; completion → node status.
9. `advisory` task type + `blocked_human` roll-up rendering.
10. Impact: code links, `plan-graph.tsx` with click/zoom, `/plan/impact`, `04` spec-writer
    integration, `11c` staleness marking.

Items 1–4 are foundation; 10 is the largest single piece.

---

## Verification

Unit (`pnpm test`):

- `_plan-patch` — temp-ref resolution, `expectedVersion` conflict → rejection, subtree move
  recomputes every descendant `path`, delete cascades.
- `plan-status.ts` — roll-up: a `blocked_human` descendant blocks ancestors; `not_applicable`
  does not prevent green.
- Impact traversal — a deliberate edge cycle terminates and reports the cap.
- `_plan-mirror` — render → import round-trips node count, parentage and edges; a
  schemaVersion mismatch imports nothing; import into a repo that already has nodes is a no-op.

Typecheck: `pnpm typecheck` (shared and database build first).

End-to-end on the dev stack (`pnpm docker:dev`), **in a browser via the Chrome MCP server** per
the standing rule, logged in at localhost:3000:

1. Create a `blank` repo → reaches `ready`.
2. Upload a markdown plan as a task attachment, run `plan_build` in `from_md` mode → nodes appear;
   drill down two levels; counts on the root match `SELECT count(*) FROM plan_nodes`.
3. Chat on a deep node, ask for a change that touches a sibling subtree → both nodes patched,
   transcript persisted, form re-parks (confirm the step stays one card and the round does not
   advance).
4. Mark a leaf taskable, create a workflow task from it, let it complete → node goes green;
   ancestors stay non-green while a `blocked_human` sibling is open.
5. Run an `advisory` task on a research node → it stays blocked until the user submits the
   decision form.
6. On an **existing onboarded repo**, run `plan_build` in `from_repo` mode → a plan is derived
   from the KB; check `.haive-data/plan.json` on the volume; re-clone the repo and confirm the
   plan restores and that a second import does not duplicate.
7. Run a workflow task on that repo → gate-1 shows the affected-components mermaid; click a node
   in the graph and land on it in the canvas.

---

## Risks

- **Plan/KB divergence.** The plan is intentional, the KB descriptive. They are linked, never
  merged. If the plan is not fed by task completion (item 8) it becomes a stale wiki — that item
  is load-bearing, not polish.
- **Link rot.** `plan_node_code_links` go wrong on every merge. The `stale` flag plus
  `derived_at_commit` is the whole defence; without it the impact view lies silently.
- **Build cost.** A deep `from_repo` build fans out one agent per frontier node. Breadth/depth caps
  are user-set on the form and enforced in `shouldContinue`; the agent-pool admission governor
  already bounds concurrency.
- **Concurrent chats.** Two chats patching one node is handled by `expectedVersion` → 409. The UI
  must surface the conflict rather than silently refetch.
- **Unverified:** whether `resetStepAndDownstream` clears a self-revised step's prior `output`.
  It does not matter here — the transcript lives in `plan_node_messages` for exactly that reason —
  but it would matter if anything later tried to read chat history back off the step row.
