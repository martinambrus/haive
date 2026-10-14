import { and, desc, eq, inArray, isNotNull, isNull, sql, type SQL } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import { logger } from '@haive/shared';
import { parseStepId } from '@haive/shared/modularity';
import { recordAuditEvent } from '../lib/audit.js';
import { stopActiveCliInvocations } from '../lib/task-control.js';
import { LIVE_TASK_STATES } from '../routes/maintenance.js';
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
    eventError?: string;
  }[];
  left: Pick<ModuleDependent, 'id' | 'title' | 'status' | 'currentStepId'>[];
  failed: { id: string; error: string }[];
  capped: boolean;
}

export type UrgentDeactivation =
  { kind: 'missing' } | ({ kind: 'ok'; deactivatedAt: Date } & UrgentReport);

const DEPENDENTS_CAP = 200;

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
        inArray(schema.tasks.status, [...LIVE_TASK_STATES]),
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
  const rows = await dependentRows(db, moduleId, includeDead).limit(DEPENDENTS_CAP + 1);
  return { tasks: rows.slice(0, DEPENDENTS_CAP), capped: rows.length > DEPENDENTS_CAP };
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
        .set({ deactivatedAt: null, tornDownAt: null })
        .where(eq(schema.modules.moduleId, moduleId));
      return { kind: 'ok', deactivatedAt: null };
    }
    if (row.deactivatedAt) return { kind: 'ok', deactivatedAt: row.deactivatedAt };
    const { tasks, capped } = await liveDependents(tx, moduleId);
    if (tasks.length > 0) return { kind: 'open', tasks, capped };
    const deactivatedAt = new Date();
    await tx
      .update(schema.modules)
      .set({ deactivatedAt })
      .where(eq(schema.modules.moduleId, moduleId));
    return { kind: 'ok', deactivatedAt };
  });
}

const inModuleStep = (stepId: string | null, moduleId: string): boolean => {
  const parsed = stepId === null ? null : parseStepId(stepId);
  return parsed?.kind === 'module' && parsed.moduleId === moduleId;
};

// starts_with only narrows the rows in SQL; inModuleStep is the exact test.
const dependentsInModuleStep = async (db: Reader, moduleId: string): Promise<ModuleDependent[]> => {
  const rows = await dependentRows(
    db,
    moduleId,
    false,
    sql`starts_with(${schema.tasks.currentStepId}, ${`module.${moduleId}.`})`,
  );
  return rows.filter((row) => inModuleStep(row.currentStepId, moduleId));
};

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

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
        .set({ deactivatedAt })
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
    if (!inModuleStep(currentStepId, moduleId)) {
      report.left.push({ id, title, status, currentStepId });
      continue;
    }
    try {
      const result = await stopActiveCliInvocations(db, id, { failTask: true, actor: 'admin' });
      if (result.cancelled === 0 && result.stopped === 0) {
        report.left.push({ id, title, status, currentStepId });
        continue;
      }
      const entry: UrgentReport['stopped'][number] = { id, title, ...result };
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
      report.failed.push({ id, error: errorText(err) });
    }
  }
  return { kind: 'ok', deactivatedAt: stamped.deactivatedAt, ...report };
}
