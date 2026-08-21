# Mid-task CLI credential harvest

## Context

The subscription meter vanished on task `c91491f6` with no reconnect prompt. Traced end to end:

1. Task's provider is codex `OpenAI Codex 5.6 High` (`623953b6`); step `00-triage` has no
   step-level CLI pref, so the chip follows `tasks.cli_provider_id`.
2. The usage poller reads the **user** auth volume `haive_cli_auth_0a2cb56857b4_codex_0`.
   Its `auth.json` is from Aug 11; the `access_token` `exp` was `2026-08-21T18:20:03Z`.
3. Expired token to 401 to `AUTH_STRIKE_THRESHOLD` (3) to escalation. `authDenialSeverity`
   returns `silent` for codex (`reconnectable: false`) when the token's own `exp` is in the
   past, so the snapshot is `status='error'`, not `needs_reconnect`.
4. `HeaderUsageChip` (`packages/web/src/app/(app)/tasks/[id]/page.tsx:2222`) draws bars only
   on `ok` and prompts only on `needs_reconnect`/`pending`. `error` renders `null`.
   No meter, no message — exactly the reported symptom.

The credential itself is not lost. The per-task volume `haive_cli_auth_task_c91491f6bf9f_codex_0`
holds an `auth.json` refreshed at 20:57 by the in-task codex CLI. It never reaches the user
volume because `syncRefreshedAuthToUserVolumes` (`packages/worker/src/queues/task-queue.ts:596`)
runs **only at task teardown**, and the task is still `waiting_user`.

So the meter reliably dies on exactly the tasks that run longest, and the next task inherits a
spent single-use refresh token. The comment on `syncRefreshedAuthToUserVolumes` already names
the observed shape ("a user volume 10 days and three in-task refreshes behind") — teardown-only
sync does not prevent it, it only cleans up afterwards.

Outcome wanted: the user volume tracks the newest credential **while** a task is in flight, so
codex/gemini/grok meters stay live and the next task never gets a dead refresh token.

## Approach change from the earlier suggestion

Earlier in this conversation I proposed hooking the sync at **cli-exec invocation end**.
Switching to a **usage-poll-tick harvest**, because:

- Dedupe. Ten codex provider rows share one user volume; per-invocation would re-check per row,
  the tick checks per volume. Realistic cost is 3-5 helper containers per 5-minute tick.
- The concurrent-write hazard disappears. At invocation end a sibling fan-out invocation may
  still be writing `auth.json`; the tick can simply **skip any task with a live invocation**,
  which no per-invocation hook can do for itself.
- It lands beside `refreshExpiringCliCredentials` (`usage-window/credential-refresh.ts`), which
  already runs on this tick, already owns the "yield to running work" rule, and is already the
  singleton that must not race a second rotator over a single-use refresh token.
- It generalises grok's known gap: the grok refresher yields entirely while a task holds a copy,
  so grok's user volume also goes stale mid-task. Harvest is the complement it never had.

Recovery lag is one poll tick (about 5 minutes) against a meter that only updates every 5
minutes anyway.

## Changes

### 1. Extract a reusable per-provider sync — `packages/worker/src/sandbox/task-auth-volume.ts`

Pull the body of the `for (const { providerId } of used)` loop in
`syncRefreshedAuthToUserVolumes` into an exported

```ts
export async function syncProviderAuthBack(
  db: Database,
  taskId: string,
  provider: { id: string; userId: string; name: CliProviderName; authMode: AuthMode; isolateAuth: boolean },
  runner: DockerRunner = defaultDockerRunner,
): Promise<boolean>
```

`syncRefreshedAuthToUserVolumes` keeps its signature and just loops the invocation ledger
calling it. No behaviour change at teardown. Reuses as-is: `CLI_CREDENTIAL_FILES`,
`extractToken`, `readVolumeFile`, `readVolumeFileMtimeMs`, `shouldSyncAuthBack`,
`copyAuthFileBack`.

`copyAuthFileBack` is reused unchanged and matters here: its in-container `-nt` re-check is what
stops a mid-task re-login on the user volume being clobbered by an older task copy — the exact
thing an operator does when they see a dead meter.

### 2. New module — `packages/worker/src/usage-window/credential-harvest.ts`

