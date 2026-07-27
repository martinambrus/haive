import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { eq } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import { APP_RUNNER_LABEL, CONFIG_KEYS, configService, logger } from '@haive/shared';
import { hasLiveCliInvocation } from '../orchestrator/pause.js';

const exec = promisify(execFile);
const log = logger.child({ module: 'runtime-runner-reaper' });

/** Sweep interval. A leaked runner is reclaimed at most this long after it becomes
 *  eligible (its task reaching a terminal state, or the failed-grace elapsing). */
const DEFAULT_SWEEP_INTERVAL_MS = 60_000;

/** Task statuses at which a runtime runner serves no one and is safe to reap. `failed`
 *  is handled separately (kept for retry until the grace elapses). */
const TERMINAL_STATUSES = new Set(['completed', 'cancelled']);

/** Task statuses whose runtime runner a WAITING live task may PREEMPT when the admission gate
 *  is full: the task is no longer actively using its runtime. Unlike the periodic sweep this
 *  includes `failed` WITHOUT waiting out the grace — preemption is demand-driven (a live task
 *  needs the slot now); the grace only governs the unattended background reap. Whitelist: any
 *  status not listed (running, paused, waiting_x, queued, pending, unknown) is never
 *  preempted. */
const PREEMPTIBLE_TASK_STATUSES = new Set(['failed', 'completed', 'cancelled']);

export type ReapReason = 'exited' | 'orphan' | 'terminal' | 'failed-grace' | 'paused-grace';

/** A task as the reap/preempt rules see it.
 *
 *  `pausedAt` and `settled` describe a PAUSED task: the user is holding it, so its runner is
 *  serving nobody, but pause deliberately lets the CLI run in flight finish and that run may be
 *  driving this very container. `settled` (no live CLI invocation) is what separates "held and
 *  idle" from "held but still finishing" — it is supplied by the caller because it needs a query
 *  these pure functions must not make. Callers that cannot determine it pass false, which keeps
 *  the runner. A task with a NULL pausedAt ignores both fields entirely. */
export interface ReaperTask {
  status: string;
  completedAt: Date | null;
  pausedAt?: Date | null;
  settled?: boolean;
}

/** Pure reap decision, split out from the DB lookup so the rules are directly testable.
 *  Returns why this runner should be reaped, or null to keep it. */
export function reapDecision(
  c: { running: boolean; taskId: string | null; startedAtMs: number | null },
  task: ReaperTask | undefined,
  failedGraceMs: number,
  nowMs: number = Date.now(),
): ReapReason | null {
  // An exited/created (non-running) runner serves nothing — reclaim it and its anon
  // volume regardless of task status (a retry cold-boots a fresh one).
  if (!c.running) return 'exited';
  // A running runner with no task label can't belong to a live task's runtime.
  if (!c.taskId) return 'orphan';
  if (!task) return 'orphan'; // task row gone — the runner is a leftover
  if (TERMINAL_STATUSES.has(task.status)) return 'terminal';
  if (task.status === 'failed') {
    if (failedGraceMs <= 0) return null; // grace disabled — keep for manual retry
    // Anchor the grace to WHEN THE TASK FAILED, not to the container's start time. A
    // runner (re)booted for an already-failed task — a UI visit, a stray runtime-ensure —
    // would otherwise re-arm a FULL grace on every boot and let a long-dead task squat a
    // scarce runtime slot indefinitely (observed: a task failed at 14:56 held a slot to
    // 21:07 because its runner was rebooted at 18:07). Fall back to the container start
    // only when the failure time is unknown.
    const failedAtMs = task.completedAt?.getTime() ?? c.startedAtMs;
    if (failedAtMs != null && nowMs - failedAtMs >= failedGraceMs) return 'failed-grace';
    return null;
  }
  // A task the user PAUSED keeps its real status (running / waiting_user / …), so it lands here
  // rather than in any of the branches above. Its runner serves nobody for as long as the hold
  // lasts, and three paused DDEV tasks holding every slot is exactly the deadlock Pause exists
  // to avoid — so reclaim it on the same grace the `failed` path uses. Anchored to paused_at,
  // never to the container start: anchoring the failed path to the container is what once let a
  // long-dead task re-arm a full grace on every stray (re)boot and squat a slot for hours.
  // `settled` is required — a hold whose final CLI run is still going may be driving this very
  // container.
  if (task.pausedAt && task.settled) {
    if (failedGraceMs <= 0) return null; // grace disabled — keep for an immediate resume
    if (nowMs - task.pausedAt.getTime() >= failedGraceMs) return 'paused-grace';
    return null;
  }
  // running / waiting_* / created / queued — in use, keep.
  return null;
}

