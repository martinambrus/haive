# Close the gaps PR #171 found and left alone

> **DONE 2026-09-19, both parts.** Part A shipped as one commit per gap (PR #172): `066c42f7`
> (03's ref that names no node, and its truthful stamp), `744ce132` (11f/01f report what did not
> land), `24d5245d` (the chat header counts what landed) and `14928457` (Postgres notices to the
> logger). It followed this plan without a departure. Verified: `plan-canvas-smoke` 110/110; worker
> 4734, web 718 and shared 944 tests; in the browser, on real applies, a partial turn read "2 of 4
> plan changes applied", a version-conflict turn "0 of 2", and an old-shape turn still "3 plan
> changes"; worker boot logs went from 21 raw notices per boot (126 over 6 boots) to 0.
>
> Part B made test files type-checked and enforced. All 315 errors in 79 files were fixed first,
> per package (`5c9d94b2` shared, `ff4e102c` api, `a7054af3` worker src, `025e2d4f` worker test/),
> and `9c1e70ac` then pointed every server package's `typecheck` at a `tsconfig.typecheck.json`.
> VERIFIED: a planted test error now fails it. **As built**, three findings were more than
> fixture drift:
>
> - `findStructuralGaps` declared rows without the `createdAt` its callee reads (`3df566b0`).
> - `sub-agent-smoke.ts` read a variable renamed away long ago. That was a ReferenceError that
>   only stayed hidden because `smoke:ci` skips it (`ca3e2836`).
> - One tooling-form test had become an input-for-input duplicate once detect stopped reporting
>   the framework, so it was removed.
>
> The typecheck config also turns `incremental` off: every package shares `dist/.tsbuildinfo`
> with its build, and a typecheck of a different file set must not write the build's state. The
> two guard losses are recorded in `plan-patch-guard-losses`.

## Context

PR #171 (`356c17ee`) made an unresolvable plan-patch reference cost its op, not the
reply. Its final report listed gaps it left alone; the user asked to plan and fix them.
Investigation (read-only, 2026-09-19) confirmed each and found one more that #171 itself
widened:

| # | Gap | Evidence |
|---|---|---|
| 1 | `03-plan-sequence`: a garbled ref that is not uuid-shaped reads as a CREATE, fails "needs a title", and the whole ordering reply is lost | 1 mining row (`9237ecad-…" == null`); 03 passes `retryable: false` |
| 2 | `03-plan-sequence` stamps remit discards with the FAILURE prefix even when the reply's ordinals landed | `foldSequenceResults` (`03-plan-sequence.ts:~497`) stamps before applying; nothing replaces it on success |
| 3 | `11f-plan-reconcile` / `01f-external-plan-sync` only `logger.warn` their drops; `applied` = `chosen.length` and 01f's summary says "Applied N of M" counting them. **Widened by #171**: a stale-id upsert there used to fail the step loudly and now drops silently | 11f `:296-310`, 01f `:337-375`; 11f has no curated summary at all, so its panel is an LLM recap or nothing |
| 4 | Plan-chat header "· N plan changes" counts ops SENT; a partial turn shows 4 when 2 landed, an error turn shows N when 0 did | `opCount()` in `web/src/components/plan/plan-chat-turn.ts:15` |
| 5 | Every worker/api boot dumps ~27 raw Postgres NOTICE objects to stdout ("already exists, skipping", the six "does not exist, skipping") | postgres.js falls back to `console.log` with no `onnotice` (`postgres/src/connection.js:916-918`); all five clients in `shared/src/global-kb/connection.ts` and `shared/src/rag/connection.ts` omit it; 14 boots × each notice in worker logs |
| 6 | Test files are type-checked by nothing: 4 of 5 packages exclude `**/*.test.ts` and `include` only `src/**` | Measured with the TS API, exclusion lifted, `rootDir: '.'`: **315 errors in 79 files** (shared 4, api 20, worker 291); 0 non-test diagnostics |

Decided with the user: gaps 1-5 in **PR A**; gap 6 (all 315, `src/` + `test/`, enforced) in
**PR B**; the two further whole-reply loss classes Part B surfaced (malformed code links 2/81,
breadth cap 10/231) are **recorded, not fixed** — their own plan.

## Before touching `packages/worker/src`

Every write there restarts the worker (tsx watch). Check
`cli_invocations … ended_at is null and superseded_at is null` = 0 first; if a task is mid-CLI,
work in a `.claude/worktrees/` worktree instead (memory: haive-host-build-restarts-worker).

## PR A — branch `fix/plan-patch-gaps`, one commit per gap

### A1. 03 drops a ref that can name no node, and stamps a landed reply as partial (gaps 1+2)

`packages/worker/src/step-engine/steps/plan/03-plan-sequence.ts`

- New helper beside `bareNodeRef` (`:135`, reuse it and the file's `UUID_RE`): an upsert
  **names no node** when `nodeRef` is not a string, or is neither uuid-shaped after
  `bareNodeRef` nor `'self'`. In `foldSequenceResults`, after `keepOrderingOps`, split those out
  and report each in the applier's own wording, `upsert dropped: unknown node reference '<ref>'`.
  NOT inside `keepOrderingOps`: its second caller `agentOrdinals` (`:550`) must keep reading an
  invented ref the way the applier does (pinned by the `node:api` test).
- One stamp per reply, written AFTER the apply, from collected notes (remit note + unnamed +
  `outcome.dropped`): nothing left to apply → FAILURE prefix with the notes (nothing landed);
  apply threw → FAILURE prefix with the message (unchanged); applied with any notes → PARTIAL
  prefix; clean → no stamp. The remit-only-but-landed case moves from FAILURE to PARTIAL, which
  is the truth. `askedParents` reads no messages, so no scheduling changes.
- Tests (`plan-sequence.test.ts`, existing `foldSequenceResults` block + its mock): garbled ref
  dropped and the rest applied; remit-only landed reply → exactly one PARTIAL stamp; every op
  discarded → FAILURE; the existing remit+drop test tightened to a single stamp.

### A2. 11f and 01f say which approved changes did not land (gap 3)

`steps/workflow/11f-plan-reconcile.ts`, `steps/workflow/01f-external-plan-sync.ts`

- `applied` = `chosen.length - dropped.length`; new OPTIONAL `dropped?: string[]` on both apply
  outputs (outputs are persisted; old rows lack it).
- 01f `summary` (already curated): "Applied X of Y …" counts what landed, plus
  "N approved change(s) could not be applied: …" when any dropped.
- 11f gains a curated `summary` on every branch, worded like 01f's ("No plan to reconcile." /
  "The plan already describes this task's changes." / "Declined all N …" / "Applied X of Y …" +
  the dropped sentence). **Visible change:** 11f's panel becomes this deterministic line instead
  of an LLM recap (`resolveCuratedSummary`, `_step-summary.ts:6`), which also saves that CLI call.
- Tests: extend `01f-external-plan-sync.test.ts` with an applied-with-drop case; new
  `11f-plan-reconcile.test.ts` (applied / declined / dropped). Both mock `applyPlanPatch` via
  `vi.mock('@haive/shared/plan', importOriginal)` and `writePlanMirror` via
  `vi.mock('../../../plan/mirror.js', importOriginal)` — the repo's pattern
  (`01e-external-kb-sync.test.ts:13`).

### A3. The chat header counts what landed (gap 4)

`steps/plan/01-plan-chat.ts`, `web/src/components/plan/plan-chat-turn.ts`, `plan-chat.tsx:571-579`

- 01-plan-chat writes `outcome: { applied }` into the turn's `patchJson` when the patch had ops:
  `ops.length - res.dropped.length` on success, `0` when the apply threw. `patchJson` has one
  writer (`:320`) and one reader (`api/routes/plan.ts:710`, served untyped as `patch`).
- Web: `opCount` keeps its documented meaning (ops SENT); new narrow reader
  `appliedCount(patch)` → `number | null` (null for rows written before this). Header: unchanged
  when applied equals sent or is unknown; otherwise "· A of N plan changes applied".
- Tests: `plan-chat-turn.test.ts` (appliedCount incl. old rows / malformed), the
  `plan chat reply` block in `plan-chat-passes.test.ts` (outcome on partial, clean, error).

### A4. Postgres notices go to the logger, not stdout (gap 5)

`shared/src/global-kb/connection.ts` (2 clients), `shared/src/rag/connection.ts` (3 clients)

- Each `postgres()` call gets `onnotice: (n: postgres.Notice) => log.debug({ code: n.code,
  message: n.message }, 'postgres notice')`, using the `log` child each module already has.
  Debug, not dropped: still diagnosable at `LOG_LEVEL=debug`.
- Not touched: `database/src/index.ts` (main DB — no notice observed from it, and `@haive/database`
  cannot import the shared logger), `api/routes/tooling.ts` (a probe, no DDL). Stated in the commit.

### A5. Docs (`docs(plans):`, last, citing A1-A4 hashes)

- `plan-patch-drop-measurement.md`: fold "As built" into the "seventh sequencing loss … not fixed
  here" paragraph and the remit-prefix trap bullet.
- New `docs/plans/plan-patch-guard-losses.md` (Not started): the code-link (2/81, messages quoted)
  and breadth-cap (10/231) loss classes, why each is a design call, and the report-channel
  constraint (a stripped link must not count as a dropped op in A3's count). README row.
- Archive this plan as `docs/plans/plan-patch-gap-sweep.md` + README row (per the README rule).

## PR B — branch `test/typecheck-tests`, after PR A merges

- Per server package, `tsconfig.typecheck.json`: extends `./tsconfig.json`, `noEmit`,
  `rootDir: "."`, `include: ["src/**/*", "test/**/*"]`, `exclude: ["node_modules", "dist"]`;
  `"typecheck": "tsc -p tsconfig.typecheck.json"`. The build config keeps excluding tests or
  `tsc` would emit them into `dist`. Web already includes its tests.
- Fix the 315 by category, re-measured at start: fixture drift (TS2345/2741/2353/2322 — add the
  field the current type requires; if a fixture shows a test asserting a stale shape, fix the test's
  intent, never just cast it away), null-safety in test access (TS18047/2532/2722/18048/2531),
  arity (TS2554), casts (TS2352), unused (TS6133). `as never`/`as unknown as` only where the test
  deliberately feeds a malformed value, with a comment saying so.
- Commits: shared, api, worker `src/` tests, worker `test/`, then the enforcement flip LAST so
  every commit is green. `pnpm test` after each.

## Verification

- Per commit: the touched package's vitest (direct `exec vitest run`, no dist write), `tsc
  --noEmit` for shared/worker/web, `prettier --check`.
- `pnpm --filter @haive/shared build` once (A4 touches shared/src) — restarts the worker; boot logs
  must then show **zero** `severity: 'NOTICE'` blocks from worker and api.
- `smoke:plan-canvas` still 110/110.
- Browser (Chrome MCP, dev-login handoff; memory haive-worker-ui-check-without-llm): a fixture
  plan-chat conversation with a partial turn and an error turn — header reads "· 2 of 4 plan
  changes applied" / "· 0 of 4 …", an old-style turn without `outcome` renders as before.
- CI green on the PR head sha; merge commit; sync main (check for live runs first).

## Rollback

Code-only in both PRs: no migration, no data rewrite. `outcome` is an additive key in
`plan_node_messages.patch_json`; with the web reverted it is simply unread. 03's prefix change
affects new rows only. Each commit reverts alone; PR B's enforcement flip reverts by pointing
`typecheck` back at `tsconfig.json`.

## Adversarial checks already run

- A1 cannot lose a legitimate op: 03's ops are ordinal-only (`keepOrderingOps` strips titles), so
  an upsert that names no node could only ever reach `createNode` and fail "needs a title".
- A2's `applied` arithmetic is exact: every `dropped` entry is exactly one op (pre-flight: one per
  op; loop catch: one per op; `depends_on` refusal: one per link).
- A4 changes no query: `onnotice` only redirects output; notices are informational (`code 00000`).
