---
name: fs-safe-live-verification
description: 'Live checks for the fs-safe series (#115-#159): attachments, KB save, archive download and ZIP import PASSED on the dev stack 2026-09-23; what is left needs a WORKFLOW task (00-triage, 11/11b gate, 12, cancel)'
metadata:
  node_type: memory
  type: project
  originSessionId: 4a63120c-9dc0-4fa4-9b6c-fc8a25973f1c
  modified: 2026-10-09T10:16:10.978Z
---

Raised in session e62dac9c on 2026-09-17 (the "three surfaces" note, turn 16800) and then
DROPPED: no later summary, memory or session carried it. Audited 2026-09-23, and nothing had run.

**Why:** CI proves the pieces against /tmp fixtures, never the pipeline — uid-0 api/worker writing
`haive_repos` while a uid-1000 sandbox reads it. Three uid-dependent defects in the series (#129,
#131, #132) were invisible on this host. It still runs as uid 1000 = `SANDBOX_UID`, so that
ownership divergence stays unreachable here whatever a live pass shows.

## Done — PASSED on the dev stack 2026-09-23, zero tokens

Throwaway repos and a greenfield plan build, all deleted afterwards.

- **ZIP import**, all three `~/repo-*.zip` through the real upload UI. clean: `ready`, no note,
  root-owned (0:0), no uid 65534. links: `ready`, note `2 archive member(s) were not extracted
(2 symlink(s)): config-ref, docs/readme-link`, rendered on /repos, one worker warn, no link in
  the tree. nested: flattened. No `.haive-extract-*` left.
- **Attachments**, via a greenfield plan build, which parks on "Plan depth" before any agent
  (0 `cli_invocations`). The first duplicate is ` (2)`, as it was BEFORE the refactor, not
  ` (1)`. Dedupe is per directory; a leading dot is stripped per segment; `..` returns 400. The
  zip expanded with its single top dir flattened, the symlink member was dropped and noted in
  `_PLAN_INPUTS.md`, and the .docx/.pdf sidecars carry the text. Everything is 1000:1000,
  0644/0755. Raw downloads are byte-identical. Single delete, zip delete (rows cascade and the
  expansion DIRECTORY goes) and folder delete (empty dirs pruned) all worked, and
  `_ATTACHMENTS.md` was rebuilt each time.
- **`PUT /files/content`** at API level on a root workspace: 200 and the bytes land, the owner
  goes root to 1000:1000, and the root claim is released after. Stale sha is 409; outside the
  KB, non-`.md` and `..` are 403; missing is 404; a symlink to `/etc/passwd` is 403 and passwd
  is untouched.
- **`GET /files/archive`**: a valid zip. A symlink is stored as a LINK entry, never followed.

Found while doing it, both PRE-EXISTING: see [[found-not-fixed-running-list]].

Harness notes: Chrome MCP `upload_file` accepts only paths inside the workspace roots, so stage
copies in the repo's gitignored `tmp/` and delete it after. The task page's Editor tab STARTS a
code-server container (`haive-ide-<task8>` plus a volume); a cancel reaps both.

## PASSED 2026-10-09 on a live quick_bugfix (task ea88adcf, session f3f0c544)

- **Attachments via the step-runner path:** `notes.zip` (nested `design-notes/badges/` + one symlink
  member) uploaded right after create. At `00-triage`: expansion row `notes/badges/verified-marker.md`
  with `expanded_from_id` = the zip (single top dir flattened under the zip's name), the zip's note
  `1 archive member(s) were not extracted (1 symlink(s)): design-notes/latest.md`, and the triage
  prompt names `_ATTACHMENTS.md` and carries `INCOMPLETE ARCHIVES:`.
- **`12-worktree-cleanup` `remove_only`:** the worktree dir is gone and `.git/worktrees` pruned (the
  directory itself absent); the branch is kept, as `remove_only` promises.

## Still open — needs a WORKFLOW task, by moment

- **`11-phase-8-learning` or `11b-kb-commit` parked on `waiting_form`:** the ONLY place the KB
  editor UI renders (keyed on `knowledgeDiffArtifactPath`; hidden once the step is done). Edit a
  KB `.md` in the diff viewer and save. The bytes land in the WORKTREE, owner 1000, and no root
  claim is taken; a second, stale tab gets 409.
- **Cancel wiring**, on a THROWAWAY workflow task only, cancelled after `01-worktree-setup`:
  expect a `worktree.removed` event with `method: 'rmdir'` and `branchDeleted: true`. Not free:
  the canary, triage and estimate all make LLM calls first.

**How to apply:** per [[own-post-step-verification]], when the user creates the task, arm ONE
Monitor on that install's postgres (`docker ps --filter name=postgres` first — a new install is
not `haive-postgres`) polling `task_steps` for the trigger step ids above, and run each check as
its step lands. Close items here as they pass. Indexed in [[onboarding-run-checkpoints]].
