# Resource governor: phase-scoped browser weight + measured agent pool

## Context

Two onboarding tasks (pure CLI, no runtime) are running one agent each while five workflow
tasks queue behind them. Measured on the live dev host 2026-08-19:

```
host 15630 MB, 16 cpu -> reserve 4689, runtime budget 10941
3 DDEV holders, each labeled haive.runtime.weight.mb=3072 (ddev 1536 + browser 1536) = 9216 charged
free = 1725 -> floor(1725 / 2048) = 0 fits -> agents = agentFloor = 2
```

Actual occupancy over 10 samples / 90s:

| consumer | charged | measured |
| --- | --- | --- |
| ddev ac58482e | 3072 | 787 MB |
| ddev f51851d6 | 3072 | 553 MB |
| ddev 235a6e4c | 3072 | 1215 MB |
| cli sandbox (n=19) | 2048 each | 293-510 MB, mean 453 |
| MemAvailable | - | 7722-8153 MB, flat |

Two independent accounting errors, each jamming a different queue:

1. The browser surcharge is stamped into the container label at DDEV **create**
   (`resolveRuntimeWeightMb` adds it whenever `declaredDeps.browserTesting` is set), but
   `startBrowserDesktop` first runs at step 07. Verified inside the runners: ac58482e and
   f51851d6 have zero Xvfb/x11vnc/chrome processes (they sit at steps 05 and 03), 235a6e4c has
   four (it is at 08c, post-07). So 3072 MB of the budget is committed to desktops that do not
   exist, which is why `739e48af` (07-phase-2-implement) and `6060686a` (01c-ddev-env) are
   parked at the runtime gate: 9216 + 3072 > 10941.
2. The agent quantum (`agentWeightMb` 2048) is 19% of the whole budget on a 16 GB host, so the
   pool can only take the values 0..5 and currently sits at the floor. It is 4.5x the measured
   mean for this workload. Peak-calibrated (1736 measured at calibration) and correct for a
   fix-round agent; wrong for a skill-generation fan-out.

These sustain each other. Both onboarding tasks carry `vote_score = 1`, which beats
`agentReserveDecision`'s runtime-holder rule (`voteScore > maxHolderVoteScore`), so they take
both slots; the three holders then get no agent, cannot finish, and keep 9216 MB committed,
which keeps the pool at the floor. The vote wins the race and shrinks the prize.

Intended outcome: the runtime pool is charged for what a task is actually holding right now,
and the agent pool is sized from measured host headroom instead of a peak-calibrated constant.

Explicitly rejected: reclaiming a DDEV to feed agents (`reclaimOnePreemptible` tier 3 already
implements the rule and would fire here, since the holders are settled and outscored). The
arithmetic does not pay - 9216 -> 6144 still yields 2 agents; two 5-hour warm environments
must die to reach 3.

Also rejected: lowering `AGENT_WEIGHT_MB` globally. 6 agents at the measured 1736 peak is
10.4 GB, and this host already has 2.1 GB of swap in use (web dev server 1.57 GB + ollama
2.05 GB alone consume 3.6 GB of the 4.7 GB reserve).

Interaction to expect: slice 1 unjams the runtime queue and slice 2 unjams the agent queue, and
they compete for the same freed RAM. A 4th DDEV admitted by slice 1 consumes headroom that
slice 2 would otherwise hand to agents. That is correct - the operator's votes decide who gets
it - but the two slices do not multiply.

## Slice 1: charge the browser surcharge only while the desktop is up

The docker label is immutable after create, so the surcharge moves to a Redis side-channel that
mirrors the existing reservation pattern in `runtime-admission.ts` (`RESERVE_KEY`).

**`packages/worker/src/sandbox/runtime-caps.ts`**

- `resolveRuntimeWeightMb(taskId, kind)` stops adding `caps.browserWeightMb`. A per-task
  `memoryLimitMb` pin still wins outright, unchanged. Drop the now-unused `taskUsesBrowser` /
  `getTaskEnvTemplate` read.

**`packages/worker/src/sandbox/runtime-admission.ts`**

- New `BROWSER_KEY = 'haive:runtime-browser'`, a Redis SET keyed on the RUNNER CONTAINER NAME,
  with `markBrowserDesktopUp(container)` / `markBrowserDesktopDown(container)` /
  `clearBrowserSurcharges()` exported alongside the existing reservation helpers. Container name
  rather than task id because neither `DdevRunnerHandle` nor `AppRunnerHandle` carries a taskId
  (both are `{container, projectDir}`), and `ddevRunnerName(taskId)` / `appRunnerName(taskId)`
  from `@haive/shared` map the other direction - so both ends can produce the key without
  changing `startBrowserDesktop`'s signature at seven call sites.
