import { Hono } from 'hono';
import { and, desc, eq, ilike } from 'drizzle-orm';
import { z } from 'zod';
import { schema } from '@haive/database';
import { formatRagHits, type RagSearchHit } from '@haive/shared/rag';
import { getDb } from '../db.js';
import { HttpError, type AppEnv } from '../context.js';
import { requireAuth } from '../middleware/auth.js';
import { executeRagSearch } from './rag.js';

export const ragPlaygroundRoutes = new Hono<AppEnv>();
ragPlaygroundRoutes.use('*', requireAuth);

function uuid(value: string): string {
  if (!z.uuid().safeParse(value).success) throw new HttpError(400, 'Invalid identifier');
  return value;
}

function pageOffset(value: string | undefined): number {
  const page = Number(value ?? 1);
  if (!Number.isSafeInteger(page) || page < 1 || page > 100_000)
    throw new HttpError(400, 'Invalid page');
  return (page - 1) * 30;
}

async function ownTask(taskId: string, userId: string) {
  const task = await getDb().query.tasks.findFirst({
    where: and(eq(schema.tasks.id, taskId), eq(schema.tasks.userId, userId)),
    columns: { id: true, title: true },
  });
  if (!task) throw new HttpError(404, 'Task not found');
  return task;
}

// Minimal, paginated task choices; this surface always stays personal, including for admins.
ragPlaygroundRoutes.get('/tasks', async (c) => {
  const q = c.req.query('q')?.trim();
  const tasks = await getDb()
    .select({ id: schema.tasks.id, title: schema.tasks.title })
    .from(schema.tasks)
    .where(
      and(
        eq(schema.tasks.userId, c.get('userId')),
        q ? ilike(schema.tasks.title, `%${q}%`) : undefined,
      ),
    )
    .orderBy(desc(schema.tasks.createdAt), desc(schema.tasks.id))
    .limit(31)
    .offset(pageOffset(c.req.query('page')));
  return c.json({ tasks: tasks.slice(0, 30), hasMore: tasks.length > 30 });
});

ragPlaygroundRoutes.get('/tasks/:taskId/queries', async (c) => {
  const taskId = uuid(c.req.param('taskId'));
  const task = await ownTask(taskId, c.get('userId'));
  const queries = await getDb()
    .select({
      id: schema.ragQueryLog.id,
      query: schema.ragQueryLog.query,
      topK: schema.ragQueryLog.topK,
      usageAssessment: schema.ragQueryLog.usageAssessment,
      hitCount: schema.ragQueryLog.hitCount,
      createdAt: schema.ragQueryLog.createdAt,
    })
    .from(schema.ragQueryLog)
    .where(eq(schema.ragQueryLog.taskId, taskId))
    .orderBy(desc(schema.ragQueryLog.createdAt), desc(schema.ragQueryLog.id))
    .limit(31)
    .offset(pageOffset(c.req.query('page')));
  return c.json({ task, queries: queries.slice(0, 30), hasMore: queries.length > 30 });
});

ragPlaygroundRoutes.get('/queries/:queryId', async (c) => {
  const queryId = uuid(c.req.param('queryId'));
  const [row] = await getDb()
    .select({
      id: schema.ragQueryLog.id,
      taskId: schema.ragQueryLog.taskId,
      taskTitle: schema.tasks.title,
      hitCount: schema.ragQueryLog.hitCount,
      query: schema.ragQueryLog.query,
      topK: schema.ragQueryLog.topK,
      createdAt: schema.ragQueryLog.createdAt,
      resultHits: schema.ragQueryLog.resultHits,
      usageAssessment: schema.ragQueryLog.usageAssessment,
    })
    .from(schema.ragQueryLog)
    .innerJoin(schema.tasks, eq(schema.ragQueryLog.taskId, schema.tasks.id))
    .where(and(eq(schema.ragQueryLog.id, queryId), eq(schema.tasks.userId, c.get('userId'))));
  if (!row) throw new HttpError(404, 'RAG query not found');
  const { resultHits, ...query } = row;
  return c.json({
    ...query,
    hits: resultHits,
    text: resultHits === null ? null : formatRagHits(resultHits as RagSearchHit[]),
  });
});

const searchInput = z.object({
  taskId: z.uuid(),
  query: z.string().trim().min(1).max(10_000),
  top_k: z.number().int().min(1).max(50).optional(),
});

ragPlaygroundRoutes.post('/search', async (c) => {
  const parsed = searchInput.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success)
    throw new HttpError(400, 'Provide a task, a query, and a result limit from 1 to 50');
  const { taskId, query, top_k } = parsed.data;
  await ownTask(taskId, c.get('userId'));
  const hits = await executeRagSearch(taskId, query, top_k);
  return c.json({ hits, text: formatRagHits(hits) });
});
