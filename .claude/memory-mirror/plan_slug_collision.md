---
name: plan-slug-collision
description: 'Two unrelated Haive plans shared the slug toasty-percolating-kernighan.md — one in ~/.claude/plans, one in docs/plans — and a 34-PR series ran off the wrong one'
metadata:
  node_type: memory
  type: project
  originSessionId: e62dac9c-0a5b-41ca-8f3f-eaec5bb75d8c
  modified: 2026-09-18T09:36:48.608Z
---

Haive archives durable plan copies in the repo at `docs/plans/`; Claude Code writes session plans to
`~/.claude/plans/`. **The two slugs are generated independently, so one filename can name two
completely unrelated plans.** It happened: `toasty-percolating-kernighan.md` is BOTH "Per-call agent
isolation (PR 1)" (60 KB, in-repo, Not started) and "Repository symlink containment" (197 KB, local,
34 PRs shipped 2026-09-15..18).

**Why:** the worktree was named `agent-isolation-plan`, yet the entire containment series
ran off the local file, and the agent-isolation work — what the worktree existed for — was never
built. PR #103 had merged its plan as 16 `docs(plans):` commits and nothing else. The user spotted
the mismatch; nothing in the local plan or the session hinted at it, because a plan read by slug
cannot tell you which plan it is. Both files open with an H1 plus a status blockquote, and only the
H1 distinguishes them.

**How to apply:** before executing `~/.claude/plans/<slug>.md`, check whether
`docs/plans/<slug>.md` exists and read its H1. If the titles differ, say so before starting work.
`docs/plans/README.md` is the authoritative index (status, cross-plan dependencies) — but verify its
rows against the tree rather than trusting them: its table is dated 2026-08-21 and was found wrong
in two rows (`parsed-churning-yeti` listed Not started though the plan canvas shipped;
`replicated-zooming-beacon` listed Not started on three files that all exist). Roughly 20 of the 48
plan files have no status row at all, so the index is not a complete backlog.

See [[plan-docs-no-amendments]] for how revisions go into these files, and
[[cli-agent-listing-levers]] for the measured listing cost the agent-isolation plan exists to
remove — that memory is the measurement half of the plan this collision hid.
