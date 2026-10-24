---
name: agent-rules-series
description: "DONE 2026-09-24: agent-rules series (global CLAUDE.md rewrite; PRs B #229, C #231 + #242, D #232, local repo commits, A #235 per-dispatch injection; migrations 0165/0166 applied). Owed: first real invocation's agent_rules stamp, B's end-to-end upgrade check"
metadata:
  node_type: memory
  type: project
  originSessionId: 3813bbf6-9261-4b06-870d-404ed90866bb
  modified: 2026-10-09T10:16:14.995Z
---

Plan: `/home/activit/.claude/plans/compiled-noodling-squid.md` (approved 2026-09-23; copy goes to
`docs/plans/` with PR B). Tasks #6-#12 in that session mirror it.

**Migrations reserved: 0165 = PR C (`task_dag_issues.similar_sites`), 0166 = PR A
(`cli_invocations.agent_rules`).** Both sit above 0164, which [[attachments-followups-series]] holds.
Never renumber: a dev DB that applied a renumbered file makes the runner refuse to run. After each
merge touching shared/database: `pnpm docker migrate` BEFORE `pnpm docker libs`. The other order makes
`findFirst` select the new column before it exists, and every cli-exec job fails.

Order: Part 1 global files (DONE 2026-09-23, backups `~/.claude/backups/*.bak-20260923`) -> PR B ->
PR C -> PR D -> Part 5 repo commits (right after D) -> PR A -> docs/memory.

Progress (2026-09-23):

- **PR B = #229, MERGED 2026-09-23 as cdf0d652**, main CI green. Four rounds: rounds 1-2 each
  brought valid Codex findings; rounds 3-4 were clean (round 4 covered my own gitignore fix).
  - Live on the dev stack after the sync: `enabledImportRulesFiles` returned `["CLAUDE.md"]` for the
    dev user's 15 enabled providers.
  - **OWED:** the end-to-end upgrade check (CLAUDE.md deleted, commit ticked; stub restored and staged).
    It could not run, because NO repository on the install had completed onboarding (0 of 9).
    Run it on the first one that does.
  - The review widened 03's staging rule: a stub whose HEAD copy lacks the import
    (`headLacksImport`, a `git grep` on the blob), a `CLAUDE.md -> AGENTS.md` link, and never a
    gitignored rules file (`isGitIgnored`, checked after any init).
- **PR C = #231** (worktree `.claude/worktrees/agent-rules-similar-sites`). Rounds 1-7 each brought
  one Codex P2 (round 7's, reports lost on a manual 07 retry, judged intended and documented in
  245ee8a4). Round 8 never started on 245ee8a4 (13 h silent, summary row still `e094e98`), and I
  WRONGLY read that as a spent allowance: Codex reviewed the very next push (fc7fc4f9) within 7 min.
  Updated with main on 2026-09-24 as fc7fc4f9 (34 commits; no conflicts, typecheck + 165 targeted
  tests green) before merging.
  - `smoke:dag-review` now asserts the merge.
  - The browser check ran on throwaway fixture tasks, since deleted.
  - **MERGED 2026-09-24 07:35:59 as 4dc42180**, main CI green; 0165 applied (`pnpm docker migrate`),
    libs rebuilt, loader verified against the live schema.
  - Codex HAD reviewed fc7fc4f9 (07:32:49, P2: similar-site reason rendered as raw markdown, an image
    in it fetched on gate render even collapsed) and I merged past it. Fixed in **#242, MERGED
    08:04:22 as 16f8aa7e**: reason backslash-escaped. Verified live in Chrome with a control fixture
    (raw reason fired `GET https://attacker.example/pixel.png` collapsed; escaped: no request, no img).
    A bare URL still autolinks (GFM runs its autolink transform on unescaped text); Codex claimed the
    opposite on #242 and the live DOM refuted it.
- **PR D = #232** MERGED 2026-09-24 08:00:05 as 1a7c16ff after round 3 (Codex P2: `dedupLines` deduped
  lines INSIDE a later fence; now a fence is one unit, dropped only when an identical fence was already
  emitted). Main CI green (its push event arrived 5.5 min late and cancelled 16f8aa7e's run, which was
  then re-run). Live: default 9,198 chars, hash 7a41e8a7d0ad, all 15 providers `rulesInherited`, form
  shows the live default + inherit note. Upgrade-status check still impossible (no onboarded repo).
