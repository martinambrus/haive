import { tryLockTaskIntegrations } from '../integrations/task-lock.js';
import { logger } from '../logger/index.js';
import { and, asc, desc, eq, inArray, isNotNull, isNull, sql, type SQL } from 'drizzle-orm';
import {
  isLockNotAvailable,
  LIVE_TASK_STATUSES,
  schema,
  type Database,
  type DbTx,
} from '@haive/database';
import { MODULE_DEPENDENTS_CAP } from '../modularity/module-intent.js';
import { parseCategoryId, parseProviderId } from '../modularity/contracts.js';
import { moduleTaskDependency } from './module-dependencies.js';

type Reader = Pick<Database, 'select'>;

export class ModuleAdmissionError extends Error {
  constructor(
    readonly moduleId: string,
    readonly code: 'module-draining' | 'module-busy' | 'module-deactivated',
  ) {
    super(
      code === 'module-busy'
        ? `Module ${moduleId} is being changed; try again.`
        : code === 'module-draining'
          ? `Module ${moduleId} is draining. Finish existing tasks or cancel its drain before starting new work.`
          : `Module ${moduleId} is deactivated.`,
    );
    this.name = 'ModuleAdmissionError';
  }
}

export function integrationModuleIds(
  picks: readonly { categoryId?: string | null; providerId?: string | null }[],
): string[] {
  const ids = new Set<string>();
  for (const pick of picks)
    for (const parsed of [
      pick.categoryId ? parseCategoryId(pick.categoryId) : null,
      pick.providerId ? parseProviderId(pick.providerId) : null,
    ]) {
      if (parsed?.kind === 'module') ids.add(parsed.moduleId);
    }
  return [...ids].sort();
}

/** Same admission state for read-only previews and fenced mutation checks. A preview holds no
 * row lock; a mutation retains KEY SHARE until its transaction commits. Failed reads still throw. */
export async function moduleAdmissionFailures(
  db: Reader,
  ids: readonly string[],
  opts: { taskId?: string; lock?: boolean; checkOff?: boolean } = {},
): Promise<Map<string, 'module-draining' | 'module-deactivated'>> {
  const failures = new Map<string, 'module-draining' | 'module-deactivated'>();
  if (ids.length === 0) return failures;
  let rows;
  try {
    const query = db
      .select({
        id: schema.modules.moduleId,
        drainingAt: schema.modules.drainingAt,
        deactivatedAt: schema.modules.deactivatedAt,
      })
      .from(schema.modules)
      .where(inArray(schema.modules.moduleId, [...new Set(ids)].sort()))
      .orderBy(asc(schema.modules.moduleId));
    rows = opts.lock ? await query.for('key share', { noWait: true }) : await query;
  } catch (err) {
    if (opts.lock && isLockNotAvailable(err))
      throw new ModuleAdmissionError(ids[0]!, 'module-busy');
    throw err;
  }
  for (const row of rows) {
    if (opts.checkOff && row.deactivatedAt) {
      failures.set(row.id, 'module-deactivated');
      continue;
    }
    if (!row.drainingAt) continue;
    const member = opts.taskId
      ? await db
          .select({ id: schema.moduleDrainTasks.taskId })
          .from(schema.moduleDrainTasks)
          .where(
            and(
              eq(schema.moduleDrainTasks.moduleId, row.id),
              eq(schema.moduleDrainTasks.taskId, opts.taskId),
            ),
          )
          .limit(1)
      : [];
    if (!member.length) failures.set(row.id, 'module-draining');
  }
  return failures;
}

/** NOWAIT avoids a row upgrade against a toggle queued behind a creator's KEY SHARE. */
export async function guardModuleAdmission(
  db: Reader,
  ids: readonly string[],
  taskId?: string,
  checkOff = false,
): Promise<void> {
  const failures = await moduleAdmissionFailures(db, ids, { taskId, checkOff, lock: true });
  const first = failures.entries().next().value;
  if (first) throw new ModuleAdmissionError(first[0], first[1]);
}

/** The caller already holds the required module admission leases in this task-insert transaction.
 * Keep evidence across drain cancellation/reactivation without pinning an account or provider. */
export async function recordTaskModuleAdmissions(
  db: Pick<Database, 'insert'>,
  taskId: string,
  moduleIds: readonly string[],
): Promise<void> {
  if (moduleIds.length === 0) return;
  await db
    .insert(schema.moduleTaskAdmissions)
    .values([...new Set(moduleIds)].sort().map((moduleId) => ({ moduleId, taskId })))
    .onConflictDoNothing();
}

/** Stored source/snapshot/bindings, plus the cohort even after a binding is reset. No task locks. */
export async function guardTaskModuleAdmission(tx: DbTx, taskId: string): Promise<void> {
  const recorded = await tx.select({ id: schema.modules.moduleId }).from(schema.modules);
  if (recorded.length === 0) return;
  if (!(await tryLockTaskIntegrations(tx, taskId)))
    throw new ModuleAdmissionError(recorded[0]!.id, 'module-busy');
  const rows = await tx.select({ id: schema.modules.moduleId }).from(schema.modules)
    .where(sql`EXISTS (
    SELECT 1 FROM ${schema.tasks} WHERE ${schema.tasks.id} = ${taskId}
    AND (${moduleTaskDependency(sql`${schema.modules.moduleId}`)} OR EXISTS (
      SELECT 1 FROM ${schema.moduleDrainTasks} WHERE ${schema.moduleDrainTasks.moduleId} = ${schema.modules.moduleId} AND ${schema.moduleDrainTasks.taskId} = ${schema.tasks.id})))`);
  await guardModuleAdmission(
    tx,
    rows.map((r) => r.id),
    taskId,
  );
}