Pure, unit-testable selection plus a thin docker-side driver, mirroring `credential-refresh.ts`.

```ts
export interface HarvestCandidate {
  taskId: string;
  provider: { id: string; userId: string; name: CliProviderName; authMode: AuthMode; isolateAuth: boolean };
}

/** Candidates safe to harvest this tick, plus the (taskId, cli) pairs skipped as ambiguous. */
export function selectHarvestTargets(
  pairs: readonly HarvestCandidate[],
  busyTaskIds: ReadonlySet<string>,
): { targets: HarvestCandidate[]; ambiguous: { taskId: string; name: CliProviderName }[] }

export async function harvestInTaskCredentials(db: Database, runner?: DockerRunner): Promise<void>
```

Driver steps:

1. One SQL: distinct `(tasks.id, cli_providers.*)` over `cli_invocations` joined to `tasks`,
   where `tasks.status NOT IN (completed, failed, cancelled)`. Filter to providers whose name is
   a key of `CLI_CREDENTIAL_FILES` (codex, gemini, grok).
2. One SQL: task ids with a live invocation, using the canonical predicate
   `started_at IS NOT NULL AND ended_at IS NULL AND superseded_at IS NULL`. These are the tasks
   whose CLI may be writing `auth.json` right now.
3. `selectHarvestTargets` drops busy tasks and drops the ambiguous case below.
4. For each target call `syncProviderAuthBack`. Best-effort: every failure logged and swallowed,
   same contract as the teardown sync and the grok refresher.

**Ambiguity guard.** `cliAuthTaskVolumeName(taskId, providerName, idx)` carries no provider id,
so one task volume backs every row of that CLI in that task. If a task's invocations name two
provider rows of the same CLI that resolve to **different** user volumes (an `isolate_auth` row,
or an `api_key` row alongside a subscription row), we cannot tell whose credential the task
volume holds. Skip that `(task, cli)` pair and log once. Teardown has the same blind spot; this
plan does not change teardown, it only refuses to widen it on the new path.

### 3. Wire-up — `packages/worker/src/queues/usage-poll-queue.ts`

In `startUsagePollWorker`'s processor, call `harvestInTaskCredentials(db)` **first**, in its own
`catch`, ahead of `refreshExpiringCliCredentials`. Ordering matters and gets a comment:

- the grok refresher's yield decision should see the freshest user volume;
- `resolveToken` later in the same tick reads the harvested token, so the meter recovers on this
  tick rather than the next;
- `deadUsageFetchToken` is keyed on the token string, so a harvest lifts the gate by itself.

No new `CONFIG_KEYS` entry. Follows the `refreshExpiringCliCredentials` precedent: this is
credential hygiene, not metering, so it is not gated on `USAGE_WINDOW_ENABLED` and gets no
switch of its own (which also keeps it off the admin-UI surface).

### 4. Tests — `packages/worker/src/usage-window/credential-harvest.test.ts`

Pure-function only, matching `credential-refresh.test.ts` (no docker, no db):

- a task with a live invocation is skipped;
- a task with no live invocation is a target;
- a terminal task never appears (asserted on the input contract);
- two provider rows of one CLI resolving to different user volumes are reported ambiguous, not
  harvested;
- two rows of one CLI sharing a user volume yield targets normally;
- a CLI absent from `CLI_CREDENTIAL_FILES` is never a target.

## Deployment window (required before the first edit)

Worker-src edits reload `tsx`, whose shutdown reaper kills every running CLI sandbox. Right now:
1 live invocation, 1 `haive-cli-*` container, 2 steps at `waiting_cli`. `globalPause` is `false`.

Batch every edit into one window. N edits equals N reloads, and past 3 consecutive orphans a
task dies rather than self-heals.

```
# 0a. PAUSE (never pause the BullMQ queues)
docker exec haive-redis redis-cli SET config:orchestrator:globalPause true

# 0b. DRAIN - poll until BOTH are zero
docker exec haive-postgres psql -U haive -d haive -tAc \
  "select count(*) from cli_invocations
   where started_at is not null and ended_at is null and superseded_at is null;"
docker ps --format '{{.Names}}' | grep -c '^haive-cli-'

# 0c. also confirm no queued-but-unstarted rows are stranded
docker exec haive-postgres psql -U haive -d haive -tAc \
  "select count(*) from cli_invocations where ended_at is null and superseded_at is null;"
```

