---
name: repo-scope-editor-browser-check
description: How to make the /repos scope editor visible for browser verification without running a full onboarding
metadata:
  type: reference
---

The repos-page scope editor (`Exclusions` button) is gated on
`repo.status === 'ready' && repo.scopeExcludeGlobs !== null`, and `scope_exclude_globs` stays NULL
until onboarding step `09_7-rag-source-selection` runs — an agentic multi-step flow.

To verify scope-picker changes in the browser without onboarding:

1. Make a throwaway git repo under `$HOME` (the api/worker mount it at `/host-fs`, see
   `HOST_REPO_ROOT` in `.env`), then add it via `/repos/new` → Local directory → Pick.
2. `PATCH http://localhost:3001/repos/<id>/exclusions` with any list. That sets the column non-null,
   so the editor appears — and it is also the endpoint under test.
3. Drive the api from the page itself with Chrome MCP `evaluate_script` + `fetch(..., {credentials:'include'})`;
   auth is cookie-based, so a page-context fetch is already authenticated.
4. Delete the repo via `DELETE /repos/<id>`. Safe for a `/host-fs` reference repo: the worker only
   `rm -rf`s a storagePath under `WORKER_REPO_STORAGE_ROOT` (`task-queue.ts`), so the source dir survives —
   remove it yourself.

Credentials: see [[haive-dev-login]].

Note: `docker ps` / `docker logs` / `docker exec` sometimes hang for minutes while the worker is
churning DinD containers, even though the daemon answers `curl --unix-socket /var/run/docker.sock /_ping`.
Prefer HTTP against the api over shelling into containers when the stack is busy.
