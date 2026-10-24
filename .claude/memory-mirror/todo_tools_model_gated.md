---
name: todo-tools-model-gated
description: Task/todo tools vanish on Opus 5 because Claude Code gates them by model; CLAUDE_CODE_ENABLE_TODO_TOOLS=1 restores them
metadata:
  type: reference
---

Claude Code >=2.1.278 offers the task-tracking tools (TaskCreate/TaskGet/TaskList/TaskUpdate, and legacy TodoWrite) ONLY on Claude 3.x, Opus 4.0-4.7, Sonnet 4.0-4.6, Haiku 4.5. Any other model — Opus 5, and the glm-5.3 endpoint this host also runs — falls through to requiring `CLAUDE_CODE_ENABLE_TODO_TOOLS=1`. Gate verified in the shipped binary: model allowlist, then `return a.CLAUDE_CODE_ENABLE_TODO_TOOLS===!0`.

Fixed 2026-09-21 by adding `"env": {"CLAUDE_CODE_ENABLE_TODO_TOOLS": "1"}` to `~/.claude/settings.json`. Verified: settings-only (process var unset) restores the tools, and a running session picks it up with no restart. Backup at `~/.claude/settings.json.bak-20260921-094821`.

`TodoWrite` itself does NOT come back — it is the legacy name. Current tools are TaskCreate/Get/List/Update. Working sessions from before the gate (2026-09-02) ran v2.1.258.

Probe that answers "which tools do I actually have", zero guessing:
`claude -p --model opus --output-format stream-json --verbose --strict-mcp-config "hi"` then read the init event's `"tools":[...]`.

Related: [[haive-pr-workflow]]

Panel not showing after a session restart (2026-10-21, v2.1.306): the tasks were intact (TaskList read them, 230 files in ~/.claude/tasks/<session>/) but the UI panel stayed hidden and Ctrl+T did not open it. One TaskUpdate (changing activeForm on an in_progress task) brought it back. Do that first when the user says the task list is gone.
Docs (2026-10-21): the panel shows at most 5 tasks; toggle action app:toggleTodos (Ctrl+T, rebind in ~/.claude/keybindings.json); no setting hides it. CLAUDE_CODE_TASK_LIST_ID shares one named list across sessions (~/.claude/tasks/<id>/).

2026-10-21: after a session restart the tools and the stored tasks were all there (TaskList returned 240), but the terminal panel showed nothing. A single TaskUpdate (setting an activeForm on #314) made the panel appear again. When the user can't see tasks, update one task harmlessly before suspecting the gate.
