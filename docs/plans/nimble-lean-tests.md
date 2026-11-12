# Fast, minimal tests (T624)

> Status: in progress 2026-11-12. Board: T624.

## Context

The CI job "Lint, Typecheck, Unit Tests" has a 20 min limit and now hits it: #1098, #1099 and #1100 were each cancelled at 20 min, and a re-run passed. Its `Unit tests` step (`pnpm test` = `turbo run test`, every package's vitest at once on a 4-core runner) took 597-850 s on main and 950-990 s on PR branches. The owner's direction (2026-11-12): make tests as fast and minimal as will suffice, and use real HTTP, git, databases or end-to-end runs only where the behaviour under test needs them; update how tests are written and run, not just the limit.

Measured locally (vitest JSON reporter, 16 cores, baseline in `.claude/tmp/codex-run/T624-S/*.json`): 1,687 files, 1,690 s summed per-file time; worker 1,404 s, api 183, shared 73, web 25, database 5. The top 40 files are 63% of it; 63 files run over 5 s. Two causes dominate:

1. **Bounds tests at production scale.** A test proves a limit by building data at the real limit: `worker/test/project-state-sync-bounds.test.ts` 103 s for 11 tests (4,096 entries, 16 MiB), `project-state-write-bounds.test.ts` 66 s for 2 tests (the one that already flakes), `_credential-scan.test.ts` 73 s (49,152-line files, 100,001 paths, 600 KB strings).
2. **Real git and real waits for every input variant.** 99 test files spawn git; `12-worktree-cleanup` 71 s, `undo-left-committed-merge` 51 s, `git-merge` 44 s, `git-config-program-keys` 41 s, `plan-merge-apply` 38 s, `00a-sync-base` 32 s, `git-commit-wording` 30 s. Low test count with high time (`config-service-outage` 42 s, `tooling-connection-errors` 12 s for 2 tests, `bundle-files-cap` 13 s for 4) points at real timers.

Goal: the unit step under 8 min on CI with no test losing its intent, and a written rule so new tests start minimal.

## 1. The testing rule (docs, first PR)

New `docs/architecture/testing.md`, one line in the AGENTS.md topic index (AGENTS.md is at its 32 KiB cap: trim an equal amount elsewhere), and the same rules in `.claude/tmp/codex-run/rules-common.md` so every driver brief carries them:

- **Cheapest layer that can fail.** A pure function gets a unit test on in-memory input. Logic behind a seam (git runner, db, Redis, fetch) gets a unit test with the seam faked. Real git, PostgreSQL, Redis, HTTP or Docker only when the behaviour under test IS that interaction (git's own semantics, SQL locking, a real redirect or upgrade handshake), and then one representative test per behaviour; input variants go to unit tests of the pure part.
- **Limits are injectable.** Code that enforces a size, count or time limit takes it as an optional parameter defaulting to the named production constant. A test proves the bound at a small value; one assertion pins the production constant.
- **No real waiting.** Fake timers (`vi.useFakeTimers`) for every timeout, retry and backoff; a real deadline only where a child process or socket must actually expire, at the smallest value that proves it.
- **Fixtures built once.** A git repository or tree is built in `beforeAll` and copied per test, not replayed with `git init` and commits in every `beforeEach`. A shared helper for this in each package's test utilities.
- **Budget.** A new or changed test file runs under 5 s locally (`vitest run <file> --reporter=json`); over that needs a stated reason in the PR. Env-gated real-store tests stay in the GATED step.

## 2. CI structure (small PR, unblocks merges)

Split `Unit tests` out of the lint job into a matrix job: worker as 2 vitest shards (`--shard=1/2`, `2/2`), and one job for api, shared, web, database and the module scripts. Each job keeps the 20 min limit and gets its own runner, so wall time roughly halves without raising any limit. Add the slowest 15 files per job to the job summary (JSON reporter, report only, no gate: a timing gate on shared runners would flake). Keep `scripts/test/ci-step-independence.test.mjs` and the CI ratchets green.

## 3. Speed up the offenders (batched by cause, one PR each)

Each batch records per-file time and test count before and after, keeps every assertion's intent, and shows a red for each rewritten test against a mutation of the code it guards.

- **3a Bounds at small scale:** project-state sync and write bounds, `_credential-scan`, `upload-reaper`, `bundle-files-cap`, `rag-search-route`, and every other file whose cost is building data at a production limit. Production change limited to making the limit an injectable parameter.
- **3b Real timers:** `config-service-outage`, `tooling-connection-errors` and other files with few tests and high time; fake timers.
- **3c Git suites:** the git-heavy files above. A template-repository fixture copied per test; variant matrices moved to unit tests of the pure decision functions where the logic separates from git; one real-git test per behaviour kept.
- Then re-measure; continue down the list only while a batch still saves more than about 60 s of summed time.

## Order and interplay

PR 2 (CI matrix) first: it stops the cancels that block every merge. Then PR 1 (the rule), then 3a, 3b, 3c. T613 PRs continue alongside; heavy test runs stay serial on this host (measurements under load are noise).

Undo: each PR is a revert. No production behaviour changes except injectable limits whose defaults are the current constants.

## Verification

- Baseline and after: `vitest run --reporter=json` per package, summed and top-40 compared against `.claude/tmp/codex-run/T624-S/`.
- Full suite green at each PR; test counts unchanged or each drop explained.
- CI: the unit jobs' wall time on three consecutive main runs, all under 10 min per job.
