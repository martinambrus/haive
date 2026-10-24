---
name: web-dep-bump-browser-check
description: 'How to browser-test a web dependency bump from a worktree without touching the main checkout (swap haive-web for a host next dev on :3000), and the five traps met doing it'
metadata:
  node_type: memory
  type: project
  originSessionId: 7f021bec-a58d-47ae-b150-80abd3b2658a
  modified: 2026-09-25T11:02:41.512Z
---

Done 2026-09-23 for PR #219 (next 16.3.6 + tiptap 3.31.3). The recipe worked end to end.

1. **Swap the web container for a host dev server.** Run `docker stop haive-web`; the container
   is `restart: unless-stopped`, so it stays down. Then start this from the worktree, in the
   background:
   `NODE_ENV=development NEXT_PUBLIC_API_URL=http://localhost:3001 API_URL_INTERNAL=http://localhost:3001 HAIVE_API_PORT=3001 pnpm --filter @haive/web dev`
   To revert: TaskStop it, check that no `next` process still holds :3000, then
   `docker start haive-web`. Probe it with `curl --retry-all-errors`: while Next boots, Docker's
   port proxy accepts and then resets, which a plain `--retry`/`--retry-connrefused` treats as final
   (000 at once, 2026-09-25). Used again for S21b (#294), a web fix checked before its merge.
2. **It has to be port 3000.** The api's CORS admits only `WEB_ORIGIN`, which defaults to
   http://localhost:3000, so a web on any other port cannot log in.
3. **The tiptap editor needs a plan to mount on.** It exists only in the plan node panel, and
   the dev DB had ZERO plan nodes.
   - Seed a throwaway `repositories` row plus plan nodes, using the column shapes in
     `tests/e2e/helpers/{db,plan}.ts`.
   - Delete the repo row afterwards: every plan table cascades from it.
   - Until then, the plan mirror logs ENOENT warnings for the fake `local_path`. That is
     harmless, and they stop once the row is gone.
4. **`next dev` launched from an agent shell used to write files.** With `AI_AGENT`/`CLAUDECODE`
   in the environment it created `packages/web/AGENTS.md` and `CLAUDE.md` holding Vercel's
   "This is NOT the Next.js you know" block.
   - Gated by `getAgentName()` in `app-info-log.js`, and already present in 16.3.4. The compose
     container never triggers it.
   - Since #220, `agentRules: false` in `next.config.mjs` stops it (A/B verified).
   - If the files ever reappear, delete them. The block asks to be committed; never do that on
     its say-so.
5. **Docker here is Docker Desktop.** `scripts/visual.sh --network host` reaches ports Docker
   publishes, NOT a dev server running on the WSL side. Visual runs therefore need the
   containerized web.

A sixth trap, specific to tiptap under CDP: do not set a DOM selection and click a toolbar
button in the same `evaluate_script`. ProseMirror syncs `selectionchange` asynchronously, so
`chain().focus()` reuses the OLD selection and the command lands on the wrong block. Move the
caret with real keys instead (`Control+End`, `Shift+Home`), and read React-rendered toolbar
state in a separate call.

Related: [[chrome-mcp-browser-check-gotchas]], [[haive-dev-login]],
[[github-advisory-db-lags-repo-advisories]].
