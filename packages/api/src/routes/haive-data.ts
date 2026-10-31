import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { schema } from '@haive/database';
import { haiveDataSaveRequestSchema } from '@haive/shared/haive-data';
import { scrubErrorPaths } from '@haive/shared/logger';
import { getDb } from '../db.js';
import { HttpError, type AppEnv } from '../context.js';
import { readHaiveDataStatus } from '../lib/haive-data-status.js';
import { requireJsonObject } from '../lib/json-object.js';
import { saveHaiveData } from '../lib/plan-mirror.js';
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

/** Save, or Save and push, the Haive data. Synchronous: it answers when the worker has, with the
 *  result of every outcome, a refusal and a failure included. Whether the Save may go ahead is
 *  decided by the worker's locked check alone, not here. */
haiveDataRoutes.post('/:id/haive-data/save', async (c) => {
  const repo = await requireOwnedRepo(c);
  // Not caught: a body that is not JSON is answered 400 by `jsonBodyErrors`, where `{}` would be a
  // Save nobody asked for (T456).
  const body = haiveDataSaveRequestSchema.parse(requireJsonObject(await c.req.json()));
  try {
    return c.json(
      await saveHaiveData({
        repositoryId: repo.id,
        userId: c.get('userId'),
        push: body.push,
        ...(body.commitMessage ? { commitMessage: body.commitMessage } : {}),
      }),
    );
  } catch (err) {
    throw new HttpError(409, scrubErrorPaths(err), 'data_save_failed');
  }
});
