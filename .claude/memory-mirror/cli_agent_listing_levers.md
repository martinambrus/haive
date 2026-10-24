---
name: cli-agent-listing-levers
description: 'Every CLI call lists ALL repo agents (name+description, never bodies); measured sizes and which flags/mounts remove it per CLI'
metadata:
  node_type: memory
  type: project
  originSessionId: e62dac9c-0a5b-41ca-8f3f-eaec5bb75d8c
  modified: 2026-09-14T12:59:00.022Z
---

MEASURED 2026-09-14 on one test repo with [[cli-context-capture-harness]]:

- claude 2.1.270 (so also zai/ollama/muse/openrouter): one `- name: description (Tools: …)` line per `.claude/agents` file in a trailing system message, plus the Agent tool. 45 agents = 8,488 chars. tmpfs over the dir removes it with CLAUDE.md, tools and system prompt unchanged; `--disallowedTools Agent` removes 13,018. `--agents <json>` ADDS and never replaces; `--agent X` REPLACES the default system prompt (9,462 → 328 chars); `--append-system-prompt` keeps it. `--setting-sources user` also drops project CLAUDE.md; `--bare` leaves only Bash/Edit/Read.
- codex 0.154.0: roles listed inside `spawn_agent`'s param, 33 roles = 7,728 chars; masking `.codex/agents` removes them. See [[codex-multi-agent-not-off]].
- grok 1.0.31: `spawn_subagent` lists agents from `.grok/agents` + `.claude/agents` + `.agents/agents` (claude/cursor compat on by default); masking all three removes 6,723; `--disallowed-tools Agent` removes 18,315; `--no-subagents` changes nothing in the request.
- Bodies (markdown body, TOML `developer_instructions`) are never in any request.
- Haive's `agentDefinitionGuidance` pointer is mostly ignored: 05 spec-quality-reviewer assigned in 27 prompts, file opened 0 times; 08b test-writer 51 / 1.

**Why:** the user wants per-call personas instead of every agent in every call.
**How to apply:** proposed design = tmpfs-mask agent dirs in cli-exec (exempt 06_5-agent-discovery, 07_7-secret-sweep), inline the chosen body at dispatch (`adaptPrompt` in dispatcher.ts), deny the native sub-agent tool except for subagent_native. Re-measure after any CLI version bump.
