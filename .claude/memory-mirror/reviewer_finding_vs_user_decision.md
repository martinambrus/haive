---
name: reviewer-finding-vs-user-decision
description: "Before accepting a Codex/reviewer finding, check it against the user's recorded decisions; a plausible fix can silently reverse one"
metadata:
  node_type: memory
  type: feedback
  originSessionId: f5017f4f-0dce-49e2-af7e-9b3e0ca76aaf
  modified: 2026-10-15T14:06:49.602Z
---

Before judging a reviewer finding VALID, check whether its remedy changes behaviour the user explicitly decided (the ledger's USER DECISIONS lines, the plan's locked decisions). If it does, the finding is not a defect to fix: reply citing the decision, or ask the user.

**Why:** on #752 (2026-10-15) I accepted a Codex P2 "a type-draft conversation shows up in the task lists" and shipped 8189d156c hiding type_draft from GET /tasks and the sidebar — reversing the user's 2026-10-14 decision "creator tasks visible in the task list". It surfaced only when a doc analyst cross-read the ledger; P15D's stats item had already been built on the wrong premise. Reverted in #764.

**How to apply:** in the Judge step for any finding that changes what a user sees or can do (visibility, defaults, refusals), grep the ledger's decision lines for the feature first. Related: [[haive-pr-workflow]], [[modularity-series]].
