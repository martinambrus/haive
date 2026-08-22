import { createHash } from 'node:crypto';
import { and, eq, ne, notInArray } from 'drizzle-orm';
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

/** The template of this user carrying `dockerfileHash`, or null. At most one can
 *  exist: `env_templates_user_hash_idx` is UNIQUE on (user_id, dockerfile_hash).
 *  That constraint is why the stored hash covers the declared deps as well as the
 *  Dockerfile text — see `envTemplateHash` in 02-generate-dockerfile. */
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

/** Ids of OTHER still-live tasks whose `env_template_id` points at `templateId`.
 *
 *  A row with sharers defines THEIR environment too, so it may be neither deleted
 *  (02's dedupe) nor rewritten in place (01's re-declaration) on one task's behalf.
 *
 *  The dedupe path in apply() is not free to delete the row it superseded: that row can
 *  be shared. 02 relinks a task onto ANOTHER task's template whenever the hashes and
 *  declared deps both match, so one row can define many tasks' environments (which is
 *  also why 01-declare-deps forks rather than rewriting a shared row in place — its
 *  `existing` is just `getTaskEnvTemplate`). `tasks.env_template_id`
 *  is `ON DELETE SET NULL`, so deleting a row a live task still points at silently nulls
 *  that task's link — no error, no event on the victim. The victim only finds out much
 *  later and indirectly: 09-gate-2-verify-approval computes `browserTesting` off the
 *  template row, so a nulled link makes it false and the gate quietly stops offering its
 *  live browser on a task whose runner is up and serving.
 *
 *  Same reference count `cleanupTaskEnvImage` (task-queue.ts) applies before reaping a
 *  template; both share `DISPOSABLE_TASK_STATUSES`, so a `failed` or `completed` task
 *  still counts — it can resume or be reopened. `reapOrphanEnvTemplates` keeps its own
 *  wider dead-set, which is sound because it only ever sweeps rows that never reached
 *  `ready`; a kept row of that kind is still collected at the next worker boot. */
export async function liveTasksSharingEnvTemplate(
  db: Database,
  templateId: string,
  exceptTaskId: string,
): Promise<string[]> {
  const rows = await db
    .select({ id: schema.tasks.id })
    .from(schema.tasks)
    .where(
      and(
        eq(schema.tasks.envTemplateId, templateId),
        ne(schema.tasks.id, exceptTaskId),
        notInArray(schema.tasks.status, [...DISPOSABLE_TASK_STATUSES]),
      ),
    );
  return rows.map((r) => r.id);
}
