---
name: codex-exec-as-builder
description: 'How to run Codex CLI as a headless builder/fixer from a Claude session (flags, stdin, effort values, where usage and effort are recorded); smoke-tested 2026-10-17'
metadata:
  node_type: memory
  type: reference
  originSessionId: f5017f4f-0dce-49e2-af7e-9b3e0ca76aaf
  modified: 2026-10-17T21:40:12.992Z
---

The user asked on 2026-10-17 (Claude weekly allowance 86% used, Codex allowance full) to test an Opus 5.5 max session that drives Codex as its builder instead of Claude subagents. A matrix (Opus driver + Codex at high/xhigh/max) is to follow once the method is settled.

**Command** (the user's yolo flags; codex-cli 0.163.0, default model gpt-6.1-sol):
`codex exec --dangerously-bypass-approvals-and-sandbox -s workspace-write -C <worktree> -c model_reasoning_effort=<e> --json -o <out>/last.txt "Read <brief> and do exactly that." < /dev/null > <out>/events.jsonl 2> <out>/stderr.txt`

- Run it as a background Bash call; you are notified on exit.
- Always pass `< /dev/null`: without a TTY it reads stdin ("Reading additional input from stdin...").
- `-o` writes only the final message. Ask for a one-line JSON report and read that, never the events.

**Effort values** the API accepts: none, minimal, low, medium, high, xhigh, max. There is NO "ultra".

**Where things are recorded:**

- `--json` events do not record the effort. Codex's own session log does: `~/.codex/sessions/**/rollout-*.jsonl`, `"effort":"…"` and `"model":"…"`.
- Usage is in the `turn.completed` event: input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens.
- Order of work is in the `item.completed` events (command_execution / file_change). A baseline-before-fix check reads that order, because file mtimes came out identical.

**Smoke (throwaway repo, one planted bug, test-first brief):** high, xhigh and max all fixed it correctly and ran the baseline before the edit, at about 165-200k input (93% cached) and 2-3k output each, in about 1 min. At high it reported a broken brief command honestly instead of faking a pass. Files are in the session scratchpad, folder codex-smoke/.

**Limits:**

- No mid-run messaging: a fix round is a fresh exec with a fix brief.
- Codex reads AGENTS.md natively.
- It may spawn its own sub-agents ([[codex-multi-agent-not-off]]).
- Docker/gated tests need the bypass flag. That flag is already in the user's yolo set.
