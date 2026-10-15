import { Hono } from 'hono';
import { z } from 'zod';
import { and, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { schema } from '@haive/database';
import { getDb, type Database } from '../db.js';
import { requireOwnConnections } from '../lib/integration-choice.js';
import { requireAuth } from '../middleware/auth.js';
import { HttpError, type AppEnv } from '../context.js';

const allowListSchema = z.object({
  restricted: z.boolean(),
  connectionIds: z.array(z.string().uuid()).max(100),
});

export const repositoryIntegrationRoutes = new Hono<AppEnv>();
repositoryIntegrationRoutes.use('*', requireAuth);

const entries = (repositoryId: string) =>
  and(
    eq(schema.integrationGrants.targetKind, 'repository'),
    eq(schema.integrationGrants.repositoryId, repositoryId),
    isNull(schema.integrationGrants.categoryId),
  );

async function requireOwnedRepository(db: Database, repositoryId: string, userId: string) {
  const [repository] = await db
    .select({ restricted: schema.repositories.integrationsRestricted })
    .from(schema.repositories)
    .where(and(eq(schema.repositories.id, repositoryId), eq(schema.repositories.userId, userId)));
  if (!repository) throw new HttpError(404, 'Repository not found');
  return repository;
}

repositoryIntegrationRoutes.get('/:id/integrations', async (c) => {
  const repositoryId = c.req.param('id');
  const db = getDb();
  const { restricted } = await requireOwnedRepository(db, repositoryId, c.get('userId'));
  const grants = await db
    .select({ connectionId: schema.integrationGrants.connectionId })
    .from(schema.integrationGrants)
    .where(entries(repositoryId));
  return c.json({ restricted, connectionIds: grants.map((grant) => grant.connectionId) });
});

repositoryIntegrationRoutes.put('/:id/integrations', async (c) => {
  const userId = c.get('userId');
  const repositoryId = c.req.param('id');
  const body = allowListSchema.parse(await c.req.json());
  const db = getDb();
  await requireOwnedRepository(db, repositoryId, userId);
  const wanted = new Set(body.connectionIds);
  await requireOwnConnections(db, userId, [...wanted]);

  await db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`integration-allow-list:${repositoryId}`}, 0))`,
    );
    const current = new Set(
      (
        await tx
          .select({ connectionId: schema.integrationGrants.connectionId })
          .from(schema.integrationGrants)
          .where(entries(repositoryId))
      ).map((grant) => grant.connectionId),
    );
    const removed = [...current].filter((id) => !wanted.has(id));
    const added = [...wanted].filter((id) => !current.has(id));
    if (removed.length > 0) {
      await tx
        .delete(schema.integrationGrants)
        .where(and(entries(repositoryId), inArray(schema.integrationGrants.connectionId, removed)));
    }
    if (added.length > 0) {
      await tx
        .insert(schema.integrationGrants)
        .values(
          added.map((connectionId) => ({
            targetKind: 'repository' as const,
            repositoryId,
            connectionId,
          })),
        )
        .onConflictDoNothing();
    }
    await tx
      .update(schema.repositories)
      .set({ integrationsRestricted: body.restricted, updatedAt: new Date() })
      .where(
        and(
          eq(schema.repositories.id, repositoryId),
          ne(schema.repositories.integrationsRestricted, body.restricted),
        ),
      );
  });
  return c.json({ restricted: body.restricted, connectionIds: [...wanted] });
});
