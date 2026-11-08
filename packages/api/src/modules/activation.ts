import { moduleDependentRows, moduleDependents } from '@haive/shared/modularity-server';
import { eq, isNotNull, sql } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import { logger } from '@haive/shared';
import { safeErrorMessage } from '@haive/shared/logger';
import { isStepOfModule } from '@haive/shared/modularity';
import { insertAuditEvent, recordAuditEvent } from '../lib/audit.js';
import { enqueueStopSettle } from '../lib/cancel-task.js';
import { killTaskSandboxesOrThrow } from '../lib/sandbox-kill.js';
import { supersedeLiveRuns } from '../lib/task-control.js';
import { appendTaskEvent } from '../lib/task-events.js';

type Reader = Pick<Database, 'select'>;

const log = logger.child({ module: 'module-activation' });

export interface ModuleDependent {
  id: string;
  title: string;
  status: string;
  ownerId: string;
  currentStepId: string | null;
}

export type ModuleToggle =
  | { kind: 'missing' }
  | { kind: 'open'; tasks: ModuleDependent[]; capped: boolean }
  | { kind: 'ok'; deactivatedAt: Date | null };

interface UrgentReport {
  stopped: {
    id: string;
    title: string;
    killed: number;
    cancelled: number;
    stopped: number;
    failedAt: string | null;
    eventError?: string;
    killError?: string;
  }[];
  left: Pick<ModuleDependent, 'id' | 'title' | 'status' | 'currentStepId'>[];
  failed: { id: string; title: string; error: string }[];
  capped: boolean;
}

export type UrgentDeactivation =
  { kind: 'missing' } | ({ kind: 'ok'; deactivatedAt: Date } & UrgentReport);

export async function deactivatedModuleIds(db: Reader): Promise<Set<string>> {
  const rows = await db
    .select({ moduleId: schema.modules.moduleId })
    .from(schema.modules)
    .where(isNotNull(schema.modules.deactivatedAt));
  return new Set(rows.map((r) => r.moduleId));
}

export async function isModuleDeactivated(db: Reader, moduleId: string): Promise<boolean> {
  const [row] = await db
    .select({ deactivatedAt: schema.modules.deactivatedAt })
    .from(schema.modules)
    .where(eq(schema.modules.moduleId, moduleId))
    .limit(1);
  return row?.deactivatedAt != null;
}

const dependentRows = moduleDependentRows;
export const liveDependents = moduleDependents;

export function setModuleActive(
  db: Database,
  moduleId: string,
  active: boolean,
  actorUserId?: string,
): Promise<ModuleToggle> {
  return db.transaction(async (tx): Promise<ModuleToggle> => {
    await tx.execute(sql`SET LOCAL lock_timeout = '5s'`);
    const [row] = await tx
      .select({
        deactivatedAt: schema.modules.deactivatedAt,
        drainingAt: schema.modules.drainingAt,
      })
      .from(schema.modules)
      .where(eq(schema.modules.moduleId, moduleId))
      .for('update');
    if (!row) return { kind: 'missing' };
    if (active) {
      if (row.drainingAt && actorUserId)
        await insertAuditEvent(tx, {
          actorUserId,
          action: 'module.drain_cancel',
          targetType: 'module',
          metadata: { moduleId },
        });
      await tx
        .delete(schema.moduleDrainTasks)
        .where(eq(schema.moduleDrainTasks.moduleId, moduleId));
      await tx
        .update(schema.modules)
        .set({
          deactivatedAt: null,
          tornDownAt: null,
          drainingAt: null,
          drainingBy: null,
          updatedAt: new Date(),
        })
        .where(eq(schema.modules.moduleId, moduleId));
      return { kind: 'ok', deactivatedAt: null };
    }
    if (row.deactivatedAt) return { kind: 'ok', deactivatedAt: row.deactivatedAt };
    const { tasks, capped } = await liveDependents(tx, moduleId);
    if (tasks.length > 0) return { kind: 'open', tasks, capped };
    const deactivatedAt = new Date();
    if (row.drainingAt) {
      if (actorUserId)
        await insertAuditEvent(tx, {
          actorUserId,
          action: 'module.deactivate',
          targetType: 'module',
          metadata: { moduleId, mode: 'graceful' },
        });
      await tx
        .delete(schema.moduleDrainTasks)
        .where(eq(schema.moduleDrainTasks.moduleId, moduleId));
    }
    await tx
      .update(schema.modules)
      .set({ deactivatedAt, drainingAt: null, drainingBy: null, updatedAt: deactivatedAt })
      .where(eq(schema.modules.moduleId, moduleId));
    return { kind: 'ok', deactivatedAt };
  });
}

