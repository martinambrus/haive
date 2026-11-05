import { and, eq, inArray, sql } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import { MODULE_SOURCE_JOB_NAMES, secretsService } from '@haive/shared';
import type { Queue } from 'bullmq';
import { fetchModuleSource, sourceFetchError } from './source-fetch.js';
import { pinModuleTree } from './source-pin.js';

export async function runModuleSourceFetch(
  db: Database,
  sourceId: string,
  requestedAt?: string,
): Promise<void> {
  let token: string | null = null;
  let claimedAt: Date | undefined;
  try {
    await db.transaction(async (lock) => {
      const held = await lock.execute(
        sql`SELECT pg_try_advisory_xact_lock(hashtext(${'module-source:' + sourceId})) AS held`,
      );
      if (!held[0]?.held) return;
      const [source] = await db
        .update(schema.moduleSources)
        .set({ fetchStatus: 'fetching', lastError: null })
        .where(
          and(
            eq(schema.moduleSources.id, sourceId),
            inArray(schema.moduleSources.fetchStatus, ['queued', 'fetching']),
            requestedAt ? eq(schema.moduleSources.updatedAt, new Date(requestedAt)) : undefined,
          ),
        )
        .returning();
      if (!source) return;
      claimedAt = source.updatedAt;
      const identity = and(
        eq(schema.moduleSources.id, sourceId),
        eq(schema.moduleSources.updatedAt, source.updatedAt),
        eq(schema.moduleSources.fetchStatus, 'fetching'),
      );
      token = await secretsService.getFresh('module_source:' + source.id + ':token');
      const sha = await fetchModuleSource(
        source,
        token,
        async (tree, hostDir, moduleId) => {
          const [current] = await lock
            .select()
            .from(schema.moduleSources)
            .where(identity)
            .for('update');
          if (!current) throw new Error('Module fetch request was superseded');
          await pinModuleTree(tree, hostDir, moduleId);
        },
        async (resolvedSha) => {
          const changed = await db
            .update(schema.moduleSources)
            .set({ resolvedSha })
            .where(identity)
            .returning({ id: schema.moduleSources.id });
          if (!changed.length) throw new Error('Module fetch request was superseded');
        },
      );
      await lock
        .update(schema.moduleSources)
        .set({ fetchStatus: 'pinned', resolvedSha: sha, fetchedAt: new Date(), lastError: null })
        .where(identity);
    });
  } catch (error) {
    const message = sourceFetchError(error, token);
    if (claimedAt)
      await db
        .update(schema.moduleSources)
        .set({ fetchStatus: 'failed', lastError: message })
        .where(
          and(
            eq(schema.moduleSources.id, sourceId),
            eq(schema.moduleSources.updatedAt, claimedAt),
            eq(schema.moduleSources.fetchStatus, 'fetching'),
          ),
        );
    throw new Error(message);
  }
}

export async function recoverModuleSourceFetches(
  db: Database,
  queue: Pick<Queue, 'add'>,
): Promise<void> {
  if (process.env.HAIVE_PUBLISHED_INSTALL !== 'true') return;
  const rows = await db
    .select({
      id: schema.moduleSources.id,
      moduleId: schema.moduleSources.moduleId,
      updatedAt: schema.moduleSources.updatedAt,
    })
    .from(schema.moduleSources)
    .where(inArray(schema.moduleSources.fetchStatus, ['queued', 'fetching']));
  for (const source of rows)
    await queue.add(
      MODULE_SOURCE_JOB_NAMES.FETCH,
      {
        sourceId: source.id,
        moduleId: source.moduleId,
        requestedAt: source.updatedAt.toISOString(),
      },
      {
        jobId: 'source-' + source.id + '-' + source.updatedAt.getTime(),
        removeOnComplete: true,
        removeOnFail: true,
      },
    );
}
