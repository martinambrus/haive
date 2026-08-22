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

/** Every template of this user whose saved Dockerfile hashes to `dockerfileHash`.
 *  Plural because the hash is NOT template identity: renderDockerfile skips the php
 *  and database blocks for a DDEV project, so environments that differ in php
 *  version, database or webserver still render byte-identical Dockerfiles. Callers
 *  narrow by declared deps (see 02-generate-dockerfile). */
export async function findEnvTemplatesByHash(
  db: Database,
  userId: string,
  dockerfileHash: string,
): Promise<EnvTemplateRow[]> {
  return db.query.envTemplates.findMany({
    where: and(
      eq(schema.envTemplates.userId, userId),
      eq(schema.envTemplates.dockerfileHash, dockerfileHash),
    ),
  });
}

export function deriveEnvTemplateName(taskId: string): string {
  return `task-${taskId.slice(0, 8)}`;
}

export function hashDockerfile(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/** Task statuses whose `env_template_id` link is disposable — i.e. the only ones a
 *  sibling task's teardown may delete an env template out from under.
 *
 *  ONLY `cancelled` qualifies. A `failed` task auto-resumes via reset and a `completed`
 *  one is reopened by flipping `tasks.status`; both then read their template row again,
 *  and 09-gate-2-verify-approval derives `browserTesting` from it. The FK is
 *  `ON DELETE SET NULL`, so deleting a row either still points at nulls the link with no
 *  error and no event on the victim — the task comes back with its live-browser panel
 *  silently gone while its runner is up and serving. Observed 2026-08-16: cancelling one
 *  task reaped the template a second, `failed` task shared, and that task's next gate
 *  round (after a reset-resume) rendered without the VNC browser. */
export const DISPOSABLE_TASK_STATUSES = ['cancelled'] as const;

/** True when a task in `status` still pins its env template (see
 *  {@link DISPOSABLE_TASK_STATUSES}). Pure so both reference counts — the cancel reap in
 *  task-queue and the dedupe delete in 02-generate-dockerfile — apply one rule. */
export function pinsEnvTemplate(status: string): boolean {
  return !(DISPOSABLE_TASK_STATUSES as readonly string[]).includes(status);
}
