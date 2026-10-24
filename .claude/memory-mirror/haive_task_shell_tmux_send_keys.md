---
name: haive-task-shell-tmux-send-keys
description: "Never tmux send-keys into a haive-shell container's `haive-task` session — that pane is the user's live interactive CLI, and typing there submits a prompt to it"
metadata:
  node_type: memory
  type: feedback
  originSessionId: 875b871f-1831-4ac0-b0cf-01da5e1471de
  modified: 2026-09-06T21:48:08.369Z
---

Inside a `haive-shell-*` container, the tmux session named **`haive-task`** is the pane the
user's browser Terminal tab is attached to. It usually holds a RUNNING interactive CLI
(Claude Code, codex), not an idle bash prompt. `tmux send-keys -t haive-task "…" Enter` types
into that CLI and submits it.

**Why:** on 2026-09-06 a `send-keys` meant to print a copy-test string went into the user's
live Claude Code session and submitted `echo COPY_TEST_STRING_9988` as a prompt (it answered;
no tools ran, no files changed). Same session, `tmux set-option -g mouse off` also silently
broke wheel scrollback for the user until it was restored.

**How to apply:** before touching tmux in one of these containers, run
`tmux list-panes -t haive-task -F "#{pane_current_command} #{pane_current_path}"` and
`tmux capture-pane -t haive-task -p | grep -n . | head` to see what is running. Do experiments
in your OWN session (`tmux new-session -d -s probe …`), kill it when done, and restore any
global option you changed (`mouse`, `set-clipboard`) — they are server-wide, not per-session.
Killing the last session ends the tmux server and every attached client with it.

Related: [[chrome-mcp-browser-check-gotchas]], [[haive-dev-login]].
