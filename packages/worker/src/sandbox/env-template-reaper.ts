import { and, eq, inArray, isNotNull, notInArray } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import { logger } from '@haive/shared';
import { defaultDockerRunner, type DockerRunner } from './docker-runner.js';

// Tasks in these states no longer need their env template.
const TERMINAL_STATUSES = ['completed', 'failed', 'cancelled'] as const;
// Template states that never produced a reusable image. 'ready' is the
// dockerfile-hash reuse cache and is NEVER reaped here — only repo-delete GCs a
// ready template (handleCleanupRepoResources).
const REAPABLE_STATUSES = ['pending', 'building', 'failed'] as const;

export interface EnvTemplateCandidate {
  id: string;
  imageRef: string | null;
}

/** Pure: of the never-ready candidate templates, the orphans are those that no
 *  LIVE task references. Split out so the selection is unit-testable without a db
 *  or docker. */
export function selectOrphanEnvTemplates(
  candidates: EnvTemplateCandidate[],
  liveTemplateIds: ReadonlySet<string>,
): EnvTemplateCandidate[] {
  return candidates.filter((c) => !liveTemplateIds.has(c.id));
}

/** Reap env_templates that never reached 'ready' AND have no live task — the
 *  leftovers from a task that ended before its image built, or a crash mid-build.
 *  Removes the stale image (by tag, else built-image id) best-effort — but never an
 *  image a 'ready' template still references — then deletes the row. The 'ready'
 *  reuse cache is left intact. Runs at worker boot as a backstop; the relink path
 *  (02-generate-dockerfile deletes its own superseded row) and cancel teardown
 *  already cover their cases. Returns the number reaped. */
export async function reapOrphanEnvTemplates(
  db: Database,
  runner: DockerRunner = defaultDockerRunner,
): Promise<number> {
  const candidates = await db
    .select({
      id: schema.envTemplates.id,
      imageTag: schema.envTemplates.imageTag,
      builtImageId: schema.envTemplates.builtImageId,
    })
    .from(schema.envTemplates)
    .where(inArray(schema.envTemplates.status, [...REAPABLE_STATUSES]));
  if (candidates.length === 0) return 0;

  // Template ids referenced by a still-live task — keep those (a running
  // env-replicate prelude is mid-build).
  const liveRefs = await db
    .select({ envTemplateId: schema.tasks.envTemplateId })
    .from(schema.tasks)
    .where(
      and(
        isNotNull(schema.tasks.envTemplateId),
        notInArray(schema.tasks.status, [...TERMINAL_STATUSES]),
      ),
    );
  const liveTemplateIds = new Set(
    liveRefs.map((r) => r.envTemplateId).filter((x): x is string => x !== null),
  );

  // Image refs a 'ready' template still uses — never remove these even if an
  // orphan row happens to point at the same image.
  const readyRows = await db
    .select({
      imageTag: schema.envTemplates.imageTag,
      builtImageId: schema.envTemplates.builtImageId,
    })
    .from(schema.envTemplates)
    .where(eq(schema.envTemplates.status, 'ready'));
  const protectedRefs = new Set<string>();
  for (const r of readyRows) {
    if (r.imageTag) protectedRefs.add(r.imageTag);
    if (r.builtImageId) protectedRefs.add(r.builtImageId);
  }

  const orphans = selectOrphanEnvTemplates(
    candidates.map((c) => ({ id: c.id, imageRef: c.imageTag ?? c.builtImageId })),
    liveTemplateIds,
  );
  if (orphans.length === 0) return 0;

  let reaped = 0;
  for (const o of orphans) {
    try {
      if (o.imageRef && !protectedRefs.has(o.imageRef)) {
        const rm = await runner.remove(o.imageRef);
        if (!rm.ok) {
          logger.warn(
            { envTemplateId: o.id, imageRef: o.imageRef, stderr: rm.stderr },
            'orphan env image removal failed (left in place)',
          );
        }
      }
      await db.delete(schema.envTemplates).where(eq(schema.envTemplates.id, o.id));
      reaped += 1;
    } catch (err) {
      logger.warn({ err, envTemplateId: o.id }, 'orphan env template reap failed');
    }
  }
  if (reaped > 0) {
    logger.info({ reaped, candidates: candidates.length }, 'orphan env templates reaped');
  }
  return reaped;
}
