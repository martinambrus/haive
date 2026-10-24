---
name: cli-context-capture-harness
description: Zero-token way to see exactly what a CLI sends the model — point it at a local recorder inside its own sandbox image
metadata:
  node_type: memory
  type: reference
  originSessionId: e62dac9c-0a5b-41ca-8f3f-eaec5bb75d8c
  modified: 2026-10-02T21:41:17.008Z
---

`init` events only list names; the request body is the only proof of what reaches the model. Method used 2026-09-14:

- `docker run --rm --network none --user 1000:1000 -e HOME=/tmp/home -v haive_repos:/repos:ro <haive-cli-sandbox:provider-tag>` — the images are already built and ship node. uid 1000 matters: claude refuses `--dangerously-skip-permissions` as root.
- Inside, a node `http.createServer` on 127.0.0.1 records each body and answers 400, then spawns the CLI with cwd = a repo under `/repos/<user-id>/<repo-id>`.
- claude: `ANTHROPIC_BASE_URL=http://127.0.0.1:PORT ANTHROPIC_API_KEY=x`; the turn is the largest `/v1/messages` body.
- codex: `CODEX_HOME=<existing dir>` plus `-c model_provider="cap" -c 'model_providers.cap={ name = "cap", base_url = "http://127.0.0.1:PORT/v1", env_key = "CAP_KEY", wire_api = "responses" }'`; tools arrive as an `additional_tools` input item, not top-level `tools`.
- grok: `XAI_API_KEY=x XAI_API_BASE_URL=http://127.0.0.1:PORT`; answer GET `/models` and `/api-key` with 200 or it exits "Not signed in"; the turn is POST `/chat/completions`.
- Hide a dir for one run: `--mount type=tmpfs,destination=<path>` over the read-only volume.
- `grok inspect` in a repo lists discovered agents/skills/rules with no model call.

**Host `claude` binary variant (2026-10-02, 2.1.288)**, for measuring what a session loads from a
checkout: a small node script starts the recorder and spawns `claude -p` itself, so no shell
variables are needed. Flags: `--setting-sources project --strict-mcp-config --mcp-config
'{"mcpServers":{}}' --no-session-persistence` (no user hooks, plugins, MCP or session file). Never
`--bare`: it skips CLAUDE.md auto-discovery. The child env must DROP `ANTHROPIC_API_KEY`,
`CLAUDECODE` and every `CLAUDE_*` var. Tool shells carry an invalid `ANTHROPIC_API_KEY` that beats
the claude.ai login, so a real nested run answers "Invalid API key" (and disables claude.ai
connectors) until it is removed. In a `.claude/worktrees/<x>` dir, claude loads the worktree's
CLAUDE.md and NOT the main checkout's one above it.

Related: [[cli-agent-listing-levers]], [[codex-multi-agent-not-off]], [[agents-md-split-review-check]].