// starts_with only narrows the rows in SQL; isStepOfModule is the exact test.
const dependentsInModuleStep = async (db: Reader, moduleId: string): Promise<ModuleDependent[]> => {
  const rows = await dependentRows(
    db,
    moduleId,
    false,
    sql`starts_with(${schema.tasks.currentStepId}, ${`module.${moduleId}.`})`,
  );
  return rows.filter((row) => isStepOfModule(row.currentStepId, moduleId));
};

// The stop commits before the kill, so a kill that throws is noted on the result, never thrown.
const stopTask = async (
  db: Database,
  taskId: string,
): Promise<{
  killed: number;
  cancelled: number;
  stopped: number;
  failedAt: string | null;
  killError?: string;
}> => {
  const counts = await db.transaction((tx) =>
    supersedeLiveRuns(tx, taskId, { failTask: true, actor: 'admin' }),
  );
  try {
    return { ...counts, killed: await killTaskSandboxesOrThrow(taskId) };
  } catch (err) {
    log.error({ err, taskId }, 'sandbox kill for an urgent stop failed');
    return { ...counts, killed: 0, killError: safeErrorMessage(err) };
  }
};

export async function deactivateUrgently(
  db: Database,
  moduleId: string,
  actorUserId: string,
): Promise<UrgentDeactivation> {
  const stamped = await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL lock_timeout = '5s'`);
    const [row] = await tx
      .select({
        deactivatedAt: schema.modules.deactivatedAt,
        drainingAt: schema.modules.drainingAt,
      })
      .from(schema.modules)
      .where(eq(schema.modules.moduleId, moduleId))
      .for('update');
    if (!row) return null;
    await tx.delete(schema.moduleDrainTasks).where(eq(schema.moduleDrainTasks.moduleId, moduleId));
    if (row.drainingAt)
      await insertAuditEvent(tx, {
        actorUserId,
        action: 'module.drain_cancel',
        targetType: 'module',
        metadata: { moduleId, mode: 'urgent' },
      });
    if (row.drainingAt)
      await tx
        .update(schema.modules)
        .set({ drainingAt: null, drainingBy: null })
        .where(eq(schema.modules.moduleId, moduleId));
    const deactivatedAt = row.deactivatedAt ?? new Date();
    if (!row.deactivatedAt) {
      await tx
        .update(schema.modules)
        .set({ deactivatedAt, drainingAt: null, drainingBy: null, updatedAt: deactivatedAt })
        .where(eq(schema.modules.moduleId, moduleId));
    }
    const { tasks, capped } = await liveDependents(tx, moduleId);
    const listed = new Set(tasks.map((task) => task.id));
    const unlisted = (await dependentsInModuleStep(tx, moduleId)).filter((t) => !listed.has(t.id));
    return { deactivatedAt, capped, dependents: [...tasks, ...unlisted] };
  });
  if (!stamped) return { kind: 'missing' };

  const report: UrgentReport = { stopped: [], left: [], failed: [], capped: stamped.capped };
  for (const { id, title, status, ownerId, currentStepId } of stamped.dependents) {
    if (!isStepOfModule(currentStepId, moduleId)) {
      report.left.push({ id, title, status, currentStepId });
      continue;
    }
    try {
      const { killError, ...result } = await stopTask(db, id);
      await enqueueStopSettle(id, ownerId, result.failedAt);
      if (result.cancelled === 0 && result.stopped === 0) {
        report.left.push({ id, title, status, currentStepId });
        continue;
      }
      const entry: UrgentReport['stopped'][number] = { id, title, ...result };
      if (killError !== undefined) entry.killError = killError;
      report.stopped.push(entry);
      // The stop is committed: a failed record is noted on the entry, not as a failed stop.
      try {
        await recordAuditEvent(db, {
          actorUserId,
          action: 'task.admin_stop',
          targetType: 'task',
          targetId: id,
          metadata: { ownerUserId: ownerId, moduleId },
        });
        await appendTaskEvent(db, id, null, 'task.stopped', {
          by: actorUserId,
          byAdmin: true,
          reason: 'module_deactivated',
          moduleId,
          ...result,
        });
      } catch (err) {
        log.error({ err, taskId: id, moduleId }, 'event or audit write for an urgent stop failed');
        entry.eventError = safeErrorMessage(err);
      }
    } catch (err) {
      report.failed.push({ id, title, error: safeErrorMessage(err) });
    }
  }
  return { kind: 'ok', deactivatedAt: stamped.deactivatedAt, ...report };
}
