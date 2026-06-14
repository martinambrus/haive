import { Hono } from 'hono';
import { z } from 'zod';
import { and, desc, eq, isNull, or } from 'drizzle-orm';
import { schema } from '@haive/database';
import { envDepPresetUpsertSchema } from '@haive/shared';
import { getDb } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { HttpError, type AppEnv } from '../context.js';

export const envDepPresetRoutes = new Hono<AppEnv>();
envDepPresetRoutes.use('*', requireAuth);

/** Throw 404 unless the repository exists AND belongs to the requesting user.
 *  Presets are per-repository, so every read/write must prove repo ownership
 *  before touching preset rows. */
async function assertRepoOwned(
  db: ReturnType<typeof getDb>,
  repositoryId: string,
  userId: string,
): Promise<void> {
  const repo = await db.query.repositories.findFirst({
    where: and(eq(schema.repositories.id, repositoryId), eq(schema.repositories.userId, userId)),
    columns: { id: true },
  });
  if (!repo) throw new HttpError(404, 'Repository not found');
}

const presetColumns = {
  id: schema.envDepPresets.id,
  repositoryId: schema.envDepPresets.repositoryId,
  stepId: schema.envDepPresets.stepId,
  name: schema.envDepPresets.name,
  values: schema.envDepPresets.values,
  createdAt: schema.envDepPresets.createdAt,
  updatedAt: schema.envDepPresets.updatedAt,
} as const;

envDepPresetRoutes.get('/', async (c) => {
  const userId = c.get('userId');
  const repositoryId = z.string().uuid().parse(c.req.query('repositoryId'));
  const stepId = c.req.query('stepId') ?? '01-declare-deps';
  const db = getDb();
  await assertRepoOwned(db, repositoryId, userId);

  // This repo's presets plus the user's global (repo-less) presets for the step.
  const presets = await db
    .select(presetColumns)
    .from(schema.envDepPresets)
    .where(
      and(
        eq(schema.envDepPresets.userId, userId),
        eq(schema.envDepPresets.stepId, stepId),
        or(
          eq(schema.envDepPresets.repositoryId, repositoryId),
          isNull(schema.envDepPresets.repositoryId),
        ),
      ),
    )
    .orderBy(desc(schema.envDepPresets.updatedAt));

  return c.json({ presets });
});

envDepPresetRoutes.post('/', async (c) => {
  const userId = c.get('userId');
  const body = envDepPresetUpsertSchema.parse(await c.req.json());
  const db = getDb();
  await assertRepoOwned(db, body.repositoryId, userId);

  // Global presets carry no repository and dedupe per (user, step, name) via the
  // partial unique index; repo presets dedupe per (repo, step, name).
  const inserted = body.global
    ? await db
        .insert(schema.envDepPresets)
        .values({
          userId,
          repositoryId: null,
          stepId: body.stepId,
          name: body.name,
          values: body.values,
        })
        .onConflictDoUpdate({
          target: [
            schema.envDepPresets.userId,
            schema.envDepPresets.stepId,
            schema.envDepPresets.name,
          ],
          targetWhere: isNull(schema.envDepPresets.repositoryId),
          set: { values: body.values, updatedAt: new Date() },
        })
        .returning(presetColumns)
    : await db
        .insert(schema.envDepPresets)
        .values({
          userId,
          repositoryId: body.repositoryId,
          stepId: body.stepId,
          name: body.name,
          values: body.values,
        })
        .onConflictDoUpdate({
          target: [
            schema.envDepPresets.repositoryId,
            schema.envDepPresets.stepId,
            schema.envDepPresets.name,
          ],
          set: { values: body.values, updatedAt: new Date() },
        })
        .returning(presetColumns);

  return c.json({ preset: inserted[0] }, 201);
});

envDepPresetRoutes.delete('/:id', async (c) => {
  const userId = c.get('userId');
  const id = c.req.param('id');
  const db = getDb();
  const result = await db
    .delete(schema.envDepPresets)
    .where(and(eq(schema.envDepPresets.id, id), eq(schema.envDepPresets.userId, userId)))
    .returning({ id: schema.envDepPresets.id });
  if (result.length === 0) throw new HttpError(404, 'Template not found');
  return c.json({ ok: true });
});
