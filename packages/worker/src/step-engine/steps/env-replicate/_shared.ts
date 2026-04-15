import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';

export type EnvTemplateRow = typeof schema.envTemplates.$inferSelect;

export async function getTaskEnvTemplate(
  db: Database,
  taskId: string,
): Promise<EnvTemplateRow | null> {
  const task = await db.query.tasks.findFirst({
    where: eq(schema.tasks.id, taskId),
    columns: { envTemplateId: true },
  });
  if (!task?.envTemplateId) return null;
  const row = await db.query.envTemplates.findFirst({
    where: eq(schema.envTemplates.id, task.envTemplateId),
  });
  return row ?? null;
}

export async function linkTaskToEnvTemplate(
  db: Database,
  taskId: string,
  envTemplateId: string,
): Promise<void> {
  await db
    .update(schema.tasks)
    .set({ envTemplateId, updatedAt: new Date() })
    .where(eq(schema.tasks.id, taskId));
}

export async function findEnvTemplateByHash(
  db: Database,
  userId: string,
  dockerfileHash: string,
): Promise<EnvTemplateRow | null> {
  const row = await db.query.envTemplates.findFirst({
    where: and(
      eq(schema.envTemplates.userId, userId),
      eq(schema.envTemplates.dockerfileHash, dockerfileHash),
    ),
  });
  return row ?? null;
}

export function deriveEnvTemplateName(taskId: string): string {
  return `task-${taskId.slice(0, 8)}`;
}

export function hashDockerfile(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}