Edit only after the drain finishes. Leave `globalPause` **on** afterwards; resume only for the
verification below, then re-pause.

## Verification

1. `docker exec haive-worker sh -lc 'cd /app/packages/worker && pnpm typecheck && pnpm vitest run src/usage-window src/sandbox/task-auth-volume.test.ts'`
   (typecheck inside the container — node_modules are per-container).
2. End-to-end, no new task needed. The repro is already staged and survives a worker reload
   (`reapOrphanedTaskAuthVolumes` spares non-terminal tasks):
   - before: `docker run --rm -v haive_cli_auth_0a2cb56857b4_codex_0:/v:ro alpine stat -c %y /v/auth.json`
     shows Aug 11; the task volume `haive_cli_auth_task_c91491f6bf9f_codex_0` shows 20:57.
   - after the worker reloads, wait one poll tick (5 min), then re-stat the user volume — it
     must carry the task copy's timestamp.
   - `select provider_name, status, count(*) from usage_window_snapshots group by 1,2;`
     codex rows flip from `error` to `ok`.
   - reload `/tasks/c91491f6-bf9f-4572-bf58-770b8d67ce35`; the meter is back in the fixed header.
3. Grep the worker log for `synced CLI-refreshed credential back to the user auth volume` with
   the harvest call site, and confirm no `auth sync-back failed` lines.

## Rollback

Revert the commit. No schema change, no migration, no config key, no admin UI. To stop the
behaviour without a full revert, delete the single `harvestInTaskCredentials(db)` call in
`startUsagePollWorker` — the extracted `syncProviderAuthBack` is then only reached by the
teardown path it came from.

The one persistent side effect is a credential file on a user auth volume replaced by a strictly
newer one, gated by `shouldSyncAuthBack` plus the in-container `-nt` re-check. That is the same
write teardown already performs, just earlier, so there is nothing to undo.

## Explicitly out of scope

- The invisible `error` state in the UI. A silent `error` is deliberate for codex/gemini
  (`authDenialSeverity`), and this change removes the cause rather than the symptom. If you also
  want a dim "usage unavailable" chip so the meter never disappears without explanation, that is
  a separate web-only change with no worker restart.
- Teardown's own isolated-row ambiguity in `syncRefreshedAuthToUserVolumes`. Pre-existing;
  flagged, not fixed here.
- Copy this plan to `haive/docs/plans/` on implementation so it outlives the 30-day reap.

# Amendment — 2026-08-21: shipped

Shipped as `56a9cc3`. Do not re-implement from the body above.

Two deviations from the plan as approved:

- `syncProviderAuthBack` takes `(taskId, provider, runner)`, **not** the `(db, taskId, provider,
  runner)` the body shows. The extracted body never touched `db` — only the caller's provider
  lookup did — so the parameter would have been dead weight on every call site.
- The plan's deployment window assumed the drain would reach zero. It could not: the last
  unfinished row was QUEUED (`started_at` NULL), and global pause is exactly what keeps a queued
  row queued. The window was taken anyway on the user's call, accepting the orphan. Outcome was
  better than the plan predicted — the boot reconciler logged `reconciled orphaned waiting_cli
  step` for `de2b313d`/`05-phase-0b5-spec-quality` and re-dispatched it, so the step stayed
  `waiting_cli` with its invocation intact rather than failing. No Retry was needed.

Verification came out as written: `pnpm typecheck` clean, full worker suite 245 files / 3041
passed, prettier clean. One forced poll tick logged `synced CLI-refreshed credential back to the
user auth volume` for task `c91491f6` / codex; the user volume's `auth.json` moved from Aug 11 to
21:17:32 carrying a token valid to `2026-08-31T20:57:58Z`; all ten codex snapshots flipped from
`error` to `ok` in that same tick, including the task's own provider `623953b6`.

Still out of scope, unchanged: the invisible `error` state in the header chip, and teardown's own
isolated-row ambiguity in `syncRefreshedAuthToUserVolumes`.
