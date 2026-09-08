import { and, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { schema } from '@haive/database';
import { getDb } from '../db.js';
import { killTaskSandboxes } from './sandbox-kill.js';

/** Who initiated a stop. The owner sees the resulting message on their own task page, so this is
 *  not cosmetic — see the `by` local below. */
export type StopActor = 'user' | 'admin';

/** Force-stop a task's current activity so it leaves the running state. Marks
 *  every still-live cli-exec invocation superseded+ended (exit 137) AND fails
 *  whatever step is stuck in running/waiting_cli — including a frozen
 *  DETERMINISTIC step with no invocation at all (e.g. one orphaned by a worker
 *  restart), which has nothing in cli_invocations to cancel and would otherwise
 *  be un-stoppable. Supersede + step writes are committed BEFORE the cli
 *  sandboxes are killed, so the dying cli-exec job's `resumeStepIfLinked` is a
 *  no-op (it skips the advance for a superseded invocation — see resolvers.ts)
 *  and can't clobber the caller's terminal state. With `failTask`, also drops
 *  the task to `failed` (restartable) — used by Stop / cancel-active-cli. The
 *  task `cancel` action passes `failTask:false` and sets `cancelled` itself
 *  afterwards; without the supersede-first step its `cancelled` gets clobbered
 *  back to `failed` by the dying job, forcing the user to click Cancel twice. */
export async function stopActiveCliInvocations(
  db: ReturnType<typeof getDb>,
  taskId: string,
  opts: { failTask: boolean; actor?: StopActor },
): Promise<{ killed: number; cancelled: number; stopped: number }> {
  const now = new Date();
  // Who stopped it. The owner reads these strings on their own task page, so an admin stopping
  // someone else's work during a maintenance drain must not be reported to them as "by user" —
  // that is the one reading of it that is actively wrong. Defaults to the original text, so the
  // owner-initiated path is unchanged.
  const by = opts.actor === 'admin' ? 'an administrator' : 'user';
  // Supersede every still-live invocation first (committed before the kill) so
  // the dying cli-exec job's resume is a no-op and can't clobber the caller's
  // terminal state.
  const active = await db
    .select({ id: schema.cliInvocations.id })
    .from(schema.cliInvocations)
    .where(
      and(
        eq(schema.cliInvocations.taskId, taskId),
        isNull(schema.cliInvocations.endedAt),
        isNull(schema.cliInvocations.supersededAt),
      ),
    );
  for (const inv of active) {
    await db
      .update(schema.cliInvocations)
      .set({
        exitCode: 137,
        errorMessage: `CLI cancelled by ${by}`,
        endedAt: now,
        supersededAt: now,
      })
      .where(eq(schema.cliInvocations.id, inv.id));
  }
  // Fail whatever step is stuck in running/waiting_cli. This covers BOTH a CLI
  // step (whose invocation we just superseded) AND a frozen deterministic step
  // with no live invocation — otherwise un-stoppable because there is nothing
  // in cli_invocations to cancel. Steps run one-at-a-time per task, so this only
  // ever hits the single active step.
  //
  // A step parked on the runtime-admission gate is `pending`, not running/waiting_cli, and it
  // owns no invocation — so before this it matched nothing, `stopped` came back empty, the
  // failTask branch below never fired, and Stop was a silent no-op while the 15s park poll
  // kept re-parking the step forever. The park marker is what identifies that row precisely
  // (an ordinary not-yet-run downstream step has status pending with a NULL marker, and must
  // not be failed).
  const stopped = await db
    .update(schema.taskSteps)
    .set({
      status: 'failed',
      errorMessage: `Stopped by ${by}`,
      endedAt: now,
      statusMessage: null,
      // Fold an outstanding park into idle_ms before closing the row — see the same fold in
      // cancelTaskRow (api/lib/cancel-task.ts) for why stamping ended_at alone silently turns
      // a recorded park back into work, and why the int4 clamp is load-bearing.
      // Caveat accepted: a step re-entered from waiting_cli keeps that status through its
      // apply phase (step-runner.ts only flips pending -> running), so stopping mid-apply
      // books that sliver as idle. Apply windows are sub-minute here (777 such rows total
      // 0.04h) against multi-hour parks, so the trade is strongly net-correct.
      idleMs: sql`${schema.taskSteps.idleMs} + least(2147483647 - ${schema.taskSteps.idleMs},
        greatest(0, floor(extract(epoch from (now() - ${schema.taskSteps.waitingStartedAt})) * 1000)))::int`,
      waitingStartedAt: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(schema.taskSteps.taskId, taskId),
        or(
          inArray(schema.taskSteps.status, ['running', 'waiting_cli']),
          and(eq(schema.taskSteps.status, 'pending'), isNotNull(schema.taskSteps.waitingStartedAt)),
        ),
      ),
    )
    .returning({ id: schema.taskSteps.id });
  if (opts.failTask && (active.length > 0 || stopped.length > 0)) {
    // Drop the task to `failed` (restartable) from any non-terminal state — incl.
    // `waiting_user`, which a half-finished step transition can leave behind.
    //
    // completedAt is the exit stamp every other terminal task write makes (markTaskCompleted
    // / markTaskFailed / handleCancelTask / cancelTaskRow), and Stop was the one path that
    // skipped it. Without it the task reads as terminal while carrying no exit time, which two
    // consumers then get wrong: computeTaskTiming ends the span at `completedAt ?? now`, so a
    // Stopped task's wall clock ticks forever, and the runtime reaper's failed-grace falls back
    // to the CONTAINER start — the anchor its own comment warns re-arms a full grace on every
    // stray reboot and lets a dead task squat a runtime slot. A retry or an allowance resume
    // clears it again (task-queue.ts), so restartability is unaffected.
    await db
      .update(schema.tasks)
      .set({
        status: 'failed',
        errorMessage: `Stopped by ${by}`,
        completedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.tasks.id, taskId),
          inArray(schema.tasks.status, ['running', 'queued', 'waiting_user']),
        ),
      );
  }
  // Force-remove the cli sandboxes AFTER the supersede writes commit, so the
  // dying job's resume sees the superseded row and skips its advance. Narrowed
  // to `haive-cli-*` (sandbox-kill.ts) so the DDEV/app runtime survives.
  const killed = await killTaskSandboxes(taskId);
  return { killed, cancelled: active.length, stopped: stopped.length };
}

/** Release a per-task pause. Clearing the column is the whole operation — the worker's
 *  park loop and the deferred cli-exec jobs re-check it on their own schedule, so there is
 *  no queue state to unwind here. */
export async function clearTaskPause(db: ReturnType<typeof getDb>, taskId: string): Promise<void> {
  await db
    .update(schema.tasks)
    .set({ pausedAt: null, updatedAt: new Date() })
    .where(and(eq(schema.tasks.id, taskId), isNotNull(schema.tasks.pausedAt)));
}