export function moduleDependentRows(db: Reader, moduleId: string, includeDead = false, also?: SQL) {
  return db
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
        inArray(schema.tasks.status, [...LIVE_TASK_STATUSES]),
        includeDead ? undefined : isNull(schema.tasks.deadAt),
        also,
        sql`(${moduleTaskDependency(moduleId)} OR EXISTS (SELECT 1 FROM ${schema.moduleDrainTasks} WHERE ${schema.moduleDrainTasks.moduleId} = ${moduleId} AND ${schema.moduleDrainTasks.taskId} = ${schema.tasks.id}))`,
      ),
    )
    .orderBy(desc(schema.tasks.updatedAt), asc(schema.tasks.id));
}

export async function moduleDependents(db: Reader, moduleId: string, includeDead = false) {
  const rows = await moduleDependentRows(db, moduleId, includeDead).limit(
    MODULE_DEPENDENTS_CAP + 1,
  );
  return {
    tasks: rows.slice(0, MODULE_DEPENDENTS_CAP),
    capped: rows.length > MODULE_DEPENDENTS_CAP,
  };
}

async function audit(tx: DbTx, actorUserId: string, moduleId: string, action: string) {
  await tx.insert(schema.auditEvents).values({
    actorUserId,
    action,
    targetType: 'module',
    metadata: { moduleId, mode: 'graceful' },
    createdAt: sql`clock_timestamp()`,
  });
}

/** Short row lock only; never wait for task completion inside a transaction. */
export async function beginModuleDrain(db: Database, moduleId: string, actorUserId: string) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL lock_timeout = '5s'`);
    const [row] = await tx
      .select()
      .from(schema.modules)
      .where(eq(schema.modules.moduleId, moduleId))
      .for('update');
    if (!row) return null;
    if (row.deactivatedAt || row.drainingAt) return row;
    await audit(tx, actorUserId, moduleId, 'module.drain');
    await tx.execute(sql`INSERT INTO ${schema.moduleDrainTasks} (module_id, task_id)
      SELECT ${moduleId}, ${schema.tasks.id} FROM ${schema.tasks}
      WHERE ${inArray(schema.tasks.status, [...LIVE_TASK_STATUSES])} AND ${isNull(schema.tasks.deadAt)} AND ${moduleTaskDependency(moduleId)}
      ON CONFLICT DO NOTHING`);
    const [updated] = await tx
      .update(schema.modules)
      .set({ drainingAt: new Date(), drainingBy: actorUserId })
      .where(eq(schema.modules.moduleId, moduleId))
      .returning();
    return updated!;
  });
}

/** The lock re-reads cancellation/activation; admitted writers hold KEY SHARE until commit.
 * Recount is uncapped and includes cohort members whose bindings have since been reset. */
export async function finalizeModuleDrain(db: Database, moduleId: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL lock_timeout = '5s'`);
    const [row] = await tx
      .select()
      .from(schema.modules)
      .where(eq(schema.modules.moduleId, moduleId))
      .for('update');
    if (!row?.drainingAt || row.deactivatedAt) return false;
    if ((await moduleDependentRows(tx, moduleId).limit(1)).length) return false;
    await audit(tx, row.drainingBy!, moduleId, 'module.deactivate');
    await tx
      .update(schema.modules)
      .set({ deactivatedAt: new Date(), drainingAt: null, drainingBy: null, updatedAt: new Date() })
      .where(eq(schema.modules.moduleId, moduleId));
    await tx.delete(schema.moduleDrainTasks).where(eq(schema.moduleDrainTasks.moduleId, moduleId));
    return true;
  });
}

export async function finalizeModuleDrains(db: Database): Promise<void> {
  const rows = await db
    .select({ id: schema.modules.moduleId })
    .from(schema.modules)
    .where(isNotNull(schema.modules.drainingAt))
    .orderBy(asc(schema.modules.moduleId));
  for (const row of rows) {
    try {
      await finalizeModuleDrain(db, row.id);
    } catch (err) {
      logger.warn({ err, moduleId: row.id }, 'module drain finalization will be retried');
    }
  }
}

export async function cancelModuleDrain(db: Database, moduleId: string, actorUserId: string) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL lock_timeout = '5s'`);
    const [row] = await tx
      .select()
      .from(schema.modules)
      .where(eq(schema.modules.moduleId, moduleId))
      .for('update');
    if (!row) return false;
    if (row.drainingAt) {
      await audit(tx, actorUserId, moduleId, 'module.drain_cancel');
      await tx
        .update(schema.modules)
        .set({ drainingAt: null, drainingBy: null })
        .where(eq(schema.modules.moduleId, moduleId));
      await tx
        .delete(schema.moduleDrainTasks)
        .where(eq(schema.moduleDrainTasks.moduleId, moduleId));
    }
    return true;
  });
}
