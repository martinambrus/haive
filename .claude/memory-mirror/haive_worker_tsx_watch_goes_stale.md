---
name: haive-worker-tsx-watch-goes-stale
description: 'haive-worker AND haive-api tsx watchers silently stop reloading the WSL2 bind mount — verify a restart in the logs before testing a source change'
metadata:
  node_type: memory
  type: feedback
  originSessionId: 34272203-2b48-471f-ba4b-237577519e5a
  modified: 2026-09-16T07:48:13.733Z
---

Never conclude a worker source fix "did not work" from a live run without first proving the
container reloaded it. `haive-worker` runs `tsx watch src/index.ts` over the `.:/app` bind
mount, and on WSL2 that watcher stops firing after a burst of writes — MEASURED on
2026-09-05: several `git stash push` / `pop` writes seconds apart produced restarts for some
and none for the last, so the file on disk carried the fix (`grep` inside the container found
it) while the running process still held the reverted module. A later `touch` and two real
content writes produced **no** `[tsx] change ... Restarting...` line at all. A recovery script
re-ran the step and it failed identically — which reads exactly like a bad fix.

Check before drawing any conclusion from a live run:

```bash
docker logs haive-worker --since 5m 2>&1 | grep Restarting   # a line AFTER your last edit
```

Container file content is NOT evidence — the bind mount always shows the host's bytes. Only a
restart line (or a fresh `haive-worker ready`) proves the process re-imported them. When there
is none: inspect active tasks first (`select ... from tasks where status not in
('completed','failed','cancelled')`), then `pnpm docker restart worker`.

**Why:** a stale process turns a correct fix into a false negative, and the natural next move
is to "fix" working code. Recreating the worker mid-task interrupts live CLI terminals and
in-progress steps, which is why the active-task check comes first rather than restarting
reflexively.

**`haive-api` does it too.** Same `tsx watch src/index.ts`, same `.:/app` mount. MEASURED on
2026-09-07: a brand-new `statsRoutes.get('/steps')` answered 404 with no reload line in the
logs, and a deliberate `touch` of the route file produced nothing in 6s. `pnpm docker restart
api` fixed it and the endpoint answered 200 within a second of boot. The api is the SAFE one to
restart — it holds no queue jobs, so only terminal/IDE websockets blip — whereas the worker
needs the active-task check first.

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3001/<new-route>   # 404 = stale
docker logs haive-api --since 5m 2>&1 | grep -i restart
```

**A `git switch` / `git pull` in the main checkout is the same class, and it is the common one
after a merge.** MEASURED on 2026-09-16: the worker missed one branch switch (its node process was
16 min old against an api process of 1 min) and caught the next pull; the api caught two switches
and then missed the pull that carried the very fix being verified, serving the old fold while the
data on disk was right. The process AGE is the direct signal and needs no time window:

```bash
docker exec haive-api ps -o pid,etime,args | grep 'node --require'      # etime older than your pull = stale
docker exec haive-worker ps -o pid,etime,args | grep 'node --require'   # busybox ps: etime, not etimes
```

For the api, `docker restart haive-api` is enough (same container, same dev-override mounts, ~1 s
to boot); the worker still gets the active-task check first.

**How to apply:** after editing anything under `packages/worker/src` or `packages/api/src` and
before running the step / request that exercises it, confirm the restart line. Same reasoning as
[[gh-run-watch-exit-status-lies]] — key on the signal that proves the state, not on the one
that merely looks like it.

**A `git merge --ff-only` sync misses it too.** MEASURED 2026-09-24: the fast-forward to `daf5001c`
restarted the worker (`[tsx] change in ./src/.../_rules-files.ts`), and the one to `681b0ca7` 40
minutes later changed three worker files and produced no restart at all. The process `etime` (26
min) gave it away. After every sync that touches worker or api source, read `etime`; if it predates
the sync, check for active tasks and `pnpm docker restart worker`.

**A sync that ADDS a shared export the worker imports can leave the worker DOWN, not stale.**
MEASURED 2026-10-01 (ff to 8f97f9c3, B1.4a): `dev.sh libs` builds database before shared, so
tsx re-ran on `database/dist/schema/repos.js`, the worker died on `SyntaxError: ... does not
provide an export named 'portableRender'` (shared's dist not built yet), and it never re-ran
when shared's dist landed: only the tsx watcher (pid 20) was left, no `node --require` child.
The api in the same sync recovered on its own. After any sync + libs, check for the child
process, not only its age; with none, the active-task check, then `bash scripts/dev.sh restart
worker` (it was `ready` 6 s later).
