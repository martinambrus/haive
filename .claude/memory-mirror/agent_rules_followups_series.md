---
name: agent-rules-followups-series
description: "SHIPPED 2026-09-24 (all 12 merged; PR 9 #265 last): 12 PRs fixing the agent-rules series' found-not-fixed list (markdown images→links, image/media/font CSP + mermaid hardening, rules staging, honest cli-rules record, RTK reset, stub-aware banner, worktree anchors, gate-2 out-of-scope findings, phone sidebar, secrets race, test flakes, stale docs)"
metadata:
  node_type: memory
  type: project
  originSessionId: 3813bbf6-9261-4b06-870d-404ed90866bb
  modified: 2026-09-24T11:49:11.843Z
---

Plan: `/home/activit/.claude/plans/compiled-noodling-squid.md` (approved 2026-09-24). PR 1 copies it to
`docs/plans/agent-rules-followups.md` — NOT the plan slug, which is the shipped agent-rules plan in
docs/plans. Tasks FU-1..FU-12 (#14-#25) in session 3813bbf6 mirror it. Order: 1, 2 first; 3 → 4 → 6
(shared rules-file module); 5 before 6; rest independent. No migrations.

User decisions (2026-09-24, via AskUserQuestion):

- Markdown images become LINKS, never fetched ("image: alt"); an image inside a link becomes its alt.
- Out-of-scope reviewer findings (`## INSIGHTS`) shown at gate 2 as a collapsed display-only row (gate 3
  when there is no gate 2), keeping auto-continue hands-free.
- Phone width: sidebar auto-collapses below `md` WITHOUT overwriting the saved preference.

Decisions from the Plan-agent review, not to re-litigate:

- **The CSP is the primary fix for outbound fetches, filters are a second layer.** mermaid 11.17.2 has at
  least nine fetch vectors (HTML labels, `@{img:}` shapes fetched during render, sequence `properties`
  icons and `$$` raw HTML, architecture labels, eventmodeling boxes, `themeCSS`/`fontFamily` CSS
  `url()`, stateDiagram `classDef` CSS). `img-src/media-src/font-src` only — no `script-src`, so the
  root layout's inline script needs no nonce; set per request in `middleware.ts` (API origin is runtime).
  mermaid `secure` deletes secured keys at ANY depth and the array merge keeps the defaults.
- **PR 4 `writtenHash`:** `sha(D)` of the disk region only when D equals 07's render or a superseded
  row's `writtenHash`; otherwise the render's hash, so a region of unknown origin classifies as
  `conflict` (default skip), never a silent `clean_update`. Recording disk unconditionally would launder
  a person's (or an 08-11 agent's) edit into "Haive's".
- **`cli-providers/ui.spec.ts:95` was a REAL bug, not a flake:** the `/secrets` load overwrites the
  textarea (`cli-provider-form.tsx:359-382`) and the save deletes unlisted secrets; fix = read-only until
  loaded. `sidebar/tree.spec.ts:229` failed at line 250 (width never saved): pre-hydration drag; fix =
  `data-hydrated` marker + helper.
- **Mining-retry timeout:** the test reaches `reapAgentBrowserTabs` → real `docker exec` subprocesses;
  mock `runner-browser-cdp.js` (partial) and ASSERT it was called — docker off PATH proves nothing.
- **PR 8 scans raw outputs itself** (`plan_tasklist` runs gate 2 but not 08e; `quick_bugfix` neither),
  subtracting 08e's `selected` by title+location (ids are positional).
- **PR 9 is CSS first** (`!important` media rule over the SSR inline width), else phones flash 256px.

Progress:

- **PR 1 = #249 MERGED 2026-09-24 as `5223d7b3`** after one Codex round (👍, no findings); main CI green; main checkout synced (worker restarted cleanly, no task was live).
  - As built: one wrapper `Markdown` (`components/markdown/markdown.ts`, JSX-free so web's vitest can
    render it). All four react-markdown sites go through it, and `markdown.test.ts` fails on any other
    value import. It replaced "plugin at each site + JSX-prop scan".
  - A third worker fence site was found and fixed: `_test-preflight.ts`.
  - Verified live, zero tokens, fixtures deleted: control 8+1 image requests; branch web 0.
  - Web-swap recipe used ([[web-dep-bump-browser-check]]).
  - Worktree gotcha: after merging main, rebuild the WORKTREE's database/shared dist, or the worker
    typecheck fails on the new column (`dispatchPrompt`, migration 0167).

- **Merged 2026-09-24, each on a clean final Codex round, main CI green on the last merge sha,
  main checkout synced to `37365628`:** PR 2 #250 (`daf5001c`, 3 rounds: TLS-proxy scheme fix,
  `@` label encoding, clean), PR 3 #252 (`643118b3`), PR 5 #254 (`a8088d38`), PR 10 #255
  (`37365628`), PR 12 #253 (`800556c8`). The sync broke api/worker for ~13 s with "does not provide
  an export" until `pnpm docker libs` finished, then both came back; expected, run libs right after
  a pull that touches shared.