- `listRunnerWeightsByLabel`'s `--format` gains `{{.Names}}` so the parser can look each runner
  up in that set; `liveRuntimeWeights` then folds the surcharge in per task, clamped so a
  pre-change container (whose label already contains the surcharge) and a pinned task are never
  double-charged:

  ```
  effective = min(labelWeight + (browserUp ? caps.browserWeightMb : 0),
                  Math.max(labelWeight, heaviestWeightMb(caps)))
  ```

  Old 3072 label -> min(4608, 3072) = 3072. New 1536 label with desktop up -> 3072, down -> 1536.
  Pinned 8192 -> min(9728, 8192) = 8192.
- The surcharge only applies to tasks that appear in the live runner map, so a stale set member
  contributes nothing and no TTL or sweep is needed.
- `clearBrowserSurcharges()` is called from the same worker-boot path that calls
  `clearRuntimeReservations()` (the boot reaper removes every runner, so every entry is stale).

**`packages/worker/src/sandbox/ddev-runner.ts` and `app-runner.ts`**

- `startBrowserDesktop` calls `markBrowserDesktopUp(handle.container)` after a successful start;
  `stopBrowserDesktop` calls `markBrowserDesktopDown(<runnerName>(taskId))`, which it already
  computes. These four functions are the only choke points - every caller (07 line 306, 07b 478,
  08a 380/696/861, 09 534, 99-run-app 99, and the single stop site at 09-gate-2 line 933)
  inherits it with no signature change.

Failure directions: a missed mark-down over-charges (conservative, and self-heals when the
runner goes away); a missed mark-up under-charges one runner by 1536 MB, which the slice-2
measured term then absorbs.

Rollback: re-add `+ browserWeightMb` in `resolveRuntimeWeightMb` and stop reading the set. The
Redis key is soft state; `DEL haive:runtime-browser` is safe at any time. No schema change.

## Slice 2: size the agent pool from measured headroom

The planned term stays as the fallback. The measured term becomes the RAM authority when it is
available, because live runner RSS is already reflected in `MemAvailable`.

**`packages/shared/src/utils/host-resources.ts`**

- New impure `readHostAvailableMb(): number | null` - parses `MemAvailable` from
  `/proc/meminfo`. If a cgroup memory limit is present (`/sys/fs/cgroup/memory.max`, or v1
  `memory.limit_in_bytes`) and lower than host total, use `limit - memory.current` instead:
  `/proc/meminfo` reports the host even inside a capped container. Returns null on any parse
  failure, which makes the whole measured path a no-op. Do not use `os.freemem()` - it is
  MemFree (750 MB here against 7.9 GB available) and would zero the term.
- `deriveAgentConcurrency` gains an optional `measured` argument and stays pure:

  ```
  measured?: {
    availableMb: number      // readHostAvailableMb()
    pendingRuntimeMb: number // reservations + in-flight boots, NOT live runners
    liveAgents: number       // running cli sandboxes
    safetyMb: number
    rampStep: number
  }
  ```

  ```
  plannedFits = floor((budget - liveRuntimeWeightMb) / agentWeightMb)
  base        = min(cpu, max(agentFloor, plannedFits))          // today's value
  if (!measured) return base
  headroomMb  = max(0, availableMb - safetyMb - pendingRuntimeMb)
  target      = min(cpu, max(agentFloor, liveAgents + floor(headroomMb / agentWeightMb)))
  return max(agentFloor, min(target, liveAgents + rampStep))
  ```

  `agentWeightMb` stays the divisor: peak-safe, and it already gets 2 -> 4 on this host without
  any RSS sampling. The ramp is what makes growth safe - each 30s poll re-measures with the
  previously added agent resident, so growth stops itself when the headroom was illusory.
  Live runner weight is deliberately not subtracted twice; it is in `MemAvailable` already,
  while a reservation is not.

**`packages/worker/src/sandbox/runtime-admission.ts`**

- Split `runtimeOccupancy` so the caller can see live vs reserved separately (today it merges
  them); `pendingRuntimeMb = sumWeights(reserved) + inFlight.weightMb`.
