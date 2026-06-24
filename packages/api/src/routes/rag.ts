import { Hono } from 'hono';
import { and, desc, eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import { CONFIG_KEYS, configService, logger } from '@haive/shared';
import {
  DEFAULT_RAG_SEARCH_CONFIG,
  RUNBOOK_BOOST_BUGFIX,
  RUNBOOK_BOOST_FEATURE,
  embedQuery,
  ragHybridSearch,
  resolveRagConnection,
  verifyRagToken,
  type RagConnection,
  type RagMode,
  type RagSearchHit,
  type RagToolingPrefs,
} from '@haive/shared/rag';
import {
  extractProjectFacets,
  withGlobalKb,
  type ConfirmedStackValues,
  type ProjectFacetSet,
} from '@haive/shared/global-kb';
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

/** Run-book RRF boost for THIS task: bug fixes surface run-books (1.5), other tasks
 *  demote them (0.5). Mirrors the isBugBranch rule the spec agent (04) uses, so
 *  retrieval and the prompt agree on what counts as a bug fix. Neutral (1.0) only
 *  when the task row is missing. */
async function resolveRunbookBoost(db: ReturnType<typeof getDb>, taskId: string): Promise<number> {
  const row = await db.query.tasks.findFirst({
    where: eq(schema.tasks.id, taskId),
    columns: { title: true, description: true, metadata: true },
  });
  if (!row) return 1.0;
  const category = (row.metadata as { category?: string } | null)?.category ?? null;
  const isBug =
    category === 'bugfix' ||
    /\b(bug|fix|regression|hotfix|broken|crash)\b/i.test(`${row.title} ${row.description ?? ''}`);
  return isBug ? RUNBOOK_BOOST_BUGFIX : RUNBOOK_BOOST_FEATURE;
}

/** Resolve RAG prefs (ragMode/connection) + project name + the project FACET SET
 *  for a task. Workflow tasks have no 04-tooling-infrastructure / 01-env-detect
 *  steps of their own, so fall back to the repo's most recent onboarding run
 *  (mirrors the 02-pre-rag-sync detect resolution). Without this, ragMode
 *  resolves to 'none' and projectName to 'default' → empty hits / wrong DB for
 *  every workflow task. The facet set scopes the GLOBAL KB at query time. */
async function resolveTaskRagContext(
  db: ReturnType<typeof getDb>,
  taskId: string,
): Promise<{ prefs: RagToolingPrefs; projectName: string; facets: ProjectFacetSet }> {
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
  let confirmedOutput = (
    await db.query.taskSteps.findFirst({
      where: and(
        eq(schema.taskSteps.taskId, taskId),
        eq(schema.taskSteps.stepId, '02-detection-confirmation'),
      ),
      columns: { output: true },
    })
  )?.output;

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
        if (!confirmedOutput) {
          confirmedOutput = (
            await db.query.taskSteps.findFirst({
              where: and(
                eq(schema.taskSteps.taskId, onboarding.id),
                eq(schema.taskSteps.stepId, '02-detection-confirmation'),
              ),
              columns: { output: true },
            })
          )?.output;
        }
      }
    }
  }

  const projectName =
    (envDetect as { data?: { project?: { name?: string } } } | null)?.data?.project?.name ??
    'default';
  const confirmed = (confirmedOutput as { values?: ConfirmedStackValues } | null)?.values ?? null;
  return {
    prefs: prefsFromTooling(toolingOutput),
    projectName,
    facets: extractProjectFacets(envDetect, confirmed),
  };
}

/** Best-effort telemetry: one rag_query_log row per search (incl. zero-hit
 *  queries) with the KB-vs-code split, the global-vs-local split, and top
 *  scores. Never fails the search. */
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
      runbookHits: hits.filter((h) => h.sourceType === 'runbook').length,
      learningHits: hits.filter((h) => h.sourceType === 'learning').length,
      globalHits: hits.filter((h) => h.scope === 'global').length,
      maxRrf: hits.reduce((m, h) => Math.max(m, h.rrf), 0),
      maxDense: hits.reduce((m, h) => Math.max(m, h.denseSim), 0),
    });
  } catch (err) {
    log.warn({ err, taskId }, 'failed to log rag query');
  }
}