export interface RunnerContainer {
  id: string;
  taskId: string | null;
  running: boolean;
  startedAtMs: number | null;
}

/** Pure pick of ONE runtime runner a waiting live task may preempt, or null. Split from the
 *  DB/docker I/O so the rules are directly testable (mirrors `reapDecision`). Only RUNNING
 *  containers are considered: the admission gate counts running runners (`docker ps -q`), so
 *  an exited/`created` one holds no slot — and requiring `running` also avoids reaping a
 *  runner another waiter is mid-cold-boot into (it appears briefly as `created`).
 *
 *  TWO TIERS, and the order between them is the whole design:
 *
 *   1. DEAD runners — no task label / task row gone (orphan), or failed/completed/cancelled.
 *      Reclaiming one costs nothing because nobody will ever use it again. Longest-dead first
 *      (oldest `completedAt`; orphan/unknown sorts oldest).
 *   2. PAUSED-and-settled runners, consulted ONLY when tier 1 is empty. A held task's runner is
 *      still a real environment the user may come back to, so tearing it down is a genuine cost
 *      — but a live task needing a slot outranks a held one, and three paused DDEV tasks holding
 *      every slot is precisely the deadlock Pause exists to prevent. Longest-paused first.
 *
 *  Tiering is what keeps this backward compatible: with nothing paused, tier 2 is always empty
 *  and the result is identical to the pre-pause behaviour.
 *
 *  `settled` gates tier 2 — pause lets the CLI run in flight finish, and that run may be driving
 *  this very container, so a task still holding a live invocation is never a candidate. */
export function pickPreemptibleRunner(
  runners: RunnerContainer[],
  taskById: Map<string, ReaperTask>,
): RunnerContainer | null {
  const running = runners.filter((c) => c.running); // an exited runner holds no gate slot
  const dead = running.filter((c) => {
    if (!c.taskId) return true; // orphan runner — nobody owns it
    const task = taskById.get(c.taskId);
    if (!task) return true; // task row gone — leftover
    return PREEMPTIBLE_TASK_STATUSES.has(task.status);
  });
  if (dead.length > 0) {
    const deadAtMs = (c: RunnerContainer): number =>
      (c.taskId ? taskById.get(c.taskId) : undefined)?.completedAt?.getTime() ?? 0;
    return dead.reduce((best, c) => (deadAtMs(c) < deadAtMs(best) ? c : best));
  }
  const paused = running.filter((c) => {
    if (!c.taskId) return false; // already covered by tier 1
    const task = taskById.get(c.taskId);
    return Boolean(task?.pausedAt && task.settled);
  });
  if (paused.length === 0) return null;
  const pausedAtMs = (c: RunnerContainer): number =>
    (c.taskId ? taskById.get(c.taskId) : undefined)?.pausedAt?.getTime() ?? 0;
  return paused.reduce((best, c) => (pausedAtMs(c) < pausedAtMs(best) ? c : best));
}

export interface RuntimeRunnerReaperOptions {
  db: Database;
  intervalMs?: number;
}

/** Periodic sweep that reclaims leaked per-task DDEV/app runtime runners. A task that
 *  ends in `failed` deliberately keeps its runner alive for retry, and the worker-boot
 *  reaper preserves runners — so a runner whose task was abandoned (never retried /
 *  resumed / cancelled), or whose worker crashed, otherwise lives forever (a live
 *  dockerd + Chromium + a 1-2 GB anon volume). No runner-activity timestamp exists in
 *  the system, so this keys on task STATUS + container age, never on "is anyone watching
 *  the VNC": it reaps runners whose task is completed/cancelled/missing, whose container
 *  has exited, whose task has been `failed` longer than the grace, or whose task has been
 *  PAUSED (and has no CLI run still finishing) longer than that same grace — and never
 *  touches an actively running/waiting task's runner. Task-end cleanup still owns the normal
 *  path; this is the backstop for the leak.
 */
