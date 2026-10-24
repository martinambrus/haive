---
name: found-not-fixed-sweep-series
description: 'SHIPPED 2026-09-25 (#267-#300): 25 PRs plus 5c/21b/24b clearing the found-not-fixed list (CI/e2e signal, upgrade/reset data safety, RTK-off, cli-exec completion, DAG ledger, coverage ids, staging sweep, build coalescing, git locks, isolation @ imports, runtime-booting GETs, fences, plan editor images, phone task page, deps); order, decisions, handover'
metadata:
  node_type: memory
  type: project
  originSessionId: 3813bbf6-9261-4b06-870d-404ed90866bb
  modified: 2026-09-25T12:06:57.978Z
---

Plan: `/home/activit/.claude/plans/compiled-noodling-squid.md` (approved 2026-09-24; it overwrote the
shipped follow-ups plan). Repo copy goes to `docs/plans/found-not-fixed-sweep.md` — NOT the plan
slug, which is the shipped agent-rules plan in docs/plans. One task per PR in session 3813bbf6.

**User decisions (2026-09-24):**

- The seven recovery items that build on #257/#263 belong to the parallel session
  (`recovery-dag-archive-ci-fixes`). Handed over by message and written into
  [[recovery-context-followups-series]].
- The isolation scan resolves an `@` import in container space: follow it when it lands inside
  `/haive/workdir`, skip it otherwise, and scan the resolved target path itself.
- The two untested release-action bumps wait for the next real release's rc. Nothing is published
  now.

**Order:** 1-3 first (CI concurrency, e2e waits, sandbox warm-up), because they make CI trustworthy
for everything after. Dependencies:

- 7 (RTK off) needs 4 (backfill claims), 5 (the obsolete-delete guard) and 6 (legacy RTK.md reset).
- 19 needs 18 (the shared fence scanner).
- 24 (Dependabot groups) waits for 2026-09-25 16:19Z.
- 25 (narrowing the wave consume) waits for #263.