/** Merge per-repo (local) and global hits, guaranteeing the global KB a slot
 *  budget (up to half of topK) so relevant house standards always surface
 *  without drowning repo-specific code. Tunable; recalibrate with rag-eval. */
function mergeHits(local: RagSearchHit[], global: RagSearchHit[], topK: number): RagSearchHit[] {
  const byRrf = (a: RagSearchHit, b: RagSearchHit): number => b.rrf - a.rrf;
  const globalCap = Math.floor(topK / 2);
  const selGlobal = [...global].sort(byRrf).slice(0, globalCap);
  const remaining = Math.max(0, topK - selGlobal.length);
  const selLocal = [...local].sort(byRrf).slice(0, remaining);
  return [...selLocal, ...selGlobal].sort(byRrf);
}

/** RAG retrieval for sandbox CLI agents via the haive-rag MCP proxy.
 *  Auth is a task-scoped bearer token (not a user session): the proxy holds
 *  no DB credentials and can only query its own task's project + the global KB. */
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
  const effectiveTopK = topK ?? DEFAULT_RAG_SEARCH_CONFIG.topK;

  const db = getDb();
  const { prefs, projectName, facets } = await resolveTaskRagContext(db, taskId);

  // --- Local (per-repo) search: unchanged behaviour. ragMode 'none' contributes
  // no local hits; a local failure is still a hard 500 (no facet filter here, so
  // the per-repo SQL is identical to before). ---
  let localHits: RagSearchHit[] = [];
  if (prefs.ragMode !== 'none') {
    let conn: RagConnection | null = null;
    try {
      conn = await resolveRagConnection(prefs, db, projectName);
      if (conn) {
        const vec = await embedQuery(query, {
          ollamaUrl: prefs.ollamaUrl,
          model: prefs.embeddingModel,
          dimensions: prefs.embeddingDimensions,
        });
        const runbookBoost = await resolveRunbookBoost(db, taskId);
        const hits = await ragHybridSearch(conn, vec, query, {
          runbookBoost,
          ...(topK ? { topK } : {}),
        });
        localHits = hits.map((h) => ({ ...h, scope: 'local' as const }));
      }
    } catch (err) {
      log.error({ err, taskId, projectName }, 'local rag search failed');
      throw new HttpError(500, 'rag search failed');
    } finally {
      if (conn) await conn.close().catch(() => {});
    }
  }

  // --- Global KB search: flag-gated, facet-scoped, and fully isolated — its
  // failure must never break per-repo retrieval (plan §6.4). ---
  let globalHits: RagSearchHit[] = [];
  const globalEnabled = await configService.getBoolean(CONFIG_KEYS.GLOBAL_KB_ENABLED, true);
  if (globalEnabled) {
    try {
      globalHits = await withGlobalKb(db, async ({ conn, settings }) => {
        const gvec = await embedQuery(query, {
          ollamaUrl: settings.ollamaUrl,
          model: settings.embedModel,
          dimensions: settings.embeddingDimensions,
        });
        const hits = await ragHybridSearch(conn, gvec, query, topK ? { topK } : {}, {
          namespace: settings.namespace,
          facets,
        });
        return hits.map((h) => ({ ...h, scope: 'global' as const }));
      });
    } catch (err) {
      log.warn({ err, taskId }, 'global KB search failed; returning local-only');
      globalHits = [];
    }
  }

  const hits = mergeHits(localHits, globalHits, effectiveTopK);
  await logRagQuery(db, taskId, query, topK ?? null, hits);
  return c.json({ hits });
});
