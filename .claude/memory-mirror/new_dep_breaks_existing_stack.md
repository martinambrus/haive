---
name: new-dep-breaks-existing-stack
description: 'A new dependency in worker/api/web passes CI and then kills the running container on the first pull: their node_modules are named volumes a host install cannot reach. `pnpm docker rebuild` with NO service, never `restart`'
metadata:
  node_type: memory
  type: project
  originSessionId: e62dac9c-0a5b-41ca-8f3f-eaec5bb75d8c
  modified: 2026-09-21T18:05:49.808Z
---

**Adding a dependency to `@haive/worker`, `@haive/api` or `@haive/web` leaves every EXISTING stack
broken until the dependency volumes are recreated, and CI structurally cannot catch it.** Those three
services mask `node_modules` with named volumes, so neither a host install nor a worktree-local one
reaches them; CI always installs clean from the lockfile and therefore always passes.

MEASURED 2026-09-21. `picomatch` was added to `packages/worker/package.json` in the agent-isolation
foundations commit (`c9440b96`, PR #192). It went green through FOUR CI runs and four merges. The
first time the dev stack pulled that code, `pnpm docker restart worker` produced a container that was
`Up 25 seconds` with a dead node process:

```
Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'picomatch' imported from
  /app/packages/worker/src/queues/cli-exec/secret-mask-policy.ts
```

`restart` is NOT enough — it recreates the container against the same volume.
`cd /home/activit/haive && pnpm docker rebuild` (no service argument) is what recreates them; after it
`picomatch` resolved, the worker reached `haive-worker ready`, and zero `ERR_MODULE_NOT_FOUND`
remained. It takes minutes, so expect it to go background past the 120s foreground limit.

**How to apply.** After ANY lockfile change that adds a package to one of those three, the deploy step
on a live stack is `pnpm docker rebuild` with no service — this is what
[[haive-adding-a-dependency]] means by "or you get a broken symlink", stated as the failure it
actually produces. Two checks prove it landed, and the container being "Up" proves neither: resolve
the package inside the container (`docker exec haive-worker node -e
'console.log(require.resolve("picomatch"))'`) and read the boot log for `ready` plus a zero count of
`ERR_MODULE_NOT_FOUND`.

**The wider trap.** A pull alone updates SOURCE, not artefacts. Three separate things go stale
independently and each has its own fix: `node_modules` (volume-masked -> `pnpm docker rebuild`),
`packages/*/dist` for `@haive/shared` / `@haive/database` (-> `pnpm docker libs`, which also chowns
dist back to 1000:1000), and the running process itself. MEASURED the same day: after the pull, the
api's watcher had reloaded and served a NEW route while shared's `dist` still lacked the config key
the route reads — so the route answered rather than 404'ing while being unable to resolve its own
constant. The worker's `tsx watch` did not reload at all; its `src/index.ts` process elapsed read
`4h44`, one minute MORE than before the pull. Always check the process age, never the restart
command's exit code — see [[haive-worker-tsx-watch-goes-stale]].

**And an auth code is not a health check.** `GET /admin/config/agent-isolation` answered `401` both
before and after the artefacts were fixed, because `requireAdmin` rejects the call before the handler
runs. A 404 would have been the failure signal; 401 only proves the route is MOUNTED, never that its
handler can resolve what it reads. Exercise such a route with a real session.
