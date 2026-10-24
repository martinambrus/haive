---
name: haive-host-build-restarts-worker
description: 'Anything that writes under packages/worker/src or packages/*/dist restarts haive-worker and orphans in-flight jobs — EDITING a worker source file is enough, and no command form avoids it; do not touch worker source while a task is running'
metadata:
  node_type: memory
  type: feedback
  originSessionId: fffc4845-ee75-4862-861e-80bb17812ffa
  modified: 2026-09-19T21:34:41.461Z
---

`pnpm test`, `pnpm typecheck` and `pnpm build` all rewrite `packages/shared/dist` and
`packages/database/dist` (turbo's `test`/`typecheck` both declare `dependsOn: ["^build"]`).
Those dirs are on the `.:/app` bind mount that `haive-worker`'s `tsx watch` watches, so **every
one of those commands restarts the worker** — MEASURED 2026-09-06: 65 distinct worker PIDs in
90 minutes, roughly one every 83 seconds, from ~12 of my own commands.

A restart mid-job does not just interrupt it. BullMQ leaves that job in `active` holding its
lock, and cli-exec sets `lockDuration: 30 * 60 * 1000` deliberately (`handlers.ts`, so a long
step survives a restart without redelivery). The orphan then occupies an agent slot for the
full half hour. On a 16 GB host the measured agent pool is **2**, so two orphans stall the
queue completely: every real invocation logs `"agent pool full; deferring invocation"` every
30s while `docker ps` shows no agent container at all, and the UI reads "waiting for slot"
with nothing in progress.

**EDITING A WORKER SOURCE FILE IS ENOUGH — there is no safe command form for this one.**
`tsx watch src/index.ts` watches `src/`, not only `dist/`, so a single Edit/Write under
`packages/worker/src/` restarts the worker the instant it lands. MEASURED 2026-09-07 on task
681f0f99: one edit to `08b-test-management.ts` logged
`[tsx] change in ./src/step-engine/steps/workflow/08b-test-management.ts Restarting...`,
orphaned the running cli invocation, and two further edits orphaned the re-dispatched ones
until the step FAILED with "CLI invocation orphaned by a worker restart" — killing a test run
that was ~9 minutes into its 10-minute budget and destroying the evidence it was about to
produce. `git commit` counts too — but ONLY when prettier actually reformats something.
lint-staged runs `prettier --write` on staged files, and MEASURED 2026-09-07 on a copy of
`step-runner.ts` with a back-dated mtime: an already-formatted file prints "All files formatted
correctly" and is NOT rewritten, mtime unchanged, so the watcher never fires. Confirmed live on
the same day — a commit of two worker source files landed while task 4ff3dab8 was mid-step and
the worker pid stayed 100490 across it. So when a task is running and you must commit, run
`pnpm exec prettier --check <staged files>` first; if it passes, the commit is safe.

So the rule is about the TASK, not the command: **while a task is running, do not write to
`packages/worker/src/` at all** — not the fix, not a test file, not a commit that touches one.
Finish reading and planning, wait for the task to park or finish, then edit.

**A git worktree is the escape hatch, and it works even under the bind mount.** `tsx watch`
watches the MODULE GRAPH — the individual files the running process actually imported — not a
directory tree, so a second checkout's files are simply not in it. MEASURED 2026-09-10 by
resolving the watcher's own inotify inodes (`grep '^inotify' /proc/<tsx-pid>/fdinfo/<fd>`,
1258 watches) against `stat -c %i`: `packages/worker/src/index.ts`, `queues/task-queue.ts`,
`packages/shared/dist/index.js` and `packages/database/dist/index.js` are all WATCHED, while
`packages/worker/package.json`, `AGENTS.md`, `benchmarks/README.md` and
`packages/web/src/app/globals.css` are NOT. So a worktree at `.claude/worktrees/<name>/`
(inside `.:/app`, visible to the containers) is safe for everything: edits, `pnpm install`,
`pnpm --filter @haive/shared build`, the full `pnpm test`, and commits with prettier.
Confirmed the same day — two features built, three commits and a full 4109-test run in a
worktree while task ef954a3d ran, with ZERO `[tsx]` restart lines in `docker logs` over 60
minutes and the task advancing normally through two rounds.