- **PR 4 = #256 MERGED as `681b0ca7`.** Root cause MEASURED: 07's
  `appendOrCreate` returns without writing when the region exists and overwrite is off, so step 12's
  render-as-record claimed bytes that were never there. Live check with the real step code on a
  fixture repo: 18/18 pass, the same script on main fails 12. Earlier renders = `onboarding` and
  `upgrade` rows only (backfill/rollback hashes are "whatever was on disk"). The PR also carries a
  docs commit bringing the plan record up to date (PRs 2/3/5/10/12 had merged without it).
- **PR 2 = #250** (branch `csp-mermaid`, head `e21f733d`). Opened 2026-09-24; live-verified at zero tokens (listener: 4 hits → 0).
  - MEASURED: Next's middleware `nextUrl.hostname` ignores the Host header (production build, `Host:
haive.example.test` → localhost). The CSP host therefore comes from `request.headers.get('host')`
    (`browserHostname`); runtime-only `HAIVE_API_PORT` does reach the middleware in production.
  - Stored diagrams on the dev install: 12 distinct, all flowchart/graph, none using a directive,
    frontmatter, `@{` or `properties`. That is why refusing those costs nothing.
  - Plan docs, not code: the guarded render is named `renderMermaid`, not `renderUntrusted`.
- **PR 7 = #258 MERGED 2026-09-24 as `38449542`** after 2 Codex rounds; main CI green; main checkout
  synced to `38449542` (worker restarted cleanly; only parked `waiting_user` tasks, no live runs).
  Round 1 (P2, valid, a REGRESSION of the PR): the no-follow walker read a linked worktree as an EMPTY
  tree and 11c's orphan sweep would delete every tracked file's rows. Fixed with `scanRootRefusal`
  (`_rag-index.ts`), which also covers 02 on a missing root. Control: 2 of 4 fail without it.
- **PR 6 = #260 MERGED as `3a7bcdd5`.** `@haive/shared/rules-files` (Node-only subpath) holds the
  import check; catalog gains `rulesFile`/`rulesFileMode` (lockstep-tested); `upgrade-status` gains
  `missingRulesImports` (sets `hasUpgradeAvailable`) and `linkedRulesFiles` (never). Live-verified on a
  fixture root (scratch repo row with `localPath` under `/host-fs`, which the api container mounts).
  Main CI on it failed once in `cli-providers` e2e (sandbox-build timing, see
  [[found-not-fixed-running-list]]); attempt 2 green.
- **PR 8 = #261 MERGED as `4ec2b669`**; its main run was cancelled by #259's push, and #259's
  `f1c5bd3b` run (which contains it) was green; main synced to `f1c5bd3b` with `libs` (#259 touched
  shared).
- **PR 11 = #262 MERGED as `f5fb095f`** after 3 Codex rounds, all 👍. Two things found in its own CI:
  (1) waiting for hydration let the dashboard render in full, and the resizer is as tall as the page,
  so the drag's box-centre press landed at y=1022 in a 720 px viewport — it now aims at the on-screen
  part; (2) `tasks/actions.spec.ts:62` (10 of 53 runs flaky since 09-21) waited on a condition the
  fixture already met and read its event once — it now polls the event. Final CI: 139 passed, 0 flaky.
  Main CI green, main synced (web + tests only).
- **PR 9 = #265 MERGED as `cad6a0bf`** (branch `phone-sidebar`), opened as a draft so the docs commit
  could carry its own number, then marked ready. Round 1 (2 x P2, both valid, fixed in e3a719af): drop
  the open state when the phone layout ends (rotation past 768 reopened it), and make `<main>` inert while
  open (Tab walked into the covered page); each pinned by an e2e case that fails 3/3 without its fix.
  Round 2 (P2, DECLINED, do not re-litigate): toasts stay in the Tab order while the drawer is open —
  they are `fixed z-40` portaled after the app root, and MEASURED with `elementFromPoint` they are the
  topmost element over both the drawer and the backdrop, so a pointer can use them too; the shared
  `Dialog` traps no focus either.
  POST-MERGE CHECK on the container caught that the drawer's Escape NEVER worked: `CliAuthBannerModal`
  (always mounted by `CliLoginProvider`, closed) stopped every Escape at `document` since decc0a1c
  (2026-09-05), so no `window` Escape listener in the app fired (5 other sites too). Fixed in #266
  (open guard + an e2e Escape case). Lesson: e2e every behaviour a PR advertises, Escape included. Its docs commit marks the SERIES SHIPPED. Two corrections
  to the plan: the formula `collapsed || (narrow && !phoneOpen)` never opened for a saved-collapsed user
  (the dev user is one), and keying the open state on the page alone reopened it on return — fixed by
  dropping it during render when the pathname changes (an e2e case fails 3/3 without that line).
  Verified at 375/767/768/1280 on dashboard, task page, repos; local e2e 9/9 phone, 61 warm sidebar +
  layout runs green.

Related: [[agent-rules-series]], [[found-not-fixed-running-list]], [[onboarding-run-checkpoints]].
