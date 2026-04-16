import { and, eq } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';

export interface TaskMeta {
  title: string;
  description: string;
}

export async function loadTaskMeta(db: Database, taskId: string): Promise<TaskMeta> {
  const row = await db.query.tasks.findFirst({
    where: eq(schema.tasks.id, taskId),
  });
  return {
    title: row?.title ?? '',
    description: row?.description ?? '',
  };
}

export interface AppBootOutput {
  booted: boolean;
  skipped: boolean;
  bootCommand: string | null;
  appUrl: string | null;
  healthCheckPassed: boolean;
}

export async function loadAppBootOutput(
  db: Database,
  taskId: string,
): Promise<AppBootOutput | null> {
  const rows = await db
    .select()
    .from(schema.taskSteps)
    .where(and(eq(schema.taskSteps.taskId, taskId), eq(schema.taskSteps.stepId, '01a-app-boot')))
    .limit(1);
  const row = rows[0];
  if (!row?.output) return null;
  return row.output as AppBootOutput;
}
