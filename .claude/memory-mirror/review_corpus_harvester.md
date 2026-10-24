---
name: review-corpus-harvester
description: The Codex/Greptile review-corpus tool lives untracked at packages/worker/tmp/review-corpus.ts — nothing in the repo records it
metadata:
  node_type: memory
  type: project
  originSessionId: dc11f5ec-28cf-424a-91d6-7d4fd9d94812
  modified: 2026-09-21T14:21:18.689Z
---

Research tool for reverse-engineering what Codex and Greptile actually review, so Haive can
run the same rubric on any provider. Lives at `packages/worker/tmp/review-corpus.ts` with its
SQLite corpus beside it. **Deliberately never committed** — `.gitignore:57` (`tmp/`) already
covers it, so the repo needed no change. Only the FINDINGS and the prompt/review-process
changes they justify get committed, so Codex/Greptile review credits are never spent on the
tool that studies them. Consequence: the repo records nothing about it, which is why this
memory exists.

Run: `GH_TOKEN=$(gh auth token) pnpm --filter @haive/worker exec tsx tmp/review-corpus.ts --harvest`
(host-side, not in the container — the harvest is multi-hour and the worker's `tsx watch`
would kill it). `--repo X --pr N` for a single-PR spot check; `--report` for the analysis
tables. Typecheck via `tmp/tsconfig.check.json` — being untracked puts it outside every
tsconfig, so `pnpm typecheck` does NOT cover it.

Golden replay numbers, verified passing 2026-09-21 (pin the PR ceiling or they drift as new
PRs land): `martinambrus/haive` PR<=188 → 295 Codex findings, 76 P1 / 219 P2, 146 AGENTS.md
citations, 12 PRs with findings, 31 Greptile. `martinambrus/activity` PR<=149 → 71 findings,
67 P1 / 4 P0, 0 citations.

**Why the corpus exists rather than just reading our own PRs:** the 👍 reactions are an ERA,
not a quality label (100% thumbed on PRs 100-116, 0% on 181-188, one 👎 total), "no findings"
usually means an exhausted quota rather than a clean PR, and the AGENTS.md-drives-quality
hypothesis has no control group locally — 293 of 295 findings postdate the day the file was
created. See [[found-not-fixed-running-list]].

`--reparse` re-derives every parsed column from the stored `raw_body`/`summary_raw` with ZERO
API calls — the corpus keeps both verbatim precisely so a parser change never costs a refetch
(~24,000 calls at 10k PRs). Two parser bugs already needed it.

Run statuses are `completed | quota_blocked | declined | errored | unknown`, and ONLY
`completed` may be read as "reviewed and found nothing". `declined` is Greptile answering
`PR author is in the excluded authors list.` — zero findings, no review. A finding always
proves the run happened, so `finding_count > 0` outranks any wording match.

The invariants doc is probed at each PR's OWN base commit (`contents/<name>?ref=<base.sha>`)
and stored on `prs`, never from the repo's current default branch — MEASURED, haive's
AGENTS.md is 204,036 bytes today and 404 at PR #1's base, so the repo-level read back-dated
the study's central variable onto every older PR. Point-in-time facts like this are the ONLY
class that cannot be repaired by `--reparse`. `stars:` has the same defect and is unfixable
(GitHub search exposes no historical stars qualifier) — a stated limitation, not a task.

Plan: `~/.claude/plans/breezy-conjuring-emerson.md`.
