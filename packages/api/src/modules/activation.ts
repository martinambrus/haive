import { and, desc, eq, inArray, isNotNull, isNull, sql, type SQL } from 'drizzle-orm';
import { LIVE_TASK_STATUSES, schema, type Database } from '@haive/database';
import { logger } from '@haive/shared';
import { MODULE_DEPENDENTS_CAP, isStepOfModule } from '@haive/shared/modularity';
import { recordAuditEvent } from '../lib/audit.js';
import { killTaskSandboxesOrThrow } from '../lib/sandbox-kill.js';
import { supersedeLiveRuns } from '../lib/task-control.js';
import { appendTaskEvent } from '../routes/tasks/_helpers.js';

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

// CASE, not AND: SQL does not order an AND's operands, and a snapshot that is not an array makes
// jsonb_array_elements_text raise.
const dependentRows = (db: Reader, moduleId: string, includeDead: boolean, also?: SQL) =>
  db
    .select({
      id: schema.tasks.id,
      title: schema.tasks.title,
      status: schema.tasks.status,
      ownerId: schema.tasks.userId,
      currentStepId: schema.tasks.currentStepId,
    })
    .from(schema.tasks)
    .where(
      and(
        // `created` counts: a draft runs nothing but would find its module deactivated once started.
        inArray(schema.tasks.status, [...LIVE_TASK_STATUSES]),
        includeDead ? undefined : isNull(schema.tasks.deadAt),
        also,
        sql`(EXISTS (
            SELECT 1 FROM ${schema.taskTypeDefinitions}
            WHERE ${schema.taskTypeDefinitions.slug} = ${schema.tasks.type}
              AND ${schema.taskTypeDefinitions.source} = ${`module:${moduleId}`}
          )
          OR CASE WHEN jsonb_typeof(${schema.tasks.runListSnapshot}) = 'array'
          THEN EXISTS (
            SELECT 1 FROM jsonb_array_elements_text(${schema.tasks.runListSnapshot}) AS s(id)
            WHERE starts_with(s.id, ${`module.${moduleId}.`})
          )
          ELSE false END)`,
      ),
    )
    .orderBy(desc(schema.tasks.updatedAt));

export async function liveDependents(
  db: Reader,
  moduleId: string,
  includeDead = false,
): Promise<{ tasks: ModuleDependent[]; capped: boolean }> {
  const rows = await dependentRows(db, moduleId, includeDead).limit(MODULE_DEPENDENTS_CAP + 1);
  return {
    tasks: rows.slice(0, MODULE_DEPENDENTS_CAP),
    capped: rows.length > MODULE_DEPENDENTS_CAP,
  };
}

export function setModuleActive(
  db: Database,
  moduleId: string,
  active: boolean,
): Promise<ModuleToggle> {
  return db.transaction(async (tx): Promise<ModuleToggle> => {
    const [row] = await tx
      .select({ deactivatedAt: schema.modules.deactivatedAt })
      .from(schema.modules)
      .where(eq(schema.modules.moduleId, moduleId))
      .for('update');
    if (!row) return { kind: 'missing' };
    if (active) {
      await tx
        .update(schema.modules)
        .set({ deactivatedAt: null, tornDownAt: null, updatedAt: new Date() })
        .where(eq(schema.modules.moduleId, moduleId));
      return { kind: 'ok', deactivatedAt: null };
    }
    if (row.deactivatedAt) return { kind: 'ok', deactivatedAt: row.deactivatedAt };
    const { tasks, capped } = await liveDependents(tx, moduleId);
    if (tasks.length > 0) return { kind: 'open', tasks, capped };
    const deactivatedAt = new Date();
    await tx
      .update(schema.modules)
      .set({ deactivatedAt, updatedAt: deactivatedAt })
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

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

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
    return { ...counts, killed: 0, killError: errorText(err) };
  }
};

export async function deactivateUrgently(
  db: Database,
  moduleId: string,
  actorUserId: string,
): Promise<UrgentDeactivation> {
  const stamped = await db.transaction(async (tx) => {
    const [row] = await tx
      .select({ deactivatedAt: schema.modules.deactivatedAt })
      .from(schema.modules)
      .where(eq(schema.modules.moduleId, moduleId))
      .for('update');
    if (!row) return null;
    const deactivatedAt = row.deactivatedAt ?? new Date();
    if (!row.deactivatedAt) {
      await tx
        .update(schema.modules)
        .set({ deactivatedAt, updatedAt: deactivatedAt })
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
        entry.eventError = errorText(err);
      }
    } catch (err) {
      report.failed.push({ id, title, error: errorText(err) });
    }
  }
  return { kind: 'ok', deactivatedAt: stamped.deactivatedAt, ...report };
}
