---
name: claude-config-notice-is-noise
description: "'Claude configuration file not found at /home/node/.claude.json' leads the error text of a failed sandbox claude command but is routine noise - the cause is the LAST stderr line; throwaway-container repro recipe"
metadata:
  node_type: memory
  type: feedback
  originSessionId: a644756a-a3e2-4e31-883e-4ea8e833a31b
  modified: 2026-10-03T14:09:04.764Z
---

A sandbox `claude` run prints `Claude configuration file not found at: /home/node/.claude.json` plus `A backup file exists at: ...~/.claude/backups/...` on stderr whenever the container is fresh (HOME is ephemeral) but the persisted `~/.claude` auth volume already holds a config backup. It appeared in invocations that exited 0 (task fdd57e6b, 2026-10-03), so it never explains a failure.

**Why:** `01b-install-plugins` failed with that text FIRST in its error and `✘ Path does not exist: /haive/workdir/.claude/plugins/drupal-php-lsp` LAST. `stderrTail` keeps the final 1000 chars, so the cause sits at the bottom. Reading the top line pointed the first reading at the auth volume (the task volume had a `not ready, recreating` warn 9s before the backup stamp, which looked related and was not).

**How to apply:** read the last stderr line of a failed plugin or CLI command first. To prove a cause, run the exact argv in a throwaway container: `docker run --rm -u node --network none -v <scratchpad>:/s:ro --entrypoint sh blank-cli-sandbox:<claude-code tag> /s/repro.sh`, no auth volumes, one arm for the failing input and one control. The real plugin files come from `DRUPAL_LSP_FILES` via `docker exec -w /app/packages/worker <worker> node --import tsx -e 'import("./src/step-engine/steps/onboarding/07-generate-files.ts")...'`. The task env image (`*-env-task-*`) has no `node` user and is not what runs CLI plugin commands.

Related: [[haive-blank-second-install]], [[chrome-mcp-browser-check-gotchas]].
