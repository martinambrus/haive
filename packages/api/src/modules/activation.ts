import { and, desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import { LIVE_TASK_STATES } from '../routes/maintenance.js';

type Reader = Pick<Database, 'select'>;

export interface ModuleDependent {
  id: string;
  title: string;
  status: string;
  ownerId: string;
}

export type ModuleToggle =
  | { kind: 'missing' }
  | { kind: 'open'; tasks: ModuleDependent[] }
  | { kind: 'ok'; deactivatedAt: Date | null };

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
export function liveDependents(
  db: Reader,
  moduleId: string,
  includeDead = false,
): Promise<ModuleDependent[]> {
  return db
    .select({
      id: schema.tasks.id,
      title: schema.tasks.title,
      status: schema.tasks.status,
      ownerId: schema.tasks.userId,
    })
    .from(schema.tasks)
    .where(
      and(
        inArray(schema.tasks.status, [...LIVE_TASK_STATES]),
        includeDead ? undefined : isNull(schema.tasks.deadAt),
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
    .orderBy(desc(schema.tasks.updatedAt))
    .limit(DEPENDENTS_CAP);
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
    const tasks = await liveDependents(tx, moduleId);
    if (tasks.length > 0) return { kind: 'open', tasks };
    const deactivatedAt = new Date();
    await tx
      .update(schema.modules)
      .set({ deactivatedAt })
      .where(eq(schema.modules.moduleId, moduleId));
    return { kind: 'ok', deactivatedAt };
  });
}
