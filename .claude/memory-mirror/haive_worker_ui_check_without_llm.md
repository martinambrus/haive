---
name: haive-worker-ui-check-without-llm
description: "Browser-check text a worker step writes, with no LLM call: run the step's real apply() from a temp tsx script under packages/worker/test/ inside haive-worker, on a fixture repo owned by the dev user"
metadata:
  node_type: memory
  type: reference
  originSessionId: 30519ee1-6515-4c11-a33c-53e31117a3e4
  modified: 2026-09-19T09:50:29.523Z
---

Used 2026-09-18 for plan chat's "N change(s) not applied" note (PR #171). The step's real `apply()`
ran against the live database with a scripted `llmOutput`, so the applier, the transcript insert and
the UI render were all real — only the model's text was not. Zero tokens.

- **The script must live under `/app/packages/worker/`** (e.g. `packages/worker/test/_tmp-x.ts`). A
  scratchpad path is not mounted in the container and cannot resolve `@haive/*`. `test/` is outside
  tsx watch's module graph, so writing there does not restart the worker. Run:
  `docker exec -w /app/packages/worker haive-worker node_modules/.bin/tsx test/_tmp-x.ts`.
- **The fixture repo must belong to the dev user** (the one `users` row that owns the repositories),
  or the UI never lists it: `source: 'blank', status: 'ready'`, plan built with `applyPlanPatch`.
  `plan_node_messages.task_id` is an FK, so insert a real task row for the turns to hang on.
- A fake `StepContext` needs only what the path touches (`taskId`, `db`, `logger`, `repoPath`,
  `cliProviderId`); `writePlanMirror` fails non-fatally on a `/tmp` repoPath.
- In the node panel, turns sit inside a COLLAPSED conversation under "Chat history" — a `wait_for`
  on the turn text times out until that group is expanded too.
- Clean up by deleting the repository (cascades nodes, messages, mirror state) and the task, then the
  script, and prove it with counts. The mirror sweep wrote no directory for a repo with no storage
  path.

Related: [[haive-dev-login]], [[chrome-mcp-browser-check-gotchas]].