export class RuntimeRunnerReaper {
  private readonly db: Database;
  private readonly intervalMs: number;
  private timer: NodeJS.Timeout | null = null;
  private inFlight = false;

  constructor(opts: RuntimeRunnerReaperOptions) {
    this.db = opts.db;
    this.intervalMs = opts.intervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.inFlight) return;
      this.inFlight = true;
      this.sweep()
        .catch((err) => log.warn({ err }, 'runtime runner reaper sweep failed'))
        .finally(() => {
          this.inFlight = false;
        });
    }, this.intervalMs);
    if (this.timer.unref) this.timer.unref();
    log.info({ intervalMs: this.intervalMs }, 'runtime runner reaper started');
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /** Single sweep pass. Exposed for tests so they can drive it deterministically. */
  async sweep(): Promise<{ scanned: number; reaped: number }> {
    const containers = await this.listRunnerContainers();
    const failedGraceMs = await this.failedGraceMs();
    let reaped = 0;
    for (const c of containers) {
      const reason = await this.reapReason(c, failedGraceMs).catch((err) => {
        log.warn({ err, id: c.id }, 'runtime reap decision failed');
        return null;
      });
      if (!reason) continue;
      await this.reap(c.id);
      log.info({ id: c.id, taskId: c.taskId, reason }, 'reaped leaked runtime runner');
      reaped += 1;
    }
    return { scanned: containers.length, reaped };
  }

  /** Reclaim ONE runtime runner for a WAITING live task by preempting a task no longer using
   *  its runtime (failed/completed/cancelled/orphan), or — only when there is no such runner —
   *  one held by a settled PAUSE. Wired into the admission gate: called when the gate is full,
   *  it frees a slot so a live task isn't starved behind a dead task's grace-runner or behind
   *  tasks the user deliberately put on hold. Preempts WITHOUT either grace: a live task's
   *  demand outranks a dead task's retry-cache and a held task's warm environment. Returns true
   *  iff it reaped a runner. */
  async reclaimOnePreemptible(): Promise<boolean> {
    const containers = await this.listRunnerContainers();
    const taskById = new Map<string, ReaperTask>();
    for (const c of containers) {
      if (!c.running || !c.taskId || taskById.has(c.taskId)) continue;
      try {
        const t = await this.db.query.tasks.findFirst({
          where: eq(schema.tasks.id, c.taskId),
          columns: { status: true, completedAt: true, pausedAt: true },
        });
        // `settled` only decides tier 2, so the extra query runs for paused tasks only rather
        // than for every runner on every gate miss.
        if (t) {
          taskById.set(c.taskId, {
            ...t,
            settled: t.pausedAt ? !(await hasLiveCliInvocation(this.db, c.taskId)) : false,
          });
        }
      } catch (err) {
        // A DB hiccup on one lookup just leaves that runner out of the candidate set
        // (fail-safe: an un-looked-up runner is never preempted).
        log.warn({ err, taskId: c.taskId }, 'preemption task lookup failed; skipping runner');
      }
    }
    const pick = pickPreemptibleRunner(containers, taskById);
    if (!pick) return false;
    // Re-verify immediately before reaping: a `failed` task may have been retried, or a paused
    // one resumed, in the gap since we listed (list->reap TOCTOU). Only reap if the task is
    // still preemptible. An orphan (task row gone) stays reapable — findFirst returns undefined,
    // we fall through.
    if (pick.taskId) {
      try {
        const t = await this.db.query.tasks.findFirst({
          where: eq(schema.tasks.id, pick.taskId),
          columns: { status: true, pausedAt: true },
        });
        // Still a valid target if it is either dead OR still held. Checking only the status
        // would veto every tier-2 pick, since a paused task's status is `running`.
        if (t && !PREEMPTIBLE_TASK_STATUSES.has(t.status) && !t.pausedAt) return false;
      } catch (err) {
        log.warn({ err, taskId: pick.taskId }, 'preemption re-check failed; not reaping');
        return false;
      }
    }
    await this.reap(pick.id);
    // Confirm the reap actually removed the container. `reap` swallows a failed `docker rm`,
    // so without this a persistent rm failure would report success — and the gate's pump
    // re-picks the same runner on its `continue`, spinning forever. If it's still there, park.
    if (await this.inspect(pick.id)) {
      log.warn({ id: pick.id }, 'preemption reap did not remove the runner; not retrying it');
      return false;
    }
    log.info({ id: pick.id, taskId: pick.taskId }, 'preempted runtime runner for a waiting task');
    return true;
  }

  /** Grace (ms) before a `failed` task's runner is reclaimed; 0 disables that path. */
  private async failedGraceMs(): Promise<number> {
    try {
      const minutes = await configService.getNumber(CONFIG_KEYS.RUNTIME_IDLE_REAP_MINUTES, 180);
      return Math.max(0, minutes) * 60_000;
    } catch {
      return 180 * 60_000;
    }
  }

  /** Why this runner should be reaped, or null to keep it. Fail-safe: a DB error keeps
   *  the runner (null) rather than risk reaping a live task's runtime. */
  private async reapReason(c: RunnerContainer, failedGraceMs: number): Promise<ReapReason | null> {
    // Short-circuit before the DB round-trip for the container-only verdicts.
    if (!c.running || !c.taskId) return reapDecision(c, undefined, failedGraceMs);
    let task: ReaperTask | undefined;
    try {
      const row = await this.db.query.tasks.findFirst({
        where: eq(schema.tasks.id, c.taskId),
        columns: { status: true, completedAt: true, pausedAt: true },
      });
      // Only a paused task can reach the settled test, so the extra query stays off the hot
      // path of an ordinary sweep.
      task = row
        ? {
            ...row,
            settled: row.pausedAt ? !(await hasLiveCliInvocation(this.db, c.taskId)) : false,
          }
        : undefined;
    } catch (err) {
      log.warn({ err, taskId: c.taskId }, 'runtime reaper task lookup failed; keeping runner');
      return null; // fail-safe: never reap a live task's runtime on a DB hiccup
    }
    return reapDecision(c, task, failedGraceMs);
  }

  private async listRunnerContainers(): Promise<RunnerContainer[]> {
    const [ddev, app] = await Promise.all([this.psIds('haive.ddev'), this.psIds(APP_RUNNER_LABEL)]);
    const ids = Array.from(new Set([...ddev, ...app]));
    const infos = await Promise.all(ids.map((id) => this.inspect(id)));
    return infos.filter((i): i is RunnerContainer => i !== null);
  }

  private psIds(label: string): Promise<string[]> {
    return exec('docker', ['ps', '-aq', '--filter', `label=${label}`], { timeout: 10_000 })
      .then(({ stdout }) => stdout.split(/\s+/).filter((s) => s.length > 0))
      .catch(() => []);
  }

  private async inspect(id: string): Promise<RunnerContainer | null> {
    try {
      const { stdout } = await exec(
        'docker',
        [
          'inspect',
          '-f',
          '{{.State.Running}}|{{.State.StartedAt}}|{{index .Config.Labels "haive.task.id"}}',
          id,
        ],
        { timeout: 8_000 },
      );
      const [running, startedAt, taskId] = stdout.trim().split('|');
      const ms = Date.parse(startedAt ?? '');
      return {
        id,
        running: running === 'true',
        startedAtMs: Number.isNaN(ms) ? null : ms,
        taskId: taskId && taskId !== '<no value>' ? taskId : null,
      };
    } catch {
      return null;
    }
  }

  private async reap(id: string): Promise<void> {
    // -v drops the runner's anon /var/lib/docker volume (1-2 GB of nested DDEV images).
    await exec('docker', ['rm', '-f', '-v', id], { timeout: 60_000 }).catch((err) => {
      log.warn(
        { id, err: err instanceof Error ? err.message : String(err) },
        'runtime reap rm failed',
      );
    });
  }
}
