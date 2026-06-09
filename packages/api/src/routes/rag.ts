import { Hono } from 'hono';
import { and, desc, eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import { logger } from '@haive/shared';
import {
  embedQuery,
  ragHybridSearch,
  resolveRagConnection,
  verifyRagToken,
  type RagConnection,
  type RagMode,
  type RagSearchHit,
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

/** Resolve RAG prefs (ragMode/connection) + project name for a task. Workflow
 *  tasks have no 04-tooling-infrastructure / 01-env-detect steps of their own,
 *  so fall back to the repo's most recent onboarding run (mirrors the
 *  02-pre-rag-sync detect resolution). Without this, ragMode resolves to 'none'
 *  and projectName to 'default' → empty hits / wrong DB for every workflow task. */
async function resolveTaskRagContext(
  db: ReturnType<typeof getDb>,
  taskId: string,
): Promise<{ prefs: RagToolingPrefs; projectName: string }> {
  let toolingOutput = (
    await db.query.taskSteps.findFirst({
      where: and(
        eq(schema.taskSteps.taskId, taskId),
        eq(schema.taskSteps.stepId, '04-tooling-infrastructure'),
      ),
      columns: { output: true },
    })
  )?.output;
  let envDetect = (
    await db.query.taskSteps.findFirst({
      where: and(eq(schema.taskSteps.taskId, taskId), eq(schema.taskSteps.stepId, '01-env-detect')),
      columns: { detectOutput: true },
    })
  )?.detectOutput;

  if (!toolingOutput || !envDetect) {
    const task = await db.query.tasks.findFirst({
      where: eq(schema.tasks.id, taskId),
      columns: { repositoryId: true },
    });
    if (task?.repositoryId) {
      const onboarding = await db.query.tasks.findFirst({
        where: and(
          eq(schema.tasks.repositoryId, task.repositoryId),
          eq(schema.tasks.type, 'onboarding'),
        ),
        orderBy: [desc(schema.tasks.createdAt)],
        columns: { id: true },
      });
      if (onboarding) {
        if (!toolingOutput) {
          toolingOutput = (
            await db.query.taskSteps.findFirst({
              where: and(
                eq(schema.taskSteps.taskId, onboarding.id),
                eq(schema.taskSteps.stepId, '04-tooling-infrastructure'),
              ),
              columns: { output: true },
            })
          )?.output;
        }
        if (!envDetect) {
          envDetect = (
            await db.query.taskSteps.findFirst({
              where: and(
                eq(schema.taskSteps.taskId, onboarding.id),
                eq(schema.taskSteps.stepId, '01-env-detect'),
              ),
              columns: { detectOutput: true },
            })
          )?.detectOutput;
        }
      }
    }
  }

  const projectName =
    (envDetect as { data?: { project?: { name?: string } } } | null)?.data?.project?.name ??
    'default';
  return { prefs: prefsFromTooling(toolingOutput), projectName };
}

/** Best-effort telemetry: one rag_query_log row per search (incl. zero-hit
 *  queries) with the KB-vs-code split + top scores. Never fails the search. */
async function logRagQuery(
  db: ReturnType<typeof getDb>,
  taskId: string,
  query: string,
  topK: number | null,
  hits: RagSearchHit[],
): Promise<void> {
  try {
    await db.insert(schema.ragQueryLog).values({
      taskId,
      query,
      topK,
      hitCount: hits.length,
      kbHits: hits.filter((h) => h.sourceType === 'kb').length,
      codeHits: hits.filter((h) => h.sourceType === 'code').length,
      maxRrf: hits.reduce((m, h) => Math.max(m, h.rrf), 0),
      maxDense: hits.reduce((m, h) => Math.max(m, h.denseSim), 0),
    });
  } catch (err) {
    log.warn({ err, taskId }, 'failed to log rag query');
  }
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

  const { prefs, projectName } = await resolveTaskRagContext(db, taskId);
  if (prefs.ragMode === 'none') return c.json({ hits: [] });

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
    await logRagQuery(db, taskId, query, topK ?? null, hits);
    return c.json({ hits });
  } catch (err) {
    log.error({ err, taskId, projectName }, 'rag search failed');
    throw new HttpError(500, 'rag search failed');
  } finally {
    if (conn) await conn.close().catch(() => {});
  }
});
