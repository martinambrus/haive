import { and, eq, isNull, isNotNull, sql } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import { CONFIG_KEYS, ConfigUnavailableError, configService, logger } from '@haive/shared';

const log = logger.child({ module: 'pause' });

/** Why a task is being held. `global` is the admin kill-switch, `task` is the per-task
 *  Pause button. Reported so the park banner can name the one the user has to undo.
 *  `unreadable` is neither: the pause state could not be read (config store down, task read
 *  failed), so the task is held until a read answers. There is nothing for a user to undo. */
export type PauseScope = 'global' | 'task' | 'unreadable';

/** Is this task held right now, and by what?
 *
 *  Two gates consult this: the step-boundary gate in `handleAdvanceStep` (which parks the next
 *  step instead of running it) and the cli-exec pickup gate (which defers a queued invocation
 *  instead of spawning its sandbox). Neither ever interrupts work already in flight — a CLI
 *  that is running finishes, which is the whole contract of "pause after the current run".
 *
 *  FAIL-CLOSED. A pause that cannot be read must hold: missing it runs work an administrator
 *  froze, while a false hold lifts by itself on the next poll (the step hold re-drives every
 *  poll, the cli-exec gate re-defers). A config store that is unavailable, or a failed task
 *  read, answers 'unreadable'. Any other global read error (e.g. a store that was never
 *  initialised, as in a Redis-less test) stays lenient and goes on to the task row. Global is
 *  checked first and wins, so the kill-switch still holds a task that carries no `paused_at`
 *  of its own.
 *
 *  Both reads are cheap — the config value comes from the ~30s cache and the task read is a
 *  primary-key lookup — so this is called per advance and per job pickup rather than being
 *  threaded through the call graph. */
export async function resolvePause(db: Database, taskId: string): Promise<PauseScope | null> {
  try {
    if (await configService.getBoolean(CONFIG_KEYS.GLOBAL_PAUSE, false)) return 'global';
  } catch (err) {
    if (err instanceof ConfigUnavailableError) {
      log.warn({ err }, 'global pause read failed (config store unavailable); holding');
      return 'unreadable';
    }
    log.warn({ err }, 'global pause read failed; treating as not paused');
  }
  try {
    const rows = await db
      .select({ pausedAt: schema.tasks.pausedAt })
      .from(schema.tasks)
      .where(eq(schema.tasks.id, taskId))
      .limit(1);
    return rows[0]?.pausedAt ? 'task' : null;
  } catch (err) {
    log.warn({ err, taskId }, 'task pause read failed; holding');
    return 'unreadable';
  }
}

/** Copy for the pause park banner. Display only — every consumer keys on `tasks.paused_at` or
 *  the config switch, never on this text. Printed to every viewer, including one an
 *  administrator's pause has locked out of Resume, so it does not tell the reader to resume. */
export function pauseParkMessage(scope: PauseScope): string {
  if (scope === 'unreadable') {
    return 'Waiting for the configuration store — the pause setting cannot be read, so this step is held until it can';
  }
  return scope === 'global'
    ? 'Paused — all execution is paused by an administrator'
    : 'Paused — this task continues when it is resumed';
}

/** Does this task have a CLI invocation actually RUNNING (started, not ended, not superseded)?
 *
 *  The "settled" test for a paused task's runtime. Pause deliberately lets the run in flight
 *  finish, and that run may be driving this very task's DDEV/app container, so the runner must
 *  not be reclaimed out from under it. Fail-safe — an error answers "still busy", which keeps
 *  the runner rather than risking a reap mid-run. Same predicate `enforceTaskAgentCap` counts. */
export async function hasLiveCliInvocation(db: Database, taskId: string): Promise<boolean> {
  try {
    const rows = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.cliInvocations)
      .where(
        and(
          eq(schema.cliInvocations.taskId, taskId),
          isNotNull(schema.cliInvocations.startedAt),
          isNull(schema.cliInvocations.endedAt),
          isNull(schema.cliInvocations.supersededAt),
        ),
      );
    return (rows[0]?.n ?? 0) > 0;
  } catch (err) {
    log.warn({ err, taskId }, 'live-invocation check failed; treating the task as busy');
    return true;
  }
}
