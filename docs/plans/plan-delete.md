# Delete a plan

## Context

A plan is built by an LLM across many waves. When it does a poor job there is
currently no way to remove it — nodes can be deleted one at a time, and a 226-node
plan cannot realistically be cleared that way. The user asked for a delete
affordance beside the plan title, behind a type-the-name confirmation.

This is destructive and effectively irreversible, so the recovery path is stated
first.

**Rollback.** `.haive-data/plan.json` is COMMITTED, and `importPlanMirror`
recreates nodes with their ORIGINAL ids — so node ids quoted in specs and in
`plan.md` stay valid across a restore. To undo a delete:
`git checkout HEAD -- .haive-data/plan.json .haive-data/plan.md`, then re-clone
the repository; the clone path (`repo/clone.ts:193`) imports the mirror whenever
the repo has zero plan rows, which is exactly the post-delete state. There is NO
undo for a plan that was never committed, and the dialog must say so rather than
imply a safety net that is not there.

## What delete actually destroys

Everything below hangs off `plan_nodes` by `on delete cascade`
(`schema/plan.ts`): the nodes, `plan_node_edges`, `plan_node_code_links`,
`plan_node_messages` (every plan chat transcript), `user_plan_node_reads`, and
the `plan_node_tasks` LINK rows.

The TASKS themselves survive — `plan_node_tasks` cascades, `tasks` does not.
Deleting a plan must never delete a user's work, and the dialog says which of the
two it is.

## A. API — `DELETE /:id/plan`

`packages/api/src/routes/plan.ts`

1. **Refuse while something is writing.** 409 when the repo has an open
   `plan_build` / `plan_chat` / `advisory` task (status not in
   completed/failed/cancelled — the `notInArray` shape already used at
   `repos.ts:124`). The response names those tasks so the UI can link them. A
   builder wave landing after the wipe would re-create a partial plan out of
   nothing, which is worse than either outcome on its own.
2. **Re-check the typed confirmation server-side**: body `{ confirm }` must equal
   the repository name. The dialog is a UI affordance; the endpoint is what
   anything else calls, and a destructive endpoint cannot take the client's word
   that a human was asked.
3. **Delete through `applyPlanPatch`** — `findPlanRoot`, then one
   `{ op: 'delete', nodeRef: root.id }`. The subtree goes by FK cascade
   (`apply-patch.ts:371`), so this stays inside the ONE-writer rule and adds no
   second bypass beside `importPlanMirror`.
   Deliberately WITHOUT `expectedVersion`: the user is deleting the whole plan,
   so a concurrent edit to one node does not change their intent, and a 409 there
   would be noise on the one action where a retry loop is least wanted.
4. **Then remove the mirror** (`.haive-data/plan.json`, `plan.md`) via
   `HAIVE_DATA_FILES` and the `resolveRepoRoot` helper already in `repos.ts`
   (which will need exporting, or a local twin in `plan.ts` — prefer exporting).
   DB first, mirror second: the DB is the source of truth and the mirror is
   derived, so a failure after step 3 leaves a stale file that the next clone
   would restore, which is reported, not silent. A file that is already absent is
   success, not an error.
5. Return `{ deletedNodes, mirrorRemoved }`. `mirrorRemoved: false` is surfaced by
   the UI — it is the resurrection path.
6. `PLAN_CANVAS_ENABLED` off does NOT block this. That switch refuses NEW plan
   work while leaving existing plans "readable and editable"; removing one a user
   no longer wants is the most editable thing there is.

The refusal decision goes in a pure helper — `planDeleteRefusal({ confirm,
repoName, openTasks })` returning `null | { status, code, message, tasks }` — so
the two guards are unit-testable without standing up the route.

## B. Web — trash icon + type-to-confirm dialog

`packages/web/src/app/(app)/repos/[id]/plan/page.tsx`, plus a new
`components/plan/plan-delete-dialog.tsx`.

- A `Trash2` icon button beside the `<h1>` at `page.tsx:405`. Icon, not a red
  button, as asked — the weight belongs in the confirmation, not in a control
  someone brushes past.
- The dialog (built on the existing `components/dialog.tsx`) states the counts,
  names what survives (tasks) and what does not (chats), renders the repository
  name in a selectable `<code>` to copy, and enables Delete only on an exact
  match after trimming. Case-sensitive: this is the one place where "close
  enough" is the wrong answer.
- Matching goes in `plan-delete-confirm.ts` as a one-line pure predicate with
  tests, since the web setup can only test pure `.ts` (no JSX transform, no RTL).
- On 409, the dialog shows the open tasks as links rather than a bare error.

## Files

- `packages/api/src/routes/plan.ts`, and `routes/repos.ts` (export
  `resolveRepoRoot`)
- `packages/api/src/lib/plan-delete-refusal.ts` + test
- `packages/web/src/lib/api-client.ts` (`deletePlan`)
- `packages/web/src/app/(app)/repos/[id]/plan/page.tsx`
- `packages/web/src/components/plan/plan-delete-dialog.tsx`,
  `plan-delete-confirm.ts` + test
- `packages/worker/test/plan-canvas-smoke.ts` (blast-radius check)

## Verification

1. Unit: `planDeleteRefusal` (wrong name, right name, open task of each of the
   three types, a COMPLETED plan task not blocking) and `plan-delete-confirm`
   (exact, trimmed, wrong case, empty). Per-container tsc, prettier, vitest in
   api, web, worker.
2. **Live-Postgres blast radius** in the plan-canvas smoke: build a plan with
   edges, code links, chat messages, a read row and a task link; delete the root
   through `applyPlanPatch`; assert every one of those tables is empty for the
   repo AND that the `tasks` row still exists. This is the assertion that matters
   most and cannot be made without a real database.
3. Live in the browser on a THROWAWAY repo, never the 226-node dev plan: create a
   small plan, confirm the icon, the copyable name, the disabled button, the
   mismatch case, then delete — plan empties, `.haive-data/plan.json` and
   `plan.md` are gone from the storage dir (check with `ls`), and the repo's
   tasks are still listed.
4. The 409 path: start a `plan_chat`, attempt delete, confirm it refuses and
   names the task.
5. Restore once, to prove the documented rollback is real rather than assumed:
   `git checkout HEAD -- .haive-data/plan.json`, re-clone, confirm the plan
   returns with the SAME node ids.
