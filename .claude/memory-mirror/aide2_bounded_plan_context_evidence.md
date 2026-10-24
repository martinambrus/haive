---
name: aide2-bounded-plan-context-evidence
description: AIDE² paper (arXiv 2609.26457) mapped onto Haive 2026-09-29 — measured whole-plan repetition in plan fan-outs and plan chat, plus non-memory steals (fork-on-stall, hidden checks, seat routing, eval harness); first wave approved 2026-10-02, see [[aide2-first-wave-series]]; the dev DB holds NO plan now (plan.json snapshots in repo git history are the measurement source)
metadata:
  node_type: memory
  type: project
  originSessionId: 539670c6-6b24-4e33-adea-49ad5b843573
  modified: 2026-10-02T20:04:41.934Z
---

Measured on the dev DB (3,509 stored cli_invocations, 2026-09-01..09-14; nothing newer on this install), source re-checked 2026-09-29:

- 00/03-plan-sequence: 888 agents, prompt ~161k chars, ~155k of it the whole plan (titles, depth 3, NO char bound, `03-plan-sequence.ts:456`); the agent's own part ("## Your node") ~2.5k. Every agent: cacheCreationTokens ~84k, cacheReadTokens flat ~24.1k (p10=p50=p90, the CLI's own preamble) — the plan block is re-written per agent, never read from cache.
- 5,305 of 5,322 parsed `depends_on` links from 887 sequence agents (99.7%) join ids listed in that agent's own "Your node" section; 17 reach elsewhere. Parsed against each agent's prompt, because the plans were rebuilt and plan_nodes no longer holds those ids.
- 02-plan-coverage: median prompt 95.5k chars, 84k of it "Whole-plan title index" — already bounded by `buildPlanExpansionContext` (96k cap, f7d65242, 2026-09-02), which 01-plan-build uses too.
- Plan chat: whole plan WITH bodies (`01-plan-chat.ts:193`), 696k-779k chars on big plans; ollama failed "Prompt is too long" on the 709k one. Transcript small (<=6k) but node-scoped across tasks (`:181`).
- 11f-plan-reconcile: one prompt 358k chars (titles depth 4, no char bound); 01f same call, unmeasured.
- 08b test output: tail 4000 chars, no dedupe (`08b-test-management.ts:557/566/575`); 4 stored 08b diagnoses averaged 18% repeated-line chars — too thin to act on alone.
- Repo AGENTS.md: 311 KB / 2,942 lines, imported via CLAUDE.md into every Claude Code session.

Haive's background blocks are all bounded; only the ledger and prior-fix blocks also dedupe by fingerprint, drop whole oldest entries and state omissions (honored constraints head-slice per source on purpose; learned guidance stops at its cap silently, D8). Do not re-propose the bounding.

Non-memory findings (same session, verified in code):

- Fork-on-stall gap (top pick): `detectFixLoopOscillation` (`_fix-loop.ts:300`) trips only when a DIFFERENT source alternates in, so one source re-raising the same defect runs to the cap (default 5, `06-run-config.ts:172`). The cap gate offers Continue/Accept/Abort on the same CLI (`_fix-loop.ts:59`). The only model swap is the step CLI switch, which is user-wide (`routes/tasks/steps.ts:1644`). Plan chat e63c6ce9: the user switched ollama -> codex -> claude-code by hand (two `step.cli_provider_preference_changed` events 8 s apart) — NOT automatic failover; there is none.
- 08b fix pass lets the same agent choose "TEST is wrong -> fix the test" (`08b-test-management.ts:949`) and is then graded by those tests. Stored pass records are CUMULATIVE (`accumulateChanges` folds pass 0 into every later record), so only a file absent from pass 0 proves a fix-pass edit: 1 of 7 rows (681f0f99 round 2); none went green. (An earlier draft claimed all 7 edited tests in fix passes; wrong, caught by Codex on PR #367.)
- Per-seat provider routing already exists (`roleKey` -> `resolvePreferredCli`, `step-runner.ts:1718`), so cheap-model-for-narrow-seats is config plus measurement, not code.
- No Haive version is stamped on runs (`cli_invocations` has no build/commit column; `tasks.commit_sha` is the task's own commit). Only deterministic-rule eval harnesses exist (`rag-eval.ts`, `kb-scrub-eval.ts`).
- review_findings on this DB: 3 workflow tasks — cannot answer the reviewer-overlap question.

**Why:** the dev DB gets pruned or reset; these numbers took zero-token SQL to get and would otherwise have to be re-derived.
**How to apply:** the plan is `docs/plans/aide2-harness-lessons.md` (PR #367, MERGED 2026-10-01 as 2676e391 after nine Codex rounds, 21 findings all valid; F1-F16, P0-P8, D1-D11; no phase approved yet). Found-not-fixed D7, D8, F14, F15, F16 were handed to the git-data-readonly-containers session. The plan was refined over those rounds, so read it rather than this note before acting. Two traps it records: sequence A/B arms must run on separate copies of the repository (`loadAskedParents` drops every parent already asked), and both arms must show the same fields (build-order number, no `blocked by` hints, F15). Related: [[found-not-fixed-running-list]].
