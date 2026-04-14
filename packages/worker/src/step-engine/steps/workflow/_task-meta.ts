import { eq } from 'drizzle-orm';
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
