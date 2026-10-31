import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { schema } from '@haive/database';
import { getDb } from '../db.js';
import { HttpError, type AppEnv } from '../context.js';
import { readHaiveDataStatus } from '../lib/haive-data-status.js';
import { requireAuth } from '../middleware/auth.js';

export const haiveDataRoutes = new Hono<AppEnv>();

haiveDataRoutes.use('*', requireAuth);

/** 404 unless the repository exists and belongs to the caller. Named columns only: a repository row
 *  also carries the tooling and environment mirrors, which hold credentials (T437). */
async function requireOwnedRepo(c: {
  get: (k: 'userId') => string;
  req: { param: (k: string) => string };
}) {
  const [repo] = await getDb()
    .select({
      id: schema.repositories.id,
      storagePath: schema.repositories.storagePath,
      localPath: schema.repositories.localPath,
      rootClaimedAt: schema.repositories.rootClaimedAt,
    })
    .from(schema.repositories)
    .where(
      and(
        eq(schema.repositories.id, c.req.param('id')),
        eq(schema.repositories.userId, c.get('userId')),
      ),
    );
  if (!repo) throw new HttpError(404, 'Repository not found');
  return repo;
}

/** What the Haive data page shows, and the holds a Save and a Save and push would meet. Read-only:
 *  nothing is queued and no lock is taken, so the answer can be a step behind the worker's check. */
haiveDataRoutes.get('/:id/haive-data', async (c) => {
  const repo = await requireOwnedRepo(c);
  return c.json(await readHaiveDataStatus(getDb(), repo));
});
