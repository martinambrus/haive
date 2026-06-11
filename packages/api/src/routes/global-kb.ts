import { z } from 'zod';
import { Hono } from 'hono';
import { and, desc, eq, type SQL } from 'drizzle-orm';
import { GLOBAL_KB_JOB_NAMES, type GlobalKbSyncJobPayload } from '@haive/shared';
import {
  globalKbEntries,
  withGlobalKb,
  type GlobalKbFacets,
  type GlobalKbStatus,
} from '@haive/shared/global-kb';
import { getDb } from '../db.js';
import { getGlobalKbSyncQueue } from '../queues.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { HttpError, type AppEnv } from '../context.js';

// Global KB is instance/namespace-scoped (not per-user), so authoring is
// admin-only by default (plan §2 Authorization note). The corpus lives in a
// SEPARATE database reached via withGlobalKb; getDb() is the main DB, needed only
// to CREATE the dedicated DB in internal mode.
const CATEGORIES = [
  'general',
  'tech_pattern',
  'anti_pattern',
  'best_practice',
  'quick_reference',
] as const;

const facetsSchema = z
  .object({
    framework: z.array(z.string()).optional(),
    language: z.array(z.string()).optional(),
    phpMajor: z.array(z.string()).optional(),
    nodeMajor: z.array(z.string()).optional(),
    packages: z.array(z.string()).optional(),
    tags: z.array(z.string()).optional(),
  })
  .strict();

const createSchema = z.object({
  title: z.string().min(1).max(300),
  body: z.string().min(1),
  category: z.enum(CATEGORIES),
  facets: facetsSchema.optional(),
  namespace: z.string().min(1).max(120).optional(),
  status: z.enum(['draft', 'active']).optional(),
  seedText: z.string().optional(),
});

const updateSchema = z
  .object({
    title: z.string().min(1).max(300),
    body: z.string().min(1),
    category: z.enum(CATEGORIES),
    facets: facetsSchema,
    status: z.enum(['draft', 'active', 'archived']),
  })
  .partial();

async function enqueueSync(
  entryId: string,
  namespace: string,
  reason: 'upsert' | 'delete',
): Promise<void> {
  await getGlobalKbSyncQueue().add(
    GLOBAL_KB_JOB_NAMES.SYNC_ENTRY,
    { entryId, namespace, reason } satisfies GlobalKbSyncJobPayload,
    { removeOnComplete: true, removeOnFail: 20 },
  );
}

export const globalKbRoutes = new Hono<AppEnv>();

globalKbRoutes.use('*', requireAuth);
globalKbRoutes.use('*', requireAdmin);

globalKbRoutes.get('/entries', async (c) => {
  const namespace = c.req.query('namespace');
  const status = c.req.query('status');
  const entries = await withGlobalKb(getDb(), async ({ db }) => {
    const conds: SQL[] = [];
    if (namespace) conds.push(eq(globalKbEntries.namespace, namespace));
    if (status) conds.push(eq(globalKbEntries.status, status as GlobalKbStatus));
    const base = db.select().from(globalKbEntries);
    const filtered = conds.length ? base.where(and(...conds)) : base;
    return filtered.orderBy(desc(globalKbEntries.updatedAt));
  });
  return c.json({ entries });
});

globalKbRoutes.get('/entries/:id', async (c) => {
  const id = c.req.param('id');
  const entry = await withGlobalKb(getDb(), async ({ db }) =>
    db.query.globalKbEntries.findFirst({ where: eq(globalKbEntries.id, id) }),
  );
  if (!entry) throw new HttpError(404, 'global KB entry not found');
  return c.json({ entry });
});

globalKbRoutes.post('/entries', async (c) => {
  const parsed = createSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new HttpError(400, 'invalid global KB entry', 'invalid_body');
  const data = parsed.data;
  const userId = c.get('userId');

  const entry = await withGlobalKb(getDb(), async ({ db, settings }) => {
    const [row] = await db
      .insert(globalKbEntries)
      .values({
        namespace: data.namespace || settings.namespace,
        userId,
        title: data.title,
        seedText: data.seedText ?? null,
        body: data.body,
        category: data.category,
        facets: (data.facets ?? {}) as GlobalKbFacets,
        status: data.status ?? 'draft',
        source: 'user',
        embedStatus: 'pending',
      })
      .returning();
    return row!;
  });

  await enqueueSync(entry.id, entry.namespace, 'upsert');
  return c.json({ entry }, 201);
});

globalKbRoutes.patch('/entries/:id', async (c) => {
  const id = c.req.param('id');
  const parsed = updateSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new HttpError(400, 'invalid update', 'invalid_body');
  const data = parsed.data;
  if (Object.keys(data).length === 0) throw new HttpError(400, 'no fields to update');

  const entry = await withGlobalKb(getDb(), async ({ db }) => {
    const set: Partial<typeof globalKbEntries.$inferInsert> = { updatedAt: new Date() };
    if (data.title !== undefined) set.title = data.title;
    if (data.body !== undefined) set.body = data.body;
    if (data.category !== undefined) set.category = data.category;
    if (data.facets !== undefined) set.facets = data.facets as GlobalKbFacets;
    if (data.status !== undefined) set.status = data.status;
    // Content/scope/status edits need a re-embed.
    if (data.body !== undefined || data.facets !== undefined || data.status !== undefined) {
      set.embedStatus = 'pending';
    }
    const [row] = await db
      .update(globalKbEntries)
      .set(set)
      .where(eq(globalKbEntries.id, id))
      .returning();
    return row;
  });

  if (!entry) throw new HttpError(404, 'global KB entry not found');
  await enqueueSync(entry.id, entry.namespace, 'upsert');
  return c.json({ entry });
});

// Soft-delete = archive (plan §8: prefer archived over hard delete for a corpus
// that may be central/shared). The sync job removes the entry's vectors because
// it is no longer `active`.
globalKbRoutes.delete('/entries/:id', async (c) => {
  const id = c.req.param('id');
  const entry = await withGlobalKb(getDb(), async ({ db }) => {
    const now = new Date();
    const [row] = await db
      .update(globalKbEntries)
      .set({ status: 'archived', supersededAt: now, updatedAt: now })
      .where(eq(globalKbEntries.id, id))
      .returning();
    return row;
  });
  if (!entry) throw new HttpError(404, 'global KB entry not found');
  await enqueueSync(entry.id, entry.namespace, 'upsert');
  return c.json({ entry });
});