- `liveAgents` = `listRunningIdsByLabels(['haive.invocation.id']).length`. That label is stamped
  on every cli sandbox (`sandbox-runner.ts` line ~310) and on nothing else, so it counts exactly
  the agent containers, including sub-agent sandboxes spawned inside one job.
- `resolveAgentConcurrency` passes the measured block when
  `CONFIG_KEYS.AGENT_POOL_MEASURED_ENABLED` is on and `readHostAvailableMb()` is non-null. A
  positive `MAX_PARALLEL_AGENTS` still short-circuits first, unchanged.

The ramp must live here, not in `handlers.ts`: `step-engine/_parallel-cap.ts`
(`resolveParallelCap`) calls the same function for in-process fan-outs that spawn sandboxes
directly, bypassing BullMQ concurrency. Anchoring on the live sandbox count gives both consumers
the ramped value.

**Config (`packages/shared/src/config/config.service.ts`)**

- `AGENT_POOL_MEASURED_ENABLED` -> `config:sandbox:agentPoolMeasuredEnabled`, default `'true'`
  (matching AGENT_RESERVE_ENABLED / RUNTIME_PREEMPTION_ENABLED, which also default on with a
  switch). Off = byte-for-byte today's behavior.
- `AGENT_POOL_SAFETY_MB` -> `config:sandbox:agentPoolSafetyMb`, default `'0'` = auto
  (`clamp(20% of host, 2048, 4096)`).

**Admin surface** (every global switch needs one)

- `packages/api/src/routes/admin.ts`: both keys into the `GET`/`PUT /config/runtime-limits`
  arrays, `runtimeLimitsSchema`, and the `CONFIG_RUNTIME_LIMITS_CHANNEL` publish that already
  retunes the pool live. Add one `agentsMeasured` field to `deriveCapacityPreview` so the
  operator can see what the controller is targeting.
- `packages/web/src/app/(app)/admin/page.tsx`: two fields on the existing runtime-limits card,
  following `agentFloor` / `agentWeightMb`.

Rollback: flip `AGENT_POOL_MEASURED_ENABLED` off - the measured branch is skipped and
`deriveAgentConcurrency` returns exactly what it returns today. No schema change.

## Verification

Unit:

- `packages/shared/src/utils/host-resources.test.ts` - extend `deriveAgentConcurrency`: no
  `measured` returns the existing values (the four current cases must stay green); measured
  headroom lifts above the planned fit; the ramp caps growth at `liveAgents + rampStep`; the
  floor still holds when `availableMb <= safetyMb`; `pendingRuntimeMb` suppresses the lift.
- `packages/worker/src/sandbox/runtime-admission.test.ts` - the clamp in `liveRuntimeWeights`:
  legacy 3072 label + browser up stays 3072, new 1536 label toggles 1536 <-> 3072, pinned label
  is untouched.

Live, on the dev stack:

1. `docker ps --format '{{.Names}} {{.Label "haive.runtime.weight.mb"}}'` - a DDEV created after
   the change is labeled 1536, not 3072.
2. `docker exec haive-ddev-<id> sh -c "ps -eo comm= | grep -cE 'Xvfb|x11vnc|chrome'"` against the
   admission arithmetic in the worker log - occupancy must track the process count.
3. Worker log `cli-exec concurrency retuned` should step 2 -> 3 -> 4 across successive 30s polls,
   not jump.
4. `739e48af` (parked at 07-phase-2-implement, position 1) should boot its runner once slice 1
   lands.
5. Watch `free -m` swap used across the ramp; if it climbs, raise `AGENT_POOL_SAFETY_MB`.

Ordering and operational constraints:

- Slice 2 changes a `@haive/shared` export. Run `scripts/dev.sh libs` BEFORE saving the worker
  and api importers, or the live stack crash-loops on the missing export.
- Any worker src edit triggers a tsx reload that kills in-flight CLI runs. Land both slices while
  the onboarding tasks sit at a form/gate, not mid-fan-out.
- No DB migration, no schema change, no new container image in either slice.

---

# Amendment — 2026-08-21: shipped

Landed as `8130dcd + d65d83f` (`feat(runtime): size the agent pool from measured host memory` and `fix(runtime): charge the browser surcharge only while the desktop is up`). This file is a historical record, not pending work — do not
re-implement from it. Line numbers in the body are as of writing and have since drifted; resolve
any reference by symbol name.
