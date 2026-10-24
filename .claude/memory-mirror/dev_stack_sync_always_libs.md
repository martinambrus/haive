---
name: dev-stack-sync-always-libs
description: 'After every pull of main onto the dev stack, run `pnpm docker libs`, even when my own PR never touched shared/database; then confirm the worker logged a fresh "haive-worker ready"'
metadata:
  node_type: memory
  type: feedback
  originSessionId: f3f0c544-0081-42eb-b0d8-fc58d423baba
  modified: 2026-10-13T00:27:37.921Z
---

Every dev-stack sync after a `git pull` of main runs `pnpm docker libs`, then waits for a fresh `haive-worker ready` line. That holds whatever my own PR touched.

**Why:** on 2026-10-11 I merged a worker-only PR (#550), pulled, and skipped libs because my change did not touch shared. The pull also brought in another session's merge that added `lockPlanMerge` to `@haive/shared/plan`. tsx restarted on the source change and crashed: `SyntaxError: ... '@haive/shared/plan' does not provide an export named 'lockPlanMerge'`. tsx watch does not restart after a crash, so the worker stayed down until `pnpm docker libs` rebuilt dist, and that dist change triggered a clean restart.

**How to apply:**

1. Pull main.
2. Run `pnpm docker migrate` if a new migration file arrived.
3. Always run `pnpm docker libs`.
4. Take the timestamp BEFORE the pull (`T0=$(date -u +%s)` first). The worker restarts on the pull itself and often reports ready DURING `migrate`/`libs`, and a libs build that changes nothing in dist triggers no second restart. Then wait for a `haive-worker ready` logged after T0, and check that no level-50/60 or `SyntaxError` lines follow. A clock started after libs waits forever (measured 2026-10-11: the 600 s timeout, while the worker had been ready since 11 s after the pull).

5. Also check the **api** (`curl localhost:3001/health`), not only the worker. When a merge adds a NEW shared subpath file (2026-10-13, #632's `@haive/shared/project-state-outbox`), both api and worker reload on the pull, crash with `ERR_MODULE_NOT_FOUND .../dist/<new>.js` before libs builds it, and stay down even after libs (a NEW dist file triggers no restart of a crashed tsx). Fix: `pnpm docker restart api worker` (no running tasks first), then re-check both.

A ready line from before the pull proves nothing. See [[haive-worker-tsx-watch-goes-stale]] and [[haive-libs-build-host-vs-docker]].

A `SyntaxError: ... does not provide an export named X` in the api/worker log right after a pull is this race (the watcher restarts on the new source before `pnpm docker libs` has rebuilt shared); it clears by itself once libs finish — confirm a later "listening"/"ready" line and /health 200 (seen 2026-10-16 with #796's `isCanonicalRepoPath`), never restart for it.
