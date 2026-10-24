---
name: rag-retrieval-plan
description: 'RAG research lives in docs/plans/rag-retrieval-improvements.md (sources S1-S7, findings F1-F15, phases P0-P4, decisions D1-D5) — update THAT file in place, not memory; this note keeps only the private measurement specifics'
metadata:
  node_type: memory
  type: project
  originSessionId: 8e7e8e7e-0712-43e9-bcc3-d118e3e4ca13
  modified: 2026-10-01T04:48:02.564Z
---

The durable record of the RAG-improvement research is `docs/plans/rag-retrieval-improvements.md`
(created 2026-09-30, with its row in `docs/plans/README.md`). Shipped on branch
`rag-retrieval-plan` as PR #366 (commits 7bb09413 plan, 6b6e31b2 the owed A5.6 marks, 8466f4be
Codex round-1 P2 fix to the F6 recipe). CI green; Codex silent on 8466f4be (4-min rule), Greptile
quota spent for September. MERGED 2026-09-30 09:41Z as 3d7473db (merge commit); the plan now
lives on main, so later sources and re-measurements go in through a new branch and PR. Each new source the user brings is read in full, measured against Haive, and
FOLDED into that plan: Sources reviewed (S#), Findings (F#, numbers replaced, never appended),
Phases (P#), Open decisions (D#) moving to Decided. Nothing in it is approved yet.
2026-10-01: the ten found-not-fixed CODE findings (F1+F2, F3, F4, F5, F6, F8, F13, F14, F15 and the
literal NUL bytes) were handed to the local session `git-data-readonly-containers` at the user's
request; ask what it has done with them before starting one of them anywhere else. Status
2026-10-15 (checked in that same session): P0 #589/#590, D1/F3 #591/#597/#598 and F14 #596 MERGED
2026-10-12; literal NULs (#139) done; OPEN in that session's task list: F1+F2+F4 (P1, one reindex,
F2's JS half waits on D2), F5/F6/F13 (P2), F15.

Private specifics kept out of the public plan:

- Measured repo: `elmont_rs_185_test_codex_sol_max` (id `0e72847d-0dd8-4486-824d-c046a5d2f420`),
  tree at `/var/lib/haive/repos/6abb06a6-21f4-4891-a787-2244c3c4cf9e/0e72847d-…` inside
  `haive-worker` (a copy of `/host-fs/elmont-t185-a`). Its onboarding task `603cf7f6` is parked at
  `09-qa`: no `09_7`, no `10-rag-populate`, `scope_exclude_globs` empty. Collector exclude used:
  `["includes/","misc/","modules/","profiles/","scripts/","themes/","sites/all/libraries/","sites/default/files/"]`.
- Stores: `haive_rag_elmont_rs` has 0 rows (320 MB on disk); `haive_rag_rs_final` holds 1,820
  legacy header-less rows with NULL `repository_id` — KEEP it (user, 2026-10-12): it is the RAG eval
  corpus for ident-eval / rag-eval, never drop it; `ddev-elmont-rs-db`/`db` holds 1,330 kb rows;
  `haive_kb_global` has 11 entries.
- P0 (2026-10-12, session a7cfa69f): scratch store `haive_rag_p0_eval` (20,839 rows, synthetic
  repository_id `6dd72ddd-8ff1-4158-9e37-f8f7f75efef6`; KEEP for P1 before/after). Golden set
  `.claude/tmp/rag-plan/golden/set.json` (untracked, 296 queries); results
  `.claude/tmp/rag-plan/t6/{hybrid,lexical}.json`; ledger `.claude/tmp/rag-plan/ledger.md`.
  Branches: `rag-p0-eval` (PR A: build-store + eval + docs), `rag-p0-ranks` (PR B: hit ranks).
  Re-run: `docker exec -w /app/.claude/worktrees/<wt>/packages/worker -e RAG_PROJECT=p0_eval
-e RAG_QUERY_SET=... -e RAG_REPOSITORY_ID=... -e RAG_DENSE_CHECK=1 -e RAG_OUT=... haive-worker
../../node_modules/.bin/tsx scripts/rag-eval.ts` (~11 min per run).
- PRs opened 2026-10-12 (not merged, awaiting user): #589 P0 eval tooling (rag-p0-eval), #590 hit
  ranks (rag-p0-ranks), #591 D1 own-code budget exemption (rag-d1-budget), #592 onboarding secret
  mask (rag-onboarding-mask). After merges: task #12 (build-store uses fileBudget), #14 (collector:
  own paths under a broader env-detect exclude, WP plugins), #13 DESIGN dense ef_search 200 + forced
  HNSW (needs user go). D1 DECIDED (exempt own code + KB, 2 MB backstop).
- MERGED 2026-10-12: #589 P0 tooling, #590 hit ranks, #591 D1 own-code budget, #592 onboarding secret
  mask, #595 build-store fileBudget + D1 cost corrected (+2,304; datatables.js sits inside the custom
  module), #596 per-repo dense read (ef 200 + cpu_operator_cost 0.1 + iterative scan, settings restored
  after; r@8 0.681→0.719), #597 collector own paths override the env-detect heuristic + onboarding
  follows the sync's scope precedence, #598 build-store RAG_HEURISTIC_EXCLUDE. Nothing open from this
  run. NEXT per plan: P1 (chunker corrections, one reindex) measured before/after with rag-eval on a
  fresh scratch store (haive_rag_p0_eval has no meta row, so the builder refuses to resume it).
- Harness gotchas: a `.ts` script in the worker's `/tmp` fails with ERR_PACKAGE_PATH_NOT_EXPORTED,
  use `.mts` and run `pnpm --filter @haive/worker exec tsx /tmp/x.mts` from `/app`. Replays: `docker
cp` the CSV to `haive-postgres:/tmp`, `\copy` into a TEMP table in database `postgres`. Remove the
  `/tmp` files from both containers afterwards.

**Why:** the user asked for findings to survive compaction in one updatable plan, not scattered
memory notes; two notes duplicating the plan would drift from it.
**How to apply:** read the plan before adding to it; after a change, re-derive every number the
change touches. Related: [[found-not-fixed-running-list]], [[plan-docs-no-amendments]].
