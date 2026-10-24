---
name: agents-md-split-review-check
description: 'AGENTS.md was split into a core plus docs/architecture/ topic files (branch agents-md-split, 2026-10-02); whether the Codex PR reviewer follows the index is unmeasured — baseline numbers and the check to run after merge'
metadata:
  node_type: memory
  type: project
  originSessionId: 52061937-bdb1-423c-a6c1-5069550f748b
  modified: 2026-10-02T21:41:12.571Z
---

On 2026-10-02 AGENTS.md (321,348 B) was split: the core plus a topic index (28,693 B, under Codex
CLI's 32 KiB) stays in AGENTS.md, 36 topic files moved verbatim to `docs/architecture/`. The user
chose the PLAIN split over a generated full AGENTS.md. Status when written: branch
`agents-md-split` in `.claude/worktrees/agents-md-split`, not yet shipped.

**Why:** the Codex PR reviewer is half the merge gate and leaned on the old file. MEASURED
2026-10-02: 496 of 760 Codex review comments cited AGENTS.md (487 line citations, 77% past byte
32,768, so it read the whole file), and it had never cited any other .md file. Its most-cited
sections all moved out: Onboarding completion 99, Sandbox 65, Plan canvas 56, Worker restarts 53,
template versioning 49, Merge conflicts 35. The core kept Conventions 35 and Architecture summary 21. AGENTS.md now carries a `## Review guidelines` section telling it to open the topic files.

**How to apply:** after the split merges, check the next CODE PRs (not the split PR, whose diff IS
the topic files): list Codex review comment bodies with
`gh api --paginate "repos/martinambrus/haive/pulls/comments?per_page=100" --jq '.[]|select(.user.login|test("codex";"i"))|.body'`
and grep `blob/<sha>/(AGENTS\.md|docs/architecture/[^#]+)#L`. Healthy: docs/architecture
citations appear and roughly 65% of comments still cite a doc. If they collapse, the fallback is
the generated shape: docs/architecture as the source, CLAUDE.md importing only the core, AGENTS.md
regenerated in full by a script with a CI freshness check.

Claude side already verified: a zero-token capture showed 292,659 B less prompt text per session
start, and two Sonnet 5.5 probes opened the right topic file on their first tool call.

Related: [[invariants-doc-lever]], [[haive-pr-workflow]], [[cli-context-capture-harness]].
