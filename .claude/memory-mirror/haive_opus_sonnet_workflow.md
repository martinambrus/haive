---
name: haive-opus-sonnet-workflow
description: 'From 2026-10-01 series work runs under /opus-sonnet — Opus scopes, judges, commits and runs the PR loop; Sonnet (5.5) agents write harnesses, code and fixes'
metadata:
  node_type: memory
  type: feedback
  originSessionId: f3f0c544-0081-42eb-b0d8-fc58d423baba
  modified: 2026-10-17T12:53:47.812Z
---

RETIRED 2026-10-17 on the user's word: `/opus-sonnet` now sits in
`~/.claude/skill-archive/opus-sonnet.2026-10-17.md`, and series work runs under `/sonnet-sonnet` from an
Opus max session ([[series-parked-for-skill-test]], [[skill-trial-duo-vs-trio]]). The new pair skills keep
this protocol, so the "How to apply" rules below still hold. The claude.ai upload
`opus-drives-sonnet-builds` is still synced until the user deletes it there.

The user asked on 2026-10-01 to run the series under the `/opus-sonnet` command
(`~/.claude/commands/opus-sonnet.md`, also offered as the `anthropic-skills:opus-drives-sonnet-builds`
skill). I scope, decide, brief, judge, commit and run the PR loop. Opus analysts read in parallel,
read-only. Fresh Sonnet agents write each task's check harness (the controls, with a failing
baseline), implement it and fix it, each from a short brief.

**Why:** the user's words: "so we save on tokens here as well if we use Sonnet as implementation and
validation (sub)agent". The Sonnet they mean is Sonnet 5.5; the old CLI did not offer it, so they
restarted the CLI mid-series to get it.

**How to apply:**

- The PR loop (push, Codex rounds, CI, merge) stays as [[haive-pr-workflow]] describes. The
  command's "never push unless asked" is overridden by the plan's standing authorisation.
- Keep the ledger in `<repo>/.claude/tmp/<slug>/` (git-ignored by `tmp/`). A session scratchpad
  does not survive a CLI restart.
- Check that `model: "sonnet"` resolves to 5.5 before relying on it.
- Make a change myself only when its brief would be longer than the change, and say so.
- A change carrying a migration gets a fresh Sonnet tester re-run before I accept it.
- In this repo every agent starts by loading the large AGENTS.md, so batch edits that share one
  check into one agent rather than spawning one per finding.
- A SendMessage to an agent that has already finished RESUMES it with its whole transcript, and
  the send gives no warning beyond "Resuming agent". On 2026-10-03 a relayed addition to a fixer
  that had finished minutes earlier restarted a 311k-token run. Before relaying a mid-run
  addition, check `ListAgents` shows it busy; if it has finished, brief a fresh fixer instead.

See [[found-not-fixed-sweep-3-series]] for where Track B stands.