**SHIPPED 2026-09-25 13:05Z.** S24 merged as #299 (`f7fba280`) before 16:19Z by the user's call,
and 24b as #300 (`f500934d`), which also moved the README row and plan banner to shipped. Main
CI green on both merge shas; main checkout synced to `f500934d`; worktree `dependabot-groups` and
branches `dependabot-groups`/`dependabot-group-specificity` removed (remote ones auto-deleted);
task list cleared. 24b fixed MY #299 config: Dependabot gives a dependency to the MOST SPECIFIC
matching group (dependabot-core `PatternSpecificityCalculator`: no patterns 500, `@tiptap/*` 94,
`*` 1), so pattern-less catch-alls emptied `tiptap` and double-grouped react. Proven twice: the
real grouping code in a ruby container (scratchpad `dbgroups/run.rb`), and LIVE — npm run
36135391186 (#299) logged "Skipping @tiptap/core for group 'tiptap' - belongs to more specific
group 'production'" plus the empty-group warning, run 36137815739 (#300) logged every @tiptap
package into 'tiptap' and the react four into 'react'. Both npm runs still end in the expected
`ERR_PNPM_NO_MATURE_MATCHING_VERSION` (next 16.3.6 until 16:19Z); open checkpoint: the first npm
run after that opens group PRs. After it: `@dependabot ignore this major version` on TS 7 and
mermaid 12 PRs, land group PRs one at a time, then ONE `pnpm docker rebuild` (cold build cache).

**Progress (2026-09-25 11:00Z):** S1-S22 and S5c merged (#267-#280, #282-#286, #288-#291; #281,
#287, #292 and #293 are the parallel session's), main CI green on each merge sha through #291.
S21b (the title strip hides by its own width, `@container`) MERGED as #294 (`81c8850c`, post-merge
control green on the dev stack). S23 MERGED as #295 (`fef9e7c9`; CI restores a cached pnpm store,
so it cannot show a native build either way). S25 is PR #296. S24's config is committed locally in
worktree `dependabot-groups` (e78a22e5, body in scratchpad `s24-pr-body.md`); push it with its docs
commit only after 16:19Z, then ask the user how to budget `pnpm docker rebuild` disk for the group PRs.
Cleanup 2026-09-25 (user-approved): 5 merged agent-rules branches and 3 stale tracking refs
deleted; 18 orphaned repo dirs of deleted users removed (~2.5 GB); 5 unattached anonymous volumes
from 09-09/10 (~5.4 GB) removed; build cache pruned (25.88 GB -> 0), so S24's first
`pnpm docker rebuild` is cold. Recommended to the user: one rebuild after all group PRs land.
Final-pass smokes on `fef9e7c9`, inside haive-worker against the dev DB: upgrade-claims 43,
rtk-off-upgrade 21, superseded-runs 6, all OK, fixtures 0. `dag-coder-infra` opens the task queue,
so it runs only on its own Redis (CI's smoke job), never the dev stack's.
S21b was verified BEFORE merge by serving the worktree's web on :3000 in place of `haive-web`
([[web-dep-bump-browser-check]]): control, 124-width sweep and screenshots, then the container
restarted. Its thresholds came from a measured sweep: container queries read the CONTENT box, and
the app uses system fonts, so a CI runner's text widths differ; keep ~20px+ of title margin.
Web PRs are live-checked after merge with the repo's Playwright harness and a THROWAWAY user
(`registerUser`), never the user's credentials: a temp `*.tmp.spec.ts` run from the PR's worktree
against the dev stack, screenshots at 375/768/1280 into the scratchpad, run once BEFORE the merge
too so the check is shown to tell the two builds apart (S18's first sample did not). Committed locally, one worktree per PR under
`.claude/worktrees/`, each rebased when its turn comes and given a docs commit via scratchpad
`docs_status.py`:

- S16 #284 took one Codex round: behind a proxy that rewrites Host the proxied editor got 403, so
  the api now trusts its public origin resolved as the browser does (`HAIVE_PUBLIC_API_URL`, else
  WEB_ORIGIN's host on `HAIVE_API_PORT`; compose passes both to the api). Live-checked after
  `pnpm docker restart api` with curl, no credentials: 9 Origin cases + the CORS preflight.
- S20 `plan-image-survives-edit`, S21 `task-page-phone`, S22 `archive-test-timeout`,
  S25 `wave-consume-folded`: rebased on 9ed3e089, tests pass; PR bodies drafted in the scratchpad.
- S19 #288 round 1 (Codex P1): the final-review unwrap took a suffix run as a close. Fixed by
  exporting `fenceOpener`/`closesFence` from shared and requiring first line opens + last line
  closes; the lines between are deliberately NOT paired (a `markdown wrapper holds ` samples),
  and AGENTS.md names that exception. SHARED CHANGE: `pnpm docker libs` right after its merge.
  Live check: rerun scratchpad `s19-live.mts` (27 stored specs through 06's readers + the ddev
  guard) and diff against `s19-before.txt`.
- S23 `skip-native-ssh2` (e71ded52 on 9ed3e089; PR body in scratchpad `s23-pr-body.md`). The dev
  stack `pnpm docker rebuild` check was NOT run (4 new images, user's drive ~35 GB free, Docker
  cleanup declined); a no-side-effects-cache clean install measured instead.
- Remove each PR's own worktree and local branch right after its merge
  ([[remove-worktree-after-merge]]); never another session's (`retry-claim-fence` is theirs).
- Deferred live checks to report at the end: S13's two-provider rebuild (Docker was pruned by
  someone else, images rebuilding) and S12's authenticated route check (dropped).

**Design decisions not to re-litigate (design review + #270's Codex rounds):**

- **Backfill fix, as shipped in #270.** Bytes that are not a render follow ONE rule, in
  `backfillRecord` and in `cliRulesRegionRecord`. The bytes go in `writtenContent`. The render's
  hash is `writtenHash` (no claim). The bytes' OWN hash is `templateContentHash`, so the template
  reads as not installed.
  - 01's backfill records NOTHING for a path it offers as a conflict. 02 records it only when it
    writes, as a superseded baseline.
  - The data repair SWAPS `written_hash` and `template_content_hash`. Undo is the same swap. The
    old "written_hash = template_content_hash" sentinel is superseded, because it left repaired
    rows classified `unchanged`.
  - upgrade-status lets a non-current rendering stand for its template.
  - The control lives in the worker smoke (`smoke:upgrade-claims`, 25 checks, including a real 04
    rollback). The api reset test is NOT a control for this.
- **Deferred into S5 (Codex round 4 on #270):** "Keep my edits" is exactly Skip for every conflict
  (pre-existing). Persisting it needs a row that today's 04 would roll back as upgrade-introduced.
  So it goes in S5, AFTER the `source = 'upgrade'` filter: in place on a live row
  (`templateContentHash` = current), and as a non-claiming backfill row for an untracked path.
- **S8 takes the parallel session's row-version key** for the recap write:
  `WHERE id = summary_for_step_id AND status = 'done' AND ended_at = <captured at recap request>`.
  The key rides the payload. Their #263 leaves handlers.ts alone; tell them S8's PR number.
  Their 7d6bca3e (#263) puts `failed` outside the ownership predicate: `updateOwnedStep` /
  `lockOwnedStep` refuse pending, skipped and failed rows. So a pass cannot finish a Stop'd row, and
  hand-offs refuse a failed task, except the step-start write for an answer to a still-parked form.
  S8's rewrite of the handler must keep that.
- **02's obsolete delete removes whole files unguarded.** The hash guard (PR 5) MUST land before
  anything pre-selects obsolete rtk rows.
- **RTK-off:** the live `rtk_enabled` wins only when the context recorded an explicit choice, since
  the column defaults to true and pre-rtk repos must stay off. Drop rtk.* from `currentByTemplate`,
  never from `applicableSet`, or no drift is reported.
- **Legacy RTK.md removal:** the evidence is 07's `wroteFiles` claim plus a FROZEN legacy-body hash
  literal. The live-row leg never fires, because boot supersedes those rows.
- **cli-exec completion:** one transaction for both writes, mining writes bound to the invocation id,
  and park/resume outside the `try`. No reconcile change: the status compare-and-swap already
  rejects a committed row.
- **Recording `personaIds` on the mining row:** closed as attribution-only, so no migration.
  No schema migration anywhere in this series.
- **Toasts under the phone drawer:** stay keyboard-reachable (declined on #265).

Related: [[found-not-fixed-running-list]], [[agent-rules-followups-series]], [[haive-pr-workflow]],
[[typecheck-with-package-script]].
