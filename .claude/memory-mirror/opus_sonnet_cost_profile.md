---
name: opus-sonnet-cost-profile
description: 'Measured token/cost split of the /opus-sonnet workflow (modularity session 2026-10-16) — where the tokens go, to judge skill changes such as a Haiku implementer tier'
metadata:
  node_type: memory
  type: project
  originSessionId: f5017f4f-0dce-49e2-af7e-9b3e0ca76aaf
  modified: 2026-10-16T05:57:03.213Z
---

Measured 2026-10-16 over the modularity session's 315 agent transcripts plus the driver transcript (script: session scratchpad `skill-analysis/analyze.py` + `report.py`). Units = input-equivalent tokens (cache read 0.1x, 5-min cache write 1.25x, output 5x); model price NOT applied, so Opus shares understate dollars.

- Driver (Opus main session): 32% of all units (8,048 turns, 4.2B cache-read tokens re-reading its own context).
- Agents: Sonnet Build 46%, Sonnet Fix 32%, Sonnet Harness 11%, Opus Analyse 10% of agent units.
- Inside Sonnet build/fix/harness turns: verification commands ~45%, code reading 22-28%, other bash 12-21%, edits only 6-9%.
- 107 fix agents vs 140 builds; a fix agent costs about what a build does (cold start + full re-verification). Most fix rounds came from review findings (Codex, driver judging), not mechanical test failures.
- Median Sonnet build/fix: 2 full-suite (flock) runs, 16 verify commands, 7 edits. Idle >5 min (cache expiry while waiting on suites) cost 8% of agent units.
- A subagent DOES have the Agent tool (Haiku probe, 2026-10-16), so a Sonnet planner can spawn and supervise a Haiku implementer.

**Why:** the user asked (2026-10-16) whether a three-tier Opus -> Sonnet -> Haiku split saves cost; edits are a small share, verification is the big one. Related: [[haive-opus-sonnet-workflow]].

**How to apply:** when changing the skill, move the verification loop (not just the edits) to the cheap tier, keep design-level fixes on Sonnet, cut driver turns, and compare per-task units against these numbers.
