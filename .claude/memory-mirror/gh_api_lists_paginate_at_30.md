---
name: gh-api-lists-paginate-at-30
description: 'gh api REST lists (PR comments, reviews, reactions) return only the first 30 items without --paginate; long Codex loops hide new findings'
metadata:
  node_type: memory
  type: feedback
  originSessionId: 3813bbf6-9261-4b06-870d-404ed90866bb
  modified: 2026-10-11T14:44:06.483Z
---

`gh api repos/.../pulls/N/comments` (and issues comments, reactions, reviews) returns only page 1, 30 items. On a long Codex loop (PR #541, 2026-10-11) `[-1]` read an old comment and a new finding looked absent.

**Why:** a missed finding means merging with an open P1/P2 or waiting on a verdict that already landed.

**How to apply:** always `gh api --paginate ... --jq '.[]|...'` (jq runs per page, so select per item and `sort|tail` instead of `|last`), or ask GraphQL for unresolved review threads before merging. The waiter `scratchpad/codex_wait.sh` was fixed this way. Related: [[pr-watch-read-ci-field]].

2026-10-16: the same trap hit the round watcher `.claude/tmp/backlog/pr_watch.sh`: its Codex review
query lacked `--paginate`, so on PR #751 (30+ reviews) a finished review read as none and the watcher
sat "running" for an hour. Fixed there (reviews, issue comments and reactions all paginate; reviews
counted by id lines). If a watcher shows `codex=running` long after a round, check the PR by hand.
