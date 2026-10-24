---
name: house-rules-series
description: 'Enforced global-KB house rules + 3 folded FNF fixes, approved 2026-10-03 (plan abstract-splashing-owl.md, 8 PRs, migration 0173); user decisions and design findings not to re-litigate'
metadata:
  node_type: memory
  type: project
  originSessionId: f3f0c544-0081-42eb-b0d8-fc58d423baba
  modified: 2026-10-02T23:12:17.545Z
---

Plan: `/home/activit/.claude/plans/abstract-splashing-owl.md` (approved 2026-10-03; PR1 copies it to
`docs/plans/` with a README row). Session f3f0c544 tasks #1-#8 mirror PR1-PR8; #9-#11 are FNFs it
found and left out. Runs under [[haive-opus-sonnet-workflow]]; ledger `.claude/tmp/house-rules/`.

**Why it exists:** the user asked whether coding standards in the global KB can be ENFORCED for all
Drupal projects. MEASURED 2026-10-02: agents see only titles and must call `rag_search` to read a body;
since the digest shipped claude-code did so in 24.5% of rag-wired runs, ollama 0 of 125, codex ~36%. And
D7 sites (detected as `drupal7`) matched no `framework: drupal` entry at all.

**User decisions (2026-10-03), do not re-ask:**

- Haive decides what loads, never the model (the user first proposed skills-style lazy loading; agreed on
  the skills SHAPE — title + description listing — but measured volitional loading is too weak).
- Triggers BOTH: file globs decide what 07b enforces; similarity adds likely rules to writers, staged
  record-only until a floor is measured (PR7 record, PR8 on).
- Rules go to writers + the 07b validator only; mining not opted in.
- A violation on a changed line BLOCKS (high-severity 07b issue).
- `always` rules: refused at enforce time past a byte cap (UTF-8 bytes).
- Enforce/un-enforce is ADMIN-ONLY. The user first chose "any signed-in user" on my framing that
  activation already reaches every agent; I corrected it (enforcing = unfenced instruction in every
  writer prompt, activation = searchable data) and they switched.

**Design findings from two Plan-agent reviews, adopted:**

- Approval hash over a canonical form (never `JSON.stringify(row.facets)`: jsonb reorders keys, the
  boot backfill reorders arrays); `expectedHash` on PATCH so the admin enforces the raw bytes they saw;
  refuse control/zero-width/bidi chars and Haive markers; leaving `active` CLEARS enforcement (else
  archive→reactivate restores it); advisory namespace lock BEFORE the row lock in every PATCH.
- Opt-in via a `HOUSE_RULE_ROLES` table beside `STEP_CLI_ROLES` + ratchet over `file_write` steps;
  retry_ai gets its own role (mining and retry_ai both resolve `default`).
- Enforced titles stay in the title digest (excluding them changes prompts of non-opted dispatches).
- Never a prompt-wide `includes(marker)` guard; replace a stored block at position 0 only;
  `stripHaivePreamble()` for the isolation scan and the persona bookkeeping reads.
- Spec vs rule conflict: the approved spec wins and the conflict is reported at gate 2 (else 07b
  churns); spec writers never restate rules as requirements (06b criteria -> DAG reviewer by proxy).
