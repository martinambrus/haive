# Import a plan document, or describe one

## Context

The plan builder has three server-side entry points and the UI exposes one.

`planBuildRequestSchema` takes `mode: 'from_repo' | 'from_md'` plus a free-text
`description`. All three are implemented: `sourceGuidance`
(`01-plan-build.ts:157`) has a `from_md` branch that tells the agent to decompose
an attached document, and detect reads `brief: (task?.description ?? '').trim()`
(`:333`) for a greenfield build. But the plan page only ever calls
`build('from_repo')` — `build('from_md')` has NO caller anywhere in the web
package, and `description` is never sent.

So a user with a plan already written in markdown has no way to import it, which
is what prompted this. And a blank repository — which we just made a first-class
citizen — has no knowledge base to mine and therefore exactly one way to start a
plan: typing a root node by hand.

Decided with the user: expose BOTH, on the plan page's empty state.

## A. Carry the document with the build request

`packages/shared/src/schemas/plan.ts`, `packages/api/src/routes/plan.ts`

- `planBuildRequestSchema` gains
  `document?: { filename: string; content: string }`.
- **`mode: 'from_md'` without a document is a 400.** The prompt branch tells the
  agent to read "the attached document"; dispatching that with nothing attached
  spends a CLI invocation to produce a plan for a file that does not exist.
- Content capped at 1 MiB. The streaming attachment route allows 25 MiB
  (`DEFAULT_TASK_ATTACHMENT_MAX_BYTES`), but that is a stream and this is a JSON
  field; a MiB of markdown is ~250k words, far past any plan document, and a user
  with more can attach it to an ordinary task instead.
- Written through `spawnPlanTask`'s `seed` hook, which runs after the row insert
  and BEFORE the enqueue. This is the same race the chat's opening message lost
  (fixed in 960b7ac1): the worker picks a job up immediately, and detect would
  find an empty uploads dir.

**One writer for attachments.** `attachments.ts` already owns the uploads dir
(`resolveTaskUploadsDir` — note it refuses read-only local repos and repos with
no `storagePath`), filename sanitising, `uniqueFilename`, `harmonizeDirOwnership`
and the `chmod`/`chown` to `NODE_UID`. Extract a `writeTaskAttachment()` both the
route and the seed hook call, rather than a second copy of permission handling
that is easy to get subtly wrong and only fails inside a sandbox.

## B. Three ways in, on the screen that already asks

`packages/web/src/app/(app)/repos/[id]/plan/page.tsx`

The "No plan yet" card gains two sections beside the existing knowledge-base
button and the by-hand root input:

- **Import a document** — a file input (`.md,.markdown,text/markdown`), read with
  `File.text()`, sent as `{ mode: 'from_md', document }`. The chosen filename is
  shown before the user commits, since the button spawns a task.
- **Describe it** — a textarea sent as `{ mode: 'from_repo', description }`.

All three navigate to the created task, matching the redirect shipped in
29d2b05b: building happens over there, and the task parks on its depth form
before spending anything.

Known wrinkle, deliberately not fixed here: a brief-driven build uses
`from_repo`, so `sourceGuidance` still says "This repository has no knowledge
base yet" and suggests `rag_search`. On a blank repo that guidance is inert
rather than wrong, and the brief itself reaches the prompt through `d.brief`. A
third mode for "brief only" would be a schema change to improve one sentence of
prompt copy.

## C. Files

- `packages/shared/src/schemas/plan.ts` (document field + the from_md rule)
- `packages/api/src/routes/tasks/attachments.ts` (export `writeTaskAttachment`)
- `packages/api/src/routes/plan.ts` (seed the document)
- `packages/web/src/lib/api-client.ts` (`buildPlan` body)
- `packages/web/src/app/(app)/repos/[id]/plan/page.tsx`

## Verification

1. Unit: schema — `from_md` with no document rejected, oversized content
   rejected, a document accepted; and the seed ordering test extended so the
   attachment is written BEFORE the enqueue, which is the whole reason the hook
   exists. Then per-container tsc, prettier and vitest in shared, api and web.
2. Live on a THROWAWAY blank repo, since each build spawns a real task:
   - Import a small `.md`. Assert the task was created with
     `metadata.planBuildMode = 'from_md'`, the file exists under
     `<storagePath>/.haive/task-uploads/<taskId>/`, a `task_attachments` row
     points at it, and the browser landed on the task — which must be parked at
     `waiting_user` on the depth form, so NOTHING has been spent.
   - Submit a brief. Assert `tasks.description` holds it and the task parks the
     same way.
   - Cancel both tasks and delete the repo and its storage dir afterwards.
3. Confirm `from_repo` still works unchanged from the same screen — it is the one
   path that already worked and the one most likely to be broken by moving the
   buttons around.