- **Part 5 DONE 2026-09-24:** 12 local commits `chore: Haive agent rules for this repository` (no push),
  dogacars re-rendered only (no git). Verified from HEAD: both markers, no legacy guide, balanced
  fence, only AGENTS.md/CLAUDE.md in each commit, clean trees; the 7 repos parked at 09_2 hash-match
  what step 12 will record. ROLLBACK: `git revert HEAD` per repo, then restore the pre-apply working
  tree files from `~/.claude/backups/part5-repo-rules-backup-20260924.tgz`
  (26 files, absolute paths under the haive_repos volume, taken with the worker container's view).
- **PR A = #235 MERGED 2026-09-24 08:45:02 as e0618382**, main CI green; 0166 applied, libs rebuilt,
  switch key seeded `true`. Five rounds: Codex P2s fixed were the rules-closing-tag deletion (now
  escaped `<\/haive_agent_rules>`) and the re-feed bug (every adapter PREPENDS, so a newly applying one
  buried the stored block: now stripped before the adapters and before the isolation scan); one round
  needed an explicit `@codex review` (the push got no auto-review in 8.5 min). Verified live: real
  `resolveDispatch` on the live claude-code row gives 1 block at the top with the new default and stamp
  `{hash 7a41e8a7…, injected:true}`, 1 block on a re-feed where the worktree boundary newly applies,
  0 blocks + `opt-out` for `skipAgentRules`; admin card + `GET /admin/config/agent-rules-injection`
  OK. Zero-token capture (claude 2.1.280 in its sandbox image, cwd elmont_rs_test, prompt from the
  live dispatcher, recorder answering 400): the model request carried exactly 1 injected block AND a
  probe line of the repo's committed (old-default) cli-rules via CLAUDE.md -> AGENTS.md.
  - **VERIFIED 2026-10-09 (session f3f0c544, live quick_bugfix ea88adcf):** the `agent_rules` stamp
    on real invocations. Canary, env-detect and every step recap `{injected:false, reason:'opt-out'}`;
    triage, estimate, 07, all three 07b passes and gate 3 `{hash 9befba7c…, injected:true}` with
    exactly ONE `<haive_agent_rules>` at position 1. The default changed since, so the hash is no
    longer `7a41e8a7…`: compare against the provider's current resolved rules, not a remembered hash.
  - **STILL OWED, queued in [[onboarding-run-checkpoints]]:** B's end-to-end upgrade check and D's
    upgrade-status / Part 5 hash-match check (both under "the run COMPLETED" of an ONBOARDING).
  - Plan marked shipped in `docs/plans/` (README row + H1 blockquote + As-built notes) inside #235.
- **Part 5 refinement (decided 2026-09-23):** do not commit the seven 09_2 elmont repos "as they are".
  - D changes `dedupLines`, and step 12 hashes 07's stored rules with the NEW dedup. A block written
    with the old one would therefore read as a conflict at the first upgrade.
  - Instead, re-render each one's cli-rules region from its OWN 07 detect rules with the fixed
    dedup, then commit.
  - `adminanything` is not in the table: check whether it has an AGENTS.md at all.

Decisions NOT to re-litigate (each came from the analysis or a Plan-agent review):

- **Rules delivery:** PR A ALWAYS injects at `buildCliSidePlan`. It never skips because "the repo
  already delivers it", which was unsafe four ways:
  - the damaged `dedupLines` block;
  - codex's 32 KiB AGENTS.md cap;
  - agy's native loading is unmeasured;
  - a merged multi-provider block never equals one provider's block.
- **Injection mechanics:**
  - Rules are applied LAST in `adaptPrompt`.
  - A block at position 0 is replaced, which covers stored-prompt re-feeds; a marker elsewhere is
    ignored.
  - `skipAgentRules` opt-out: step-summary, 01-env-detect, `_model-health`.
  - The switch is ABSENT in the pure resolver = off.
  - `PromptTooLargeError` rebuilds without the block (gemini is argv-only).
  - The stamp rides `spec.agentRules` and is written at exec start.
- **Isolation:** the async pre-check keeps NO rules text, because it must be at least as permissive as
  the final pass or persona bodies go unread.
- **PR A lands AFTER PR D**, so the old default ("plan mode/tasks", "fix it everywhere") never reaches
  every dispatch.
- **Similar sites** are display-only:
  - gate 2 reads all 07 rounds; gate 3 shows the row when the run has no gate 2 (quick_bugfix is SPINE
    only);
  - the DAG schema is `z.array(z.unknown()).catch([])`, so a bad entry never fails a coder;
  - they never enter the ledger.
- **Part 5 per-repo table** — step 12 hashes 07's STORED detect, not the disk:
  - the 7 elmont repos parked at 09_2 are re-rendered from their OWN 07 detect rules (old default
    text) with the fixed dedup, because step 12 will hash exactly that (see the refinement above);
  - muse, koznaklinika, dogacars, sailorix, vareska-claude, elmont_skladacka are re-rendered with the
    new default (today's providers, `buildCliRulesBlockFromProviders`).
  - The script is `scratchpad/_tmp-part5.ts` of session 3813bbf6: commit is pathspec-scoped to
    AGENTS.md/CLAUDE.md (never sweeps other staged paths) and skips a gitignored CLAUDE.md.
- **User calls:**
  - keep the adversarial retrace rule;
  - restore Karpathy §1;
  - sync the default with the global rewrite;
  - commit the repos' rules files after the rules PR.

Related: [[found-not-fixed-running-list]], [[invariants-doc-lever]].