- The DAG per-issue reviewer is NOT an enforcer: it approves when acceptance criteria pass and sees
  whole files with no line notes (FNF task #11).
- FNF facet fix goes in `facets.ts` (project/match side), NOT `FACET_VALUE_ALIASES` (write side +
  boot backfill would rewrite stored `drupal7`).
- Lint scoping: phpcs needs `--report=full` BEFORE `--report-json`; report dir must be writable by DDEV
  uid 1000 (`_screenshots.ts` pattern); never branch on exit codes beyond 0 (3.x vs 4.x differ); count
  ERROR and WARNING; uncapped line map (prompt collector caps 20 ranges/file, 100 files); exit 127 = not
  run.

**Migration 0176** (`cli_invocations.house_rules`; 0173 was taken on main by `cli_invocation_assigned_agents`); the Drizzle column is declared LAST.
PR5 and PR6 merge in one session (no release tag between). **Push/merge AUTHORIZED for the whole
series (user, 2026-10-03):** for every PR of this series once it passes my local checks — push, open
the PR, loop Codex until a round brings no valid finding, wait for CI, merge with a merge commit, then
sync the dev stack (`pnpm docker libs`; `pnpm docker migrate` FIRST for PR6). Covers this series only.

Related: [[found-not-fixed-running-list]], [[agent-rules-series]], [[aide2-first-wave-series]].

- 2026-10-03 PR5 decisions by the user: the global KB Enabled switch, namespace, provider/mode and connection string
  become ADMIN-ONLY (each could switch every enforced rule off); approvals are trusted from whatever store an admin
  points the KB at (no per-install signing; documented). Design consolidated in the ledger (`.claude/tmp/house-rules/ledger.md`).
- 2026-10-03 progress: PR1 #398, PR2 #399, PR3 #402 (acc09ef8), PR4 #400 (4995ad81, backend + web in one PR after a Codex P1) merged. The dev stack is HELD at acc09ef8 while the user tests: after they release it, pull main + `pnpm docker libs`. PR5 builds in .claude/worktrees/house-rules-pr5 (T5a 70a57e35 committed; T5b api in progress; T5c web next).
- RESUMED 2026-10-08; PR5 MERGED as #432 (2026-10-08), PR6 MERGED as #454 (2026-10-09, main fc680715) after 8 Codex rounds. No release tag between them (latest v0.2.0). Next: PR7 (similarity, record-only), PR8 (switch on with a measured floor).
- 2026-10-09 USER DECISIONS on late writers (do not re-ask): 08b and the 08a fixer write after 07b → 08c's peer-reviewer seat gets the review framing (findings wording) and re-checks them; a finding naming a stamped rule is raised to high and SKIPS the refuter; gate 2 merges both checks (state from 08c). 08e runs after 08c and quick_bugfix runs no 08c → every check records a change fingerprint; a gate that sees the change moved since the last check, with rules in play, shows PARTIAL and holds Approve ("honest gate").
- DONE 2026-10-09 (user: "do sync main and do any live checks needed"): dev stack synced to fc680715 (0176 applied, libs rebuilt) and the PR6 live check PASSED on a throwaway repo with a FIXTURE rule (the user's "no inline svgs" entry was not touched; plan of record: .claude/tmp/house-rules/ledger.md "Live check"). Original OWED text, kept for its details: (1) dev-stack sync of ~/haive (they held it for their own testing): pull main, `pnpm docker migrate` (0176), `pnpm docker libs` (new `@haive/shared/house-rule-render` subpath); (2) PR6 live check: description on "no inline svgs", enforce `files` on `**/*.tpl.php` (+css), declare the D7 theme (elmont_rs: sites/all/themes/activit) in `.haive-data/dependency-ownership.json` on the base branch (a D7 theme outside custom/ is third-party), then ONE token-spending quick_bugfix → check 07/07b stamps, 07b's issue, the House rules row at gate 3.
- Harnesses (zero tokens): `.claude/tmp/house-rules/t5/harness` (PR5, 17 checks) and `t6/harness` (PR6, H1-H18, goldens `baseline-main2`, `t6c-baseline`, `t6ef-baseline`); `node selftest.mjs --matrix` must say CALIBRATION OK after any harness edit.
- 2026-10-09 USER DECISIONS after the PR7 analysis (do not re-ask): (1) the global KB embedder settings (ollamaUrl, embedModel, embedDimensions, test-ollama) stay OPEN to every signed-in user (invite-only instance) → FNF #19 closed as decided; (2) writer trigger "Both": PR7a = deterministic NAMED PATHS (paths named in the task or the spec count as known files when selecting files rules, estimate-only priority) FIRST, then PR7b = record-only similarity (Seam A: scored after the CLI starts, amended into the stamp). PR8 parked: similarity separates only topic-naming tasks (live task 0.469 vs its rule, 0.404 vs an unrelated one; an invites-only spinner task 0.284 < 0.314 unrelated) → PR8 needs PER-RULE floors from graded data.
- PAUSED 2026-10-09 ~20:45 at the user's request (allowance), nothing running. PICKUP, in order:
  (1) PR7a #464 — MERGED 2026-10-10T08:21Z (checked 2026-10-15; whether the PR7a live check and worktree cleanup below were done is UNVERIFIED). Original note: Codex r5 👍 on 92dd1c95, CI green, harness H1-H25 25/25 with golden
  `t7a-baseline3` (USE IT from now on). Merge with `--match-head-commit 92dd1c95…`, watch main CI, remove
  `.claude/worktrees/house-rules-pr7a`, close task #31. Then sync the dev stack (no live tasks first;
  `pnpm docker rebuild`, since #461 changed the lockfile) and do the ZERO-token PR7a live check: the real
  `selectForDispatch` against the live DB for a task whose text names its files. Then delete the throwaway
  repo hr6-live-d7 (3e2c0533, DELETE /repos/:id) and `/home/activit/hr6-live-d7` (both kept until the PR7b
  live check if that comes soon).
  (2) PR7b — MERGED as #486 (2026-10-10T16:36Z; verified 2026-10-15 via gh; the house-rules ledger stops before it, the t7b folder holds its build, fixes and watches). Original note: harness brief drafted at `.claude/tmp/house-rules/t7b/harness-brief.md` (contract
  clauses 1-7, rows H26-H31, golden = export of main at the PR7a merge → `trees/pr7b-base`); launch it after
  the merge, then the builder. Design (Seam A) is in the house-rules ledger. Open premise risks: cold embed
  4.6-42.8 s → off the dispatch path; bind ids as '{…}' literals under fetch_types:false.
  (3) Harness FNF (mine): run.mjs fails on a RELATIVE tree path, so pass absolute paths; 4096/8192 bounds
  have no harness probe (unit tests cover them).
- 2026-10-11: PR8 is no longer tracked as an open task; its resume condition, query and prerequisite (an ENFORCED `files` rule, 0 on the dev install) live in [[house-rules-pr8-resume]], checked when a workflow `07` lands.
