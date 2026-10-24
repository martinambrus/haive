---
name: agent-read-cost-measurement
description: 'How to measure what share of agent prompt tokens is file content read, from Haive stream_log or Claude Code session transcripts; traps and 2026-10-17 numbers'
metadata:
  node_type: memory
  type: reference
  originSessionId: 44d3f85b-1b13-4d5e-87fe-b51b93c8e1ab
  modified: 2026-10-17T14:05:55.098Z
---

Scripts and outputs: `.claude/tmp/read-cost/` (gitignored). Done 2026-10-17 for the Fowler
"economic benefit of refactoring" article; the plan is `docs/plans/refactoring-economics-lessons.md`
(pushed `0fdbf9c9a`), whose P0 must reproduce these numbers.

Method: per tool_result, chars/4 x number of later model turns in the same context (each later API
call re-sends it); attribute to a file via Read `file_path` or a parsed `cat|sed -n|head|tail` Bash
command. Haive rows: `cli_invocations.stream_log` + `token_usage`; sessions:
`~/.claude/projects/-home-activit-haive/**/*.jsonl` with exact per-message `usage`.

Traps:

- A result's life ENDS at a `compact_boundary` system event. Ignoring it gave 231% of prompt tokens
  on sessions (one session had 82 compactions); honouring it gave 16.9%.
- Parse each transcript line from its first `{`, never from `{"type":`: Haive's stored `result`
  event has `type` AFTER other keys (`"ttft_ms":…,"type":"result"`), and content blocks nest
  `{"type":`. Keying on `{"type":` made 2,767 of 2,781 runs look result-less.
- Assistant events repeat one message's usage once per content block: dedupe by `message.id`.
- 16 runs show results > 100% of prompt tokens. The 7 claude-code ones are killed runs (exit 137, no
  `result`) whose usage came from the live fallback in `queues/cli-exec/stream.ts`
  (`assistantCacheReadMax` = max, not sum; other buckets summed per event). The 9 grok ones
  finished normally, cause unknown. Exclude all 16.

2026-10-17 numbers: Haive install, file reads 13.8% of prompt tokens (all tool results 19.4%),
top 20 files 44% of file-read tokens, one 12,797-line Drupal file ~19% (26 tasks, copies of one
project, benchmark-heavy). Haive dev sessions: file reads 10.4% of 53.6B prompt tokens, flat
(largest, step-runner.ts, 1.8% of file-read tokens).
