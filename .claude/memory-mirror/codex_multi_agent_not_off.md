---
name: codex-multi-agent-not-off
description: "codex 0.154.0 keeps spawn_agent + team prompt in every request despite Haive's multi_agent_v2=false; no flag found that removes it"
metadata:
  node_type: memory
  type: project
  originSessionId: e62dac9c-0a5b-41ca-8f3f-eaec5bb75d8c
  modified: 2026-09-14T12:58:52.400Z
---

MEASURED 2026-09-14 (codex 0.154.0, [[cli-context-capture-harness]]): `codex features list` shows `multi_agent` (v1, stable) true by default, and Haive only overrides `multi_agent_v2`, which was already false (`CODEX_MULTI_AGENT_OFF` in `packages/worker/src/cli-adapters/codex.ts`). Every exec request still carries the `spawn_agent` tool (its `agent_type` param lists every `.codex/agents` role), a "primary agent in a team" developer message and `<multi_agent_mode>`. The request is byte-identical under `--disable multi_agent`, `-c features.multi_agent=false`, collaboration_modes/multi_agent_mode off, and model gpt-6-astra; `agents.max_threads=0` is rejected ("must be at least 1"). DB: 989 collab `wait` calls in 132 codex runs, 2026-09-07..09-12.

**Why:** catalog.ts, codex.ts and AGENTS.md all claim codex multi-agent is off, and sub-agent threads' tool calls never reach the parent transcript (rag_query_log 3,103 rows vs 1,108 calls seen in transcripts).
**How to apply:** do not trust the "off" comment until re-measured; masking `.codex/agents` removes only the roles listing, not the tool.
