import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import { logger } from '@haive/shared';
import {
  embedQuery,
  ragHybridSearch,
  resolveRagConnection,
  verifyRagToken,
  type RagConnection,
  type RagMode,
  type RagToolingPrefs,
} from '@haive/shared/rag';
import { getDb } from '../db.js';
import { HttpError, type AppEnv } from '../context.js';

const log = logger.child({ module: 'rag-routes' });

interface ToolingShape {
  tooling?: {
    ragMode?: string;
    ragConnectionString?: string;
    ollamaUrl?: string;
    embeddingModel?: string;
    embeddingDimensions?: number;
  };
}

function prefsFromTooling(output: unknown): RagToolingPrefs {
  const t = (output as ToolingShape | null)?.tooling ?? {};
  return {
    ragMode: (t.ragMode ?? 'none') as RagMode,
    ragConnectionString: t.ragConnectionString || null,
    ollamaUrl: t.ollamaUrl || null,
    embeddingModel: t.embeddingModel || null,
    embeddingDimensions: typeof t.embeddingDimensions === 'number' ? t.embeddingDimensions : 2560,
  };
}

/** RAG retrieval for sandbox CLI agents via the haive-rag MCP proxy.
 *  Auth is a task-scoped bearer token (not a user session): the proxy holds
 *  no DB credentials and can only query its own task's project. */
export const ragRoutes = new Hono<AppEnv>();

ragRoutes.post('/search', async (c) => {
  const secret = process.env.CONFIG_ENCRYPTION_KEY;
  if (!secret) throw new HttpError(500, 'server misconfigured: CONFIG_ENCRYPTION_KEY unset');

  const authHeader = c.req.header('Authorization') ?? '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  const verified = token ? verifyRagToken(token, secret) : null;
  if (!verified) throw new HttpError(401, 'invalid or missing rag token');
  const { taskId } = verified;

  const body = (await c.req.json().catch(() => null)) as {
    query?: unknown;
    top_k?: unknown;
  } | null;
  const query = typeof body?.query === 'string' ? body.query.trim() : '';
  if (query.length === 0) throw new HttpError(400, 'query is required');
  const topK =
    typeof body?.top_k === 'number' && Number.isInteger(body.top_k) && body.top_k > 0
      ? Math.min(body.top_k, 50)
      : undefined;

  const db = getDb();

  const toolingStep = await db.query.taskSteps.findFirst({
    where: and(
      eq(schema.taskSteps.taskId, taskId),
      eq(schema.taskSteps.stepId, '04-tooling-infrastructure'),
    ),
    columns: { output: true },
  });
  const prefs = prefsFromTooling(toolingStep?.output);
  if (prefs.ragMode === 'none') return c.json({ hits: [] });

  const envStep = await db.query.taskSteps.findFirst({
    where: and(eq(schema.taskSteps.taskId, taskId), eq(schema.taskSteps.stepId, '01-env-detect')),
    columns: { detectOutput: true },
  });
  const projectName =
    (envStep?.detectOutput as { data?: { project?: { name?: string } } } | null)?.data?.project
      ?.name ?? 'default';

  let conn: RagConnection | null = null;
  try {
    conn = await resolveRagConnection(prefs, db, projectName);
    if (!conn) return c.json({ hits: [] });
    const vec = await embedQuery(query, {
      ollamaUrl: prefs.ollamaUrl,
      model: prefs.embeddingModel,
      dimensions: prefs.embeddingDimensions,
    });
    const hits = await ragHybridSearch(conn, vec, query, topK ? { topK } : {});
    return c.json({ hits });
  } catch (err) {
    log.error({ err, taskId, projectName }, 'rag search failed');
    throw new HttpError(500, 'rag search failed');
  } finally {
    if (conn) await conn.close().catch(() => {});
  }
});
