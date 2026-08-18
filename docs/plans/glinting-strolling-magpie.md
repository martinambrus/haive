# Browser-verification screenshot gallery

## Context

When a task involves a web app, `08a-browser-verify` in `mcp` mode already drives a real
browser through the chrome-devtools MCP: it navigates, clicks, submits forms and inspects
the DOM. Everything it saw is thrown away — the human reviewer at Gate 2 gets a text verdict
and a live VNC panel, and to actually check the work has to log into the project and redo the
flow by hand. For a small bugfix that is more effort than the fix.

Goal: the tester captures a screenshot at each test-case boundary as it goes, and the reviewer
scans them in an overlay gallery (next/prev without leaving the page) at the verification step
and at Gate 2. If the shots look right, approve without touching the app. Screenshots are
evidence, not deliverables — they die with the worktree.

Three things make this cheap rather than a build-out:

1. `take_screenshot({filePath})` writes the image to disk **instead of** attaching it to the
   response. Verified in chrome-devtools-mcp 1.7.0 source: `build/src/tools/screenshot.js`
   calls `context.saveFile(...)` then `appendResponseLine('Saved screenshot to X.')` — no
   `attachImage`. **Zero image tokens.** `McpContext.#writeFile` also does
   `fs.mkdir(dirname, {recursive:true})`, so no directory has to be pre-created.
2. The MCP server runs **inside the cli-exec sandbox** (`npx chrome-devtools-mcp
   --browser-url=<runner CDP>`, `mcp-config.ts:146`), whose cwd is `SANDBOX_WORKDIR`
   (`/haive/workdir`) — the task's git worktree, bind-mounted from `haive_repos`
   (`exec-core.ts:311-321`). A file the agent saves is immediately on the host volume,
   readable by both api and worker.
3. The API already streams those bytes: `GET /tasks/:id/files/raw?path=<abs>`
   (`packages/api/src/routes/tasks/files.ts:143`), auth + ownership + `validateWorkspacePath`
   enforced, `mimeForExtension` already maps `.webp` (`routes/tasks/_helpers.ts:65`). No new
   byte route is needed.

Two problems this also fixes / avoids:

- **Latent bug.** `_agent-templates.ts:930` instructs the integration-tester to save
  screenshots under `.claude/tasks/{task-id}/screenshots/`. Nothing excludes that path from
  git, so `10-gate-3-commit`'s `git add -A` (`10-gate-3-commit.ts:214`) commits browser
  screenshots into the user's repository. Moving capture to `.haive/` — which
  `01-worktree-setup` adds to `.git/info/exclude` — fixes it.
- **Path validation.** chrome-devtools-mcp 1.7 validates `filePath` against MCP *roots*
  (`McpContext.validatePath`). A client that negotiates roots (cwd) is fine; a client that
  negotiates none gets `os.tmpdir()` as the only allowed root and the write fails with
  "Access denied". Mitigated by passing `--allow-unrestricted-paths`, which only takes effect
  in exactly that no-roots case. The sandbox is already the security boundary and the agent
  can write anywhere in it via Bash, so this grants nothing new.

Decisions taken (confirmed with the user):

- **Lifetime = worktree lifetime.** Files live at `<worktree>/.haive/screenshots/`. Visible
  through the whole review window (08a and Gate 2); removed when `12-worktree-cleanup` runs
  `merge_remove`/`remove_only`, or on cancel via `removeTaskWorktree`. No new reaper, no disk
  growth. If the user picks step-12 `keep`, they persist with the worktree they chose to keep.
- **Capture scope = 08a only** (tester pass + its in-step fixer pass). `07`/`07b` fix-round
  browser blocks are untouched.
- **Captions from an agent-reported manifest**, so the gallery can say
  "Test 3: submit empty form → validation error → PASS" rather than humanizing a filename.

Non-goals: no capture in `interactive`/`direct` mode (no agent drives the browser there); no
video (`screencast_start` exists in 1.7 but is gated on `experimentalScreencast` and needs
ffmpeg, absent from the env image); no change to `visionDisallowedTools`
(`model-capabilities.ts:141`), so a no-vision model still has `take_screenshot` denied and
simply produces an empty gallery — removing that deny risks an inline image failing the run.

---

## Slice 1 — Capture (worker)

**New** `packages/worker/src/step-engine/steps/workflow/_screenshots.ts`, modelled on
`_commit-diff.ts` (same `.haive/` artifact convention, same `mkdir` + `writeFile` shape):

- `SCREENSHOTS_DIR_REL = '.haive/screenshots'`, `SCREENSHOT_MANIFEST_NAME = 'screenshots.json'`.
- `ScreenshotEntry { file, caption, testCase?, result: 'pass'|'fail'|'info' }`.
- `buildScreenshotManifest(workspacePath, reported: ScreenshotEntry[])`:
  - `readdir(<workspacePath>/.haive/screenshots)`, filter to image extensions, **sort by name**.
    Missing directory returns an empty manifest, not a throw.
  - Join disk entries with `reported` by basename. **Existence comes from disk only** — an
    entry the agent claimed but never wrote is dropped; a file on disk with no reported
    caption falls back to its humanized slug. This is the same discipline as
    `_commit-diff`: the agent supplies description, never truth.
  - Cap at 200 entries; set `truncated` when exceeded.
  - Write `<workspacePath>/.haive/screenshots.json`; return `{ artifactPath, count }`.