**MERGING a branch that touched `packages/shared/src` now HARD-FAILS the worker boot until you
rebuild libs.** `dist/` is gitignored (`.gitignore:6`), so a merge lands new `shared/src` and new
`worker/src` while `shared/dist` still holds the OLD compiled constants — and `registerAllSteps`
asserts three shared step-id lists against the registry at boot (`steps/index.ts`:
`assertProviderSensitiveListInSync`, `assertCliDispatchListInSync`, `assertSkippableListInSync`).
MEASURED 2026-09-10 merging main into test/e2e-rework: tsx restarted on the merge, the child died
with `worker bootstrap failed — SKIPPABLE_STEP_IDS out of sync ... missing in shared:
[07c-ddev-reconcile, 08b-test-management]`, and `pnpm --filter @haive/shared build` brought it
back (~20s down). The window is unavoidable — `shared/src` only exists after the merge, so the
watcher always beats the rebuild — so treat `git merge` + `pnpm --filter @haive/shared build` as
ONE operation and do it only when no task is mid-CLI. The API hits the same window: MEASURED
2026-09-19 syncing main past PR #176, `haive-api` logged `SyntaxError: The requested module
'@haive/shared' does not provide an export named 'bundleAgentTemplateHash'` at 18:25:16 and was
listening again at 18:25:22 once the rebuild landed. So one such line straddling a sync is this
window, not a broken merge; check that it stops after the rebuild before reading it as one. The loud failure is the feature: before
those assertions the worker would have booted with a wrong list and silently rendered no Skip
button.

**`gh pr merge --delete-branch` WRITES THE WORKING TREE — it is not a remote-only call.**
When the branch being merged is the one checked out, gh cannot delete it without moving off
it, so it runs a local `git checkout <default>` first. That lands every file that differs and
the watcher fires. MEASURED 2026-09-12: merging PR #93 while two 08 runs were mid-CLI logged
`[tsx] unlink in ./src/step-engine/steps/onboarding/_kb-write.ts Restarting...`, reaped 2
sandbox containers, and orphaned both invocations — ~22 and ~27 minutes of agent work thrown
away, on a call that had just been described as safe to run during live tasks.

The recovery is automatic and worth knowing: the worker reconciles on boot
(`reconciling waiting_cli steps orphaned by worker restart`) and RE-DISPATCHES a fresh
invocation per orphaned step, so nothing needs unsticking — the cost is purely the wasted run.

While a task is mid-CLI, merge WITHOUT touching the checkout:

```bash
gh pr merge <N> --merge            # no --delete-branch
git push origin --delete <branch>  # tidy the remote later, or let the PR page do it
```

`--delete-branch` is only safe when the local checkout is on some OTHER branch, which is also
the cheap fix: `git checkout main` BEFORE the merge (paying the restart once, deliberately,
when nothing is running) rather than having gh do it at a moment of its choosing.

**Syncing main after the merge can write NOTHING — prefer that to paying the restart.**
`git checkout main && git pull` writes twice (back to the pre-merge main, then forward again),
and each write fires the watcher. When the PR branch was up to date with main, the merge
commit's TREE equals the branch head's, so move main by REF and switch onto it:

```bash
git diff --stat HEAD origin/main   # after `git fetch`: must print nothing
git fetch origin main:main         # ff-only (no leading '+'); run FROM the feature branch
git switch main                    # identical trees: no tracked file is rewritten
```

MEASURED 2026-09-19 after PR #173: empty diff, zero `Worker bootstrap complete` lines in the
20 minutes after the switch, and uncommitted files elsewhere in the tree carried across
untouched. If main moved on in between, the switch writes the differing files — one write
instead of two, but still a write, so a non-empty diff is a worker-source write like any other.

**A fresh worktree has NO `node_modules`, and the way you supply them is a trap.** The
existing worktrees symlink them from the main checkout (`ln -sfn /home/activit/haive/node_modules
<wt>/node_modules`, and one per package). Two things then bite, MEASURED 2026-09-11:

- `.gitignore` says `node_modules/` WITH a trailing slash, which does not match a SYMLINK of
  that name — so `git add -A packages/worker` tracked `packages/worker/node_modules` as a file.
  Merging that branch into the main checkout made git try to replace the REAL directory with a
  symlink; it deleted entries until it hit a root-owned one, failed `Permission denied`, and
  left `bullmq`/`ioredis` gone. Host `tsc` then reported ~20 TS2307s that look like a broken
  install because they ARE one. Stage explicit paths in a worktree, or add
  `/packages/*/node_modules` to `.git/info/exclude` (shared across worktrees, never committed).
- `ln -sfn target link` puts the symlink INSIDE `link` when `link` already exists as a real
  directory — a stray `.vite/` from one vitest run is enough. Check with `ls -ld`.

**Repairing a damaged host `node_modules` is not `pnpm docker rebuild` on this host.** That
rebuilds the IMAGES, and the Dockerfile's `# syntax=docker/dockerfile:1.7` frontend needs
registry-1.docker.io, which does not resolve here — it fails AFTER stopping api/worker/web, so
the stack goes down for a repair that never ran. Recover with `bash scripts/dev.sh up --no-build`
(dev.sh forwards extra args to `dc up -d`, so local images are reused). The actual repair is:
`sudo chown -R activit:activit node_modules packages/*/node_modules .husky` (the `db-migrate`
one-shot installs as root, so root-owned dirs are normal here and are what blocks both git and
pnpm), then `CI=true pnpm install --frozen-lockfile --config.confirmModulesPurge=false` — pnpm
refuses to purge a modules dir with no TTY otherwise. `.husky/_/h` is root-owned too and fails
the `prepare` hook separately. Containers are unaffected throughout: api/worker/web mask
`node_modules` with named volumes, so this damage is host-only and the stack keeps serving.

Build ORDER in a fresh worktree: `@haive/database` FIRST, then `@haive/shared` — shared
imports `@haive/database` types, so the reverse fails with ~14 TS2307s that look like a broken
install. And to run something against the live stack from a worktree, exec into the container
at the worktree path (`docker exec -w /app/.claude/worktrees/<name>/packages/worker
haive-worker ../../node_modules/.bin/tsx script.ts`) — the repo root has no `"type": "module"`,
so tsx transforms as CJS there and rejects top-level await.

While any task is running, prefer the commands that do NOT touch `dist`:

```bash
pnpm --filter @haive/worker exec vitest run [path]   # not `pnpm test`
pnpm --filter @haive/worker exec tsc --noEmit        # not `pnpm typecheck`
```

`pnpm --filter @haive/shared build` is the one that genuinely must write dist — run it only
when shared/database actually changed, and expect the restart.

To clear orphans already stuck (their rows are `ended_at`/`superseded_at`, and
`handleCliExecJob`'s redelivery guard skips them on reclaim, so this burns no CLI calls):

```bash
docker exec haive-redis redis-cli DEL bull:haive-cli-exec:<jobId>:lock
```

**Why:** the symptom points away from the cause — it looks like a capacity or scheduling bug,
and the tasks recover on their own after 30 minutes, so it is easy to "fix" the wrong thing.
Confirm with `docker ps` (no agent container) plus `select count(*) from cli_invocations where
started_at is not null and ended_at is null and superseded_at is null` returning 0. The
`superseded_at` clause is not optional: a superseded run never gets `ended_at` stamped, and every
product reader of "live" filters on it — MEASURED 2026-09-13, without it 5 superseded rows from a
task completed on 2026-09-05 read as 5 live runs while nothing was running.

**How to apply:** before running a build-shaped command, check whether a task is mid-run; if so
use the direct vitest/tsc forms. Complements [[haive-worker-tsx-watch-goes-stale]], which is the
opposite failure — the watcher NOT firing when you need it to.
