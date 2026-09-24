# Found-not-fixed follow-ups from the agent-rules series

> **IN PROGRESS.** PR 1 shipped as #249 (`5223d7b3`). PR 2 is in review (branch `csp-mermaid`).
> Tracked in the status table of `docs/plans/README.md`, which each PR updates.

## Context

The agent-rules series (#229, #231, #242, #232, #235, merged 2026-09-24) left a found-not-fixed list;
the user asked to plan fixes and PRs for it. Three Explore passes (main `1467652b`) re-verified every
item, and a Plan-agent review of the draft found three PRs unsafe as drafted and one "test flake" to be
a real bug. Everything below is folded in.

The biggest finding: text an agent writes can make the viewer's browser fetch an outside URL, through
markdown images and through at least nine mermaid paths. Only a Content-Security-Policy closes the
mermaid half reliably; filters are a second layer.

User decisions (2026-09-24): markdown images become links that are never fetched; out-of-scope reviewer
findings are shown at gate 2 as a collapsed display-only row; below `md` the sidebar collapses without
overwriting the saved preference.

## Order

| # | PR | Area |
|---|---|---|
| 1 | Markdown images become links; three fences sized to content | web, worker |
| 2 | CSP for images, media and fonts; mermaid hardened behind it | web, shared |
| 3 | Rules files are staged correctly | worker |
| 4 | The cli-rules record describes the region on disk, without claiming a person's edit | worker |
| 5 | Reset strips the RTK block | shared, api, worker |
| 6 | The upgrade banner sees a missing import stub | shared, api, worker, web |
| 7 | Reads inside a worktree go through the repository anchor | worker |
| 8 | Out-of-scope findings reach gate 2 (gate 3 where there is none) | worker, docs |
| 9 | Phone-width sidebar, CSS first | web, e2e |
| 10 | Provider secrets survive a fast typist | web, e2e |
| 11 | Test flakes: mining-retry mock, hydration marker | worker test, web, e2e |
| 12 | Stale docs | comments, docs |

1 and 2 first. 3 moves `isGitIgnored` into `onboarding/_rules-files.ts`; 4 and 6 build on the same
module (region reading, rules-file helpers), so 3 → 4 → 6. 5 lands before 6 (both move constants into
`@haive/shared`). The rest are independent.

**Every PR:**
- Worktree under `.claude/worktrees/`, branch, PR, merge commit.
- Codex rounds with the row-aware watcher until a round brings no valid fix. A push that gets no review
  within 8 minutes gets one `@codex review`.
- CI on the full sha, then main CI on the merge commit. Confirm that the HEAD sha's own run completed,
  since a late push event can cancel it.
- After a merge touching shared: no task running, then `pnpm docker libs`. No migrations are needed.
- Checks that need a real onboarding or workflow run become rows in the memory index
  `onboarding-run-checkpoints`.
- **Plan record:** PR 1 copies this plan to `docs/plans/agent-rules-followups.md` with a README status
  row; each later PR updates the row, and the last marks it shipped. It must NOT reuse this file's
  slug: `docs/plans/compiled-noodling-squid.md` is the shipped agent-rules plan.
- **Tasks:** one per PR, created when execution starts.

## PR 1 — Markdown images become links

- **One rehype plugin** in `web/src/components/markdown/` replaces every `img` element before render:
  - An image inside a link becomes its alt text, so a badge line `[![b](i)](l)` never nests `<a>`.
  - Any other image becomes a link that opens in a new tab and reads "image: alt".
  - An empty or blanked `src` (react-markdown 10.1.0's `defaultUrlTransform` blanks `javascript:` and
    `data:`) becomes plain text.
  - The link it creates still passes through `urlTransform`.
- **Applied at all four `ReactMarkdown` sites:** `markdown-view.tsx`, `quiz-block.tsx`,
  `code-preview-dialog.tsx`, `task-source.tsx`. A guard test fails if a new `<ReactMarkdown` in
  `packages/web/src` omits it.
- **Fences sized to content:**
  - Web: `code-preview-dialog.tsx:165` and `task-source.tsx:110-117` share one helper.
  - Worker: the command output at `09-gate-2-verify-approval.ts:801` (used at 824 and 1119), and the
    mermaid wrap at `06-gate-1-spec-approval.ts:229`. Both use a block-fence helper beside `code()` in
    `workflow/_plan-ops.ts`.
- **As built:** the plugin is not added at each site. `components/markdown/markdown.ts` exports
  `Markdown`, react-markdown with the plugin always run last, and all four sites render through it;
  the guard test fails on any other value import of `react-markdown`, which is a structural check
  rather than a scan of JSX props. It is written without JSX so the web package's vitest can render
  it, which lets the tests run the real pipeline (remark, the plugin, react-markdown's own
  `urlTransform`) instead of hand-built HAST trees. A third worker site was found and fixed:
  `_test-preflight.ts` wraps the test runner's output in a fixed fence in a form description.
- **Tests:** the plugin on plain HAST trees in a `.ts` test (the web package has no JSX test setup).
  Cases:
  - image;
  - image in a link;
  - blanked `src`;
  - reference-style `![a][ref]`;
  - the fence helpers against content that holds backtick runs.
- **Verify (live, zero tokens):** the #242 fixture recipe. Seed a parked gate whose body holds an image,
  then check with `list_network_requests` that the image host gets no request, collapsed or expanded.
  Seed a control fixture first, which does show the request. Repeat for a step summary and a plan node
  body.

## PR 2 — CSP for images, media and fonts; mermaid behind it

- **The CSP, the primary fix:** set per request in `web/src/middleware.ts`, because the API origin is
  resolved at runtime (`resolveApiOrigin`):
  `img-src 'self' data: blob: <apiOrigin>; media-src 'self' blob: <apiOrigin>; font-src 'self' data:`.
  - There is no `script-src` or `default-src`, so the root layout's inline script needs no nonce.
  - Before landing, survey every image, media and font origin the app loads (screenshots come from the
    API origin, previews use `blob:`). Then run a browser pass over the main pages checking
    `list_console_messages` for CSP violations.
- **Exported pages:** `export-html.ts` writes
  `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">`.
- **Mermaid layers under the CSP** (`mermaid-loader.ts`, mermaid 11.17.2):
  - Settings: `htmlLabels: false` at the top level and in `flowchart`.
  - `dompurifyConfig`:
    - `FORBID_TAGS`: img, image, feimage, picture, source, video, audio, track, iframe, object,
      embed, link, style, input.
    - `FORBID_ATTR`: style, src, srcset, href, xlink:href, background, poster.
    - This closes HTML labels, sequence-diagram `$$` lines, architecture labels and eventmodeling
      boxes.
  - `secure` gains `htmlLabels`, `themeCSS`, `fontFamily`, `themeVariables`, `altFontFamily`,
    `dompurifyConfig`. `sanitize()` deletes secured keys at any depth, and the array merge keeps
    mermaid's defaults; a test asserts `securityLevel` is still secured after `initialize`.
- **One guarded render** (`renderUntrusted` in the loader), used by both `MermaidBlock` and `PlanGraph`:
  - It refuses sources with `%%{` directives, `---` frontmatter, `@{` shape metadata, or a sequence
    `properties` line, and shows them as code.
  - A comment records that `bindFunctions` must never be called, because tooltips are sanitised only
    with the default profile.
- **PlanGraph titles:** `label()` in `shared/src/plan/impact.ts` also escapes `%`, `<` and `>`. A
  27-character `%%{init…}%%` fits under the 40-character label cap.
- **Tests:**
  - the refusal predicate;
  - the secured-key list;
  - the label escaping.
- **As built:**
  - The CSP hostname comes from the request's Host header. Next's `nextUrl` does not carry it:
    MEASURED on a production build, `Host: haive.example.test` read as localhost, which would have
    blocked the api's images for anyone reaching an install by IP or DNS name. The same build
    showed that runtime-only `HAIVE_API_PORT` reaches the header, and that an explicit
    `HAIVE_PUBLIC_API_URL` is reduced to its origin.
  - The api's host is named under both `http:` and `https:` (review round 1): a TLS proxy serves the
    page over https while the server sees http. MEASURED in Chrome, `img-src http://127.0.0.1:47937`
    refused `https://127.0.0.1:47937/a.png`; listing both admits it and still refuses another port.
    Both schemes rather than trusting `X-Forwarded-Proto`, since a proxy may not set it.
  - The guarded render is `renderMermaid`, and `loadMermaid` is internal to the loader.
  - The `properties` refusal matches the sequence syntax (`properties <actor>:`), so a flowchart node
    named `properties` still draws.
  - MEASURED before choosing to refuse: none of the 12 distinct diagrams stored on the dev install
    uses a directive, frontmatter, `@{` or `properties`.
- **Verify:** a local HTTP listener stands in as the outside host. Fixtures cover every vector:
  - HTML label;
  - image shape;
  - sequence icon and `$$`;
  - architecture;
  - eventmodeling;
  - `themeCSS`;
  - `fontFamily`;
  - `classDef` CSS.

  The listener must get zero hits, and the plan impact view must still render.

## PR 3 — Rules files are staged correctly

- **Move `isGitIgnored`** from `03-upgrade-commit.ts` into `onboarding/_rules-files.ts`; 03 imports it
  from there.
- **Step 12** (`12-post-onboarding.ts`):
  - After any `git init`, filter the FINAL stage list by exact name. `AGENTS.md` enters that list both
    through `EXTRA_RULES_STAGE_PATHS` and through a live row's `diskPath`.
  - Drop each of `AGENTS.md`, `CLAUDE.md`, `GEMINI.md` and `.gemini/settings.json` that git ignores, and
    warn about it.
  - Skip `git add -f` when the list ends up empty.
  - The check never extends to `.haive/`: `.git/info/exclude` lists it, and `.haive/install.json` is
    force-added on purpose.
- **03 stages a stale AGENTS.md.** The check, in this order:
  1. Read disk with `readTextNoFollow(..., { strict: true, maxBytes })`. A link or refused read: skip
     and warn. No file or no region: nothing to stage.
  2. No HEAD: stage, matching `headLacksImport`.
  3. `git ls-tree -z HEAD -- AGENTS.md`. A non-zero exit: cannot tell, warn. Empty output, or mode
     120000 or 160000: stage.
  4. `cat-file -s` above a cap: cannot tell. Otherwise read `cat-file blob` with a buffer sized to the
     cap.
  5. Compare the normalised cli-rules region hashes, and stage when they differ.

  The ignore filter then applies to `AGENTS.md` on every route, `writtenPaths` included. Staging
  stays whole-file, as documented.
- **Tests** (`upgrade-commit-stage.test.ts` plus a new 12 staging test):
  - no HEAD;
  - absent from the HEAD tree;
  - same region with other lines edited (not staged);
  - a symlinked AGENTS.md;
  - an ignored AGENTS.md arriving through `writtenPaths`;
  - 12's ignored stub and empty list.
- **Live check:** a run-checkpoint row. It needs an onboarded repository.

## PR 4 — The cli-rules record describes the region on disk

- **Step 12 records** `D = normalizeContent(region on disk)`:
  - `templateContentHash = sha(D)` and `writtenContent = D`.
  - `writtenHash = sha(D)` only when D equals 07's render, or equals the `writtenHash` of a superseded
    cli-rules row for this repository. Otherwise it is the render's hash.
- **What that gives:**
  - The banner reports a stale region as an upgrade.
  - An untouched Haive region classifies as `clean_update`.
  - A region of unknown origin (a person's edit, an agent's write in 08-11) classifies as `conflict`,
    whose default is skip, instead of being overwritten silently.
  - A rollback restores bytes that really existed.
  - The reset and `.haive/install.json` are unaffected.
- **No region on disk:** write no row and supersede any live cli-rules row, so a stale record does not
  stand.
- **01's backfill** uses the same rule scoped to the region, `userModified` included. It no longer
  stores the whole file, which a rollback would paste into the region.
- **Tests:**
  - a pure helper for the record decision;
  - `upgrade-plan-classify.test.ts` cases: region untouched, region edited, region of unknown origin,
    backfill.
- **Live check:** a run-checkpoint row.

## PR 5 — Reset strips the RTK block

- **Move the markers** `PROJECT_INFO_START/END` (07) and `RTK_REF_MARKER_START/END`
  (`_rtk-templates.ts`) into `@haive/shared` beside the cli-rules markers. The worker re-exports them,
  as it already does for cli-rules.
- **`stripHaiveContent`** (`api/src/routes/repos.ts`) takes all three pairs from shared instead of two
  hard-coded literals.
- **Comments:** `_rtk-templates.ts` lines 3-5 (RTK.md is no longer written) and 26-29 (true once this
  lands).
- **Tests:** `repo-artifact-reset.test.ts` gains an RTK block case.

## PR 6 — The upgrade banner sees a missing import stub

- **Shared catalog** gains `rulesFile` and `rulesFileMode` per provider. A worker test asserts every
  adapter matches its catalog entry, following the `cli-adapter-stubs.test.ts` pattern.
- **Move to a Node-only `@haive/shared` subpath** (the `./attachments-fs` pattern): `RULES_IMPORT_LINE`,
  `isLinkToAgentsMd`, `missingRulesImportStubs` and `planRulesFiles`. `_rules-files.ts` re-exports them,
  so the API and the worker compute the same list.
- **`GET /repos/:id/upgrade-status`** gains an optional `missingRulesImports`, which sets
  `hasUpgradeAvailable`.
  - A stub that links somewhere other than AGENTS.md is reported separately and does not count,
    because the upgrade refuses to write through it.
  - An unreadable repository root means "unknown", not "missing".
  - Reads pass `maxBytes`.
  - The cost is fine: the banner fetches once per repository card, with no polling.
- **Banner** names the missing import as the reason.
- **Tests:**
  - an API test with a temp repository lacking the stub;
  - a stub linked elsewhere;
  - the shared helper tests, which move with the helpers.
- **Verify:** remove the stub on a scratch copy and check the endpoint and the banner in the browser.

## PR 7 — Reads inside a worktree go through the repository anchor

- **Pattern:** `workspaceAnchor(tree)` (`repo/worktree-paths.ts`), then read `prefix + rel` from the
  anchor. Queued import rels stay tree-relative, so `@../../x` is still refused against the tree root.
- **Sites:**
  - `agent-isolation.ts:93`, the instruction-chain scan;
  - `agent-isolation.ts:189`, the persona reader;
  - `11-phase-8-learning.ts:557, 564, 720, 876`. The same file's writer at 694-695 is already
    anchored.
  - `11d-skill-sync.ts:528`;
  - `_commit-diff.ts:133`. The same file's write at 217 is already anchored.
- **Tests:**
  - a worktree-shaped fixture (`.haive/worktrees/<name>/CLAUDE.md` with an import);
  - a link at the worktree directory ends isolation, which is the scan's fail-open direction;
  - the existing cases stay as they are.

## PR 8 — Out-of-scope findings reach gate 2

- **Gate 2 detect** scans the task's raw outputs itself, because `plan_tasklist` runs gate 2 but not
  08e and `quick_bugfix` runs neither.
  - It filters in SQL (`raw_output ILIKE '%INSIGHTS%'`).
  - It parses with 08e's `parseInsights`, exported.
  - It subtracts 08e's `output.selected`, keyed by title plus location, since the `i-N` ids are
    positional.
  - Each line is collapsed and capped (`collapseToLine`), then escaped as #242 escapes a reason.
  - The 30-item limit is stated when it is reached.
- **Form:** a collapsed info row, "Out-of-scope findings — not acted on", after the similar-sites row.
  To act on one, reject with feedback that names it.
- **Gate 3** shows the row when no gate-2 decision exists, mirroring similar sites, so `quick_bugfix`
  (07 findings) is covered.
- **Docs:** AGENTS.md's review-scope paragraph says where these findings surface.
- **Tests:** gate 2 with insights, with none, with a partial manual selection, and with a legacy
  payload; gate 3 fallback.
- **Verify:** a fixture gate in the browser.

## PR 9 — Phone-width sidebar, CSS first

- **CSS first, no flash.** The server paints the saved width inline. Below `md`, an `!important` media
  rule:
  - forces the rail width;
  - forces `--haive-sidebar-w` to the rail;
  - hides the expanded-only parts and the resizer.

  One breakpoint expression is shared by the CSS and JS.
- **After hydration:**
  - `effectiveCollapsed = collapsed || (narrow && !phoneOpen)`, with a `false` server snapshot. This
    also unmounts `SidebarTasks` and its 5-second poll.
  - On a phone the toggle flips local state and never calls `patchUiPrefs`.
  - The opened sidebar overlays the page (z-40, above the z-30 title strip) and the variable stays at
    rail width.
- **Task page:** the title's `min-w-[18rem]` and the rename input's `w-80` apply from `md` up. The app
  `main` padding narrows below `md`.
- **Tests:**
  - an e2e case at 375px with JavaScript disabled (rail painted, no flash);
  - an e2e case at 375px with JavaScript on (open overlay, preference unchanged in the database).
- **Verify:** Chrome MCP at 375, 768 and 1280 on the dashboard, a task page and the repositories page.
  Check that there is no horizontal page scroll and the title strip is aligned.

## PR 10 — Provider secrets survive a fast typist

- **The bug:** `cli-provider-form.tsx:359-382` loads `/secrets` and overwrites the textarea when it
  answers, and the textarea is never disabled (1129-1135). A person who types before the load loses
  that text without a word.
  - "Fill only when empty" is not the fix: the save deletes every existing secret not listed
    (519-520).
- **Fix:** keep the textarea read-only until the secrets have loaded.
- **Test:** `cli-providers/ui.spec.ts:95` waits with `toBeEnabled()` before typing.
- **Verify:** in the browser, with the network throttled, the field stays locked until the load
  answers.

## PR 11 — Test flakes

- **`step-runner-mining-retry.test.ts`:** a partial `vi.mock('.../runner-browser-cdp.js', importOriginal)`
  so no `advanceStep` test spawns `docker exec`. Assert the mocked reaper was called at the barrier.
  With docker off `PATH` the call fails fast either way, which proves nothing.
- **`sidebar/tree.spec.ts:229`:** run 35900098216 attempt 1 failed at line 250, where the width was
  never saved. `gotoWithSidebar` waits on server-rendered text, so the drag can land before hydration.
  - An app-shell effect sets `document.documentElement.dataset.hydrated`.
  - An e2e helper waits for it; `gotoWithSidebar` and the other interaction helpers use it.
  - The drag targets an absolute x, so the spec stays deterministic.

## PR 12 — Stale docs

- `_untrusted-repo.ts:196-203` says the ledger reaches prompts raw; it has been fenced since #216.
- AGENTS.md:1211 ("Review findings and waivers") says nothing SELECTs `review_findings`; in fact
  `loadFindingRecurrence` and `GET /stats/quality` do. The claims about the single insert and "no
  behaviour gates on it" stay.

## Closed without code

- **Codex reads only the first 32 KiB of AGENTS.md:** #235 injects the rules into every Haive prompt.
- **A late GitHub push event cancels a newer main run:** external; the per-PR process checks the HEAD
  sha's own run.
- **Syncing main before `libs` crash-loops the api for about 10 s:** process; the no-task check covers
  it.

## Found during planning, not in scope

- Nothing removes the RTK block when RTK is switched off (07 writes it only when enabled).
- Legacy `RTK.md` files from early versions are not removed by a reset.
- Session cookies are `SameSite=Lax` and the API is same-site, and the CSP must allow the API origin
  for screenshots. So an image aimed at the API still carries the session; GET endpoints with side
  effects were not surveyed.