- Pure helpers (`humanizeSlug`, the join/dedupe) exported for unit test.

**`08a-browser-verify.ts`:**

- `testerOutputSchema` and `fixerOutputSchema` gain
  `screenshots: z.array(...).default([])`.
- `BrowserVerifyApply` gains `screenshots: ScreenshotEntry[]` (this pass's reported list) and
  `screenshotsArtifactPath: string | null`.
- `apply()` calls `buildScreenshotManifest` after each pass, accumulating reported entries
  across passes from the `StepLoopPassRecord` history (same accessor style as
  `accumulatedFixes`, `08a-browser-verify.ts:186`), so a fixer round's shots join the
  tester's in one gallery.
- `VISUAL_PROTOCOL` (`08a-browser-verify.ts:198-210`): flip the policy from "Take screenshots
  ONLY on a suspected anomaly" to capture-as-you-go — one shot per acceptance-criterion /
  test-case boundary, tied to the case being checked, **max 20 per pass**.
- `buildTesterPrompt` / `buildFixerPrompt`: state the exact call shape —
  `take_screenshot({ filePath: "/haive/workdir/.haive/screenshots/NN-slug.webp", format: "webp",
  quality: 60 })`, absolute path (do not rely on cwd), `NN` a zero-padded sequence, fixer shots
  prefixed `NN-fix-`. Keep "never attach inline except a hard-fail". Extend the required JSON
  shape with the `screenshots` array.

**`_agent-templates.ts` (integration-tester):** repoint every
`.claude/tasks/{task-id}/screenshots/` reference (lines ~877, 930, 1015, 1019, 1063-1065,
1138, 1149-1151, 1181) to `.haive/screenshots/`, and align the capture policy with the new
one. Body-only change → `contentHash` recomputes on worker boot, **no `schemaVersion` bump**
(CLAUDE.md onboarding-template rule 1).

**`mcp-config.ts:146`:** append `--allow-unrestricted-paths` to `chromeArgs`, with a comment
naming what it defends against (client negotiates no MCP roots → tmpdir-only).

Verify: `pnpm --filter @haive/worker test` (new `_screenshots` unit tests + the existing
agent-template hash test picks up the new bodies); `pnpm typecheck`.

## Slice 2 — Gallery component (web)

**New** `packages/web/src/components/browser/screenshot-gallery.tsx`, props
`{ taskId: string; artifactPath: string }` — the same contract as `CommitDiffViewer`.

- Loads the manifest exactly like `commit-diff-viewer.tsx:262` (`fetch(/tasks/:id/files/raw?
  path=<artifactPath>, { credentials: 'include' })` → `res.json()`).
- Thumbnail grid; each `<img src={API_BASE_URL}/tasks/${taskId}/files/raw?path=...>` direct
  (cookie auth is already proven cross-origin by the existing fetches). If verification shows
  a 401 on the img element, fall back to the authed-blob→`URL.createObjectURL` pattern in
  `task-source.tsx:230-250` with revoke-on-unmount.
- Click opens a full-screen overlay lightbox: single image, caption + `testCase` + a
  pass/fail chip, index counter, prev/next buttons, `←`/`→`/`Esc` keys, click-outside closes.
  Never navigates away, never opens a tab.
- Collapsible header matching the browser panels (`persisted-details.tsx`), renders `null`
  when the manifest is empty.

## Slice 3 — Wiring (worker detect + web page)

**`09-gate-2-verify-approval.ts` `detect()`:** add
`screenshotsArtifactPath: string | null` to `VerifyGateDetect` — set to
`<workspacePath>/.haive/screenshots.json` when `pathExists` says so (helper already imported
in 08a from `../onboarding/_helpers.js`), else `null`. Gate 2 only *points at* the manifest;
08a owns building it. Pointer only, so the 2s `GET /tasks/:id` poll stays small
(the `.haive/` artifact + small-pointer discipline from `_knowledge-diff` / `_commit-diff`).

**`packages/web/src/app/(app)/tasks/[id]/page.tsx`** — three render sites, all next to the
existing browser panels:

- 08a form `headerSlot` (~line 3190) — under `liveBrowserPanel`.
- 08a done/running block (~line 3317) — same.
- 09-gate-2 `beforeFieldsSlot` (~line 3198) — **below** the live browser, **above** the
  approve/reject fields, so evidence is read before the decision.

Gate all three on `!runtimeTornDown` (`page.tsx:2572`, `taskCancelled || completed`) — that is
exactly when the worktree, and therefore the files, are removed.

Pointer sources differ by step, and `applyOutput` is **not** a field the web sees:
`GET /tasks/:id` does a bare `db.select()` over `task_steps`
(`routes/tasks/index.ts:589`), so the web's step type carries `detectOutput` and `output`
(`api-client.ts:752,755`) — apply's return value lands in `output`. So 08a reads
`step.output.screenshotsArtifactPath`, 09 reads `step.detectOutput.screenshotsArtifactPath`.
`step.output` is the first consumer of that field in `page.tsx`; confirm it is populated on a
live 08a row during verification. It is also non-durable (`_step-reset` nulls it), which is
harmless here — a reset re-runs the step and rebuilds the manifest.

Verify: `pnpm typecheck`, prettier (`format:check` is the CI gate), `pnpm --filter @haive/web test`.

## Verification (end to end)

Run one real browser-testing task in `mcp` mode against a DDEV or app-runner project:

1. During the 08a tester pass, `docker exec` / worker shell: files appear under
   `<worktree>/.haive/screenshots/` as `.webp`, and `.haive/screenshots.json` lists them.
2. Grep the invocation stream for `Access denied` — must be absent. If present, the roots
   mitigation did not take and the flag needs re-checking against the pinned
   `chromeDevtoolsMcpVersion`.
3. Confirm the CLI stream shows `Saved screenshot to ...` lines and **no** base64 image
   blocks — the token cost of the feature must be the filenames only.
4. Task page: gallery renders at 08a and at Gate 2; lightbox opens, arrows/Esc work, captions
   and pass/fail chips populated.
5. `git status --porcelain` inside the worktree does **not** list the screenshots (proves the
   `.haive/` exclusion, i.e. the gate-3 commit leak is closed).
6. Finish the task with step-12 `merge_remove`; confirm the screenshots directory is gone and
   the commit contains no image files.
7. Cross-check a no-vision provider: gallery is empty, run does not fail.

## Rollback

Every piece is additive. Reverting the `08a` + `_agent-templates` prompt edits stops capture;
the manifest builder then writes an empty artifact and the web component renders `null`.
No schema migration, no config key, no new container, nothing persisted outside the worktree
that already gets deleted.

## Before implementing

Copy this plan to `haive/docs/plans/<fresh-slug>.md` (durable location — `~/.claude/plans` is
reaped after 30 days) and break the three slices into tasks so the plan survives compaction.

---

## Implementation status (2026-08-18)

All three slices implemented. `pnpm typecheck` clean (worker + web), 227 worker test files
(2758 tests) and 19 web test files (208 tests) green, repo `prettier --check` clean.

Files: new `packages/worker/src/step-engine/steps/workflow/_screenshots.ts`
(+ `_screenshots.test.ts`) and `packages/web/src/components/browser/screenshot-gallery.tsx`;
edits to `08a-browser-verify.ts`, `09-gate-2-verify-approval.ts`, `sandbox/mcp-config.ts`,
`onboarding/_agent-templates.ts`, and three render sites in `tasks/[id]/page.tsx`.

One trap found during implementation and fixed beyond the plan: **the capture directory has
to be handed to the sandbox uid explicitly.** chrome-devtools-mcp mkdir -p's the parent
itself, which is enough only while nothing else created `<worktree>/.haive` first. The worker
runs as root, so any step writing a `.haive/` artifact before 08a would leave a root-owned
0755 directory the uid-1000 agent cannot create `screenshots/` inside — failing every capture
with EACCES, visible only as tool errors inside the tester's transcript.
`ensureSandboxWritableTree` does NOT cover it: it stats only the tree ROOT and returns early
when that is already writable. `ensureScreenshotsDir` (called from 08a's mcp `prepare` hook)
mkdirs then repairs, best-effort — a browser verification must not fail because its evidence
gallery could not be prepared. Today's step order happens not to hit this, which is exactly
why it was worth closing rather than depending on.

Verified against the real binary (chrome-devtools-mcp 1.7.0, live Claude Code client):

- `take_screenshot({filePath})` returns text only (`Saved screenshot to X.`) — no image
  content block, so the feature costs no image tokens. Confirmed in source
  (`build/src/tools/screenshot.js` → `context.saveFile`) AND by a live call.
- A write to a non-temp absolute path under the client's negotiated root succeeds — the exact
  case the cli-exec sandbox is in (claude-code negotiates cwd `/haive/workdir`).
- `--allow-unrestricted-paths` parses in both kebab and camel spellings, and the CLI does not
  run yargs `.strict()`, so an older pinned version simply ignores the flag.
- A 1280-wide viewport shot at `webp@60` is ~8.6 KB, mode 0600. 20 shots ≈ 170 KB — which is
  why no disk quota was added beyond the prompt's per-pass cap.
- Completed tasks' worktrees are already gone from `haive_repos`, confirming the teardown half
  needs no new reaper.

Not yet verified (needs a live browser-testing task in `mcp` mode, and the global pause is
currently on): that the tester actually populates `.haive/screenshots/` during a real run, that
the gallery renders at 08a and Gate 2, and that `git status` in the worktree stays clean.
