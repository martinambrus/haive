import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { isUndefinedTable, schema } from '@haive/database';
import { CONFIG_KEYS, configService, logger } from '@haive/shared';
import {
  DEFAULT_RAG_SEARCH_CONFIG,
  RUNBOOK_BOOST_BUGFIX,
  RUNBOOK_BOOST_FEATURE,
  embedQuery,
  applyKnowledgeReserve,
  embedQueryOrNull,
  ragHybridSearch,
  resolveRagConnection,
  verifyRagToken,
  type RagConnection,
  type RagMode,
  type RagSearchHit,
  type RagToolingPrefs,
} from '@haive/shared/rag';
import {
  confirmedStackValues,
  extractProjectFacets,
  resolveTaskStackContext,
  withGlobalKb,
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
 *  for a task. The step-output resolution (including the fall back to the repo's
 *  most recent onboarding run, without which ragMode resolves to 'none' and
 *  projectName to 'default' for every workflow task) lives in
 *  resolveTaskStackContext, shared with the worker's global KB digest so both
 *  scope the GLOBAL KB by the same facet set. */
async function resolveTaskRagContext(
  db: ReturnType<typeof getDb>,
  taskId: string,
): Promise<{
  prefs: RagToolingPrefs;
  projectName: string;
  facets: ProjectFacetSet;
  repositoryId: string | null;
}> {
  const { repositoryId, toolingOutput, envDetect, confirmedOutput } = await resolveTaskStackContext(
    db,
    taskId,
  );

  const projectName =
    (envDetect as { data?: { project?: { name?: string } } } | null)?.data?.project?.name ??
    'default';
  return {
    prefs: prefsFromTooling(toolingOutput),
    projectName,
    facets: extractProjectFacets(envDetect, confirmedStackValues(confirmedOutput)),
    repositoryId,
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
export function mergeHits(
  local: RagSearchHit[],
  global: RagSearchHit[],
  topK: number,
): RagSearchHit[] {
  const byRrf = (a: RagSearchHit, b: RagSearchHit): number => b.rrf - a.rrf;
  const gSorted = [...global].sort(byRrf);
  const lSorted = [...local].sort(byRrf);
  const globalCap = Math.floor(topK / 2);
  const selGlobal = gSorted.slice(0, globalCap);
  // Trimming the local page to make room for the global KB must honour the same
  // knowledge quota the search itself applied, or the reserve dies here: a promoted
  // knowledge hit carries the low `rrf` that got it cut in the first place, so a
  // plain rrf slice drops it FIRST. Identical to a plain slice for a code-only page.
  const selLocal = applyKnowledgeReserve(lSorted, {
    topK: Math.max(0, topK - selGlobal.length),
    knowledgeReserve: DEFAULT_RAG_SEARCH_CONFIG.knowledgeReserve,
    knowledgeReserveRatio: DEFAULT_RAG_SEARCH_CONFIG.knowledgeReserveRatio,
  });
  // Slots local did not fill go back to global (the reverse is already handled by
  // sizing selLocal off selGlobal.length). Without this a repo whose local index
  // is not built yet got half a page of global KB hits: the reserve was a floor
  // for global, never a ceiling on what it may fill when local is short.
  const spare = Math.max(0, topK - selLocal.length - selGlobal.length);
  if (spare > 0) selGlobal.push(...gSorted.slice(globalCap, globalCap + spare));
  return [...selLocal, ...selGlobal].sort(byRrf);
}

/** Per-response budget for expanding global KB hits from a chunk to the whole
 *  entry. A tuning constant, not a config key — the kill switch is
 *  GLOBAL_KB_ENABLED, the size is tuning (same split as the digest's title cap).
 *  Sized against the corpus it serves: MEASURED, the median active entry is
 *  ~3.3 KB and p90 ~6 KB, so a default top_k=8 page expands roughly every global
 *  slot it reserves. */
const GLOBAL_KB_EXPAND_BUDGET_CHARS = 12_000;

/** One global KB entry, keyed by the source path its chunks carry. */
export interface GlobalKbEntryBody {
  title: string;
  body: string;
}

/** Collapse a global result set to ONE hit per entry, keeping each entry's
 *  best-scoring chunk.
 *
 *  Without this a single entry's chunks can spend every slot mergeHits reserves
 *  for the global KB, so the caller reads one article four times instead of four
 *  articles. `sourcePath` is the key because the global sync writes exactly one
 *  per entry (`global_kb/<slug>-<id8>.md`) and stores it on every chunk row. */
export function dedupeGlobalByEntry(hits: RagSearchHit[]): RagSearchHit[] {
  const best = new Map<string, RagSearchHit>();
  for (const h of hits) {
    const prev = best.get(h.sourcePath);
    if (!prev || h.rrf > prev.rrf) best.set(h.sourcePath, h);
  }
  return [...best.values()].sort((a, b) => b.rrf - a.rrf);
}

/** Replace each surviving global hit's CHUNK with its entry's full body, highest
 *  score first, while the response budget allows.
 *
 *  The global KB has exactly one door — `rag_search` — and the `sourcePath` its
 *  hits carry is SYNTHETIC: no such file exists in the sandbox, so an agent
 *  holding a partial global hit has no second way to read the rest. That made a
 *  partial hit a dead end by construction, and the prompt digest sends agents
 *  straight into it ("call `rag_search` with a title to read the entry behind
 *  it"). Observed on task 201dfef3: a title query returned the entry's bare
 *  heading, three re-queries returned the same heading, and the agent correctly
 *  refused to author a merge it could not ground.
 *
 *  The BEST-scoring entry expands whatever it costs; the budget bounds only the
 *  tail. Budgeting it too would leave the largest entries permanently
 *  unreadable — the corpus already holds one body bigger than the whole budget —
 *  which is the exact promise ("call rag_search with a title to read the entry")
 *  this exists to keep. Beyond the first, an entry the budget cannot fit keeps
 *  its chunk and is LABELLED a snippet rather than passing for the whole
 *  article: the failure being fixed was a partial that looked complete. */
export function expandGlobalHits(
  hits: RagSearchHit[],
  bodies: Map<string, GlobalKbEntryBody>,
  budget = GLOBAL_KB_EXPAND_BUDGET_CHARS,
): RagSearchHit[] {
  let remaining = budget;
  let expanded = 0;
  return hits.map((h) => {
    if (h.scope !== 'global') return h;
    const entry = bodies.get(h.sourcePath);
    if (!entry) return h;
    const full = `[${entry.title} — FULL ENTRY]\n\n${entry.body}`;
    if (expanded === 0 || full.length <= remaining) {
      remaining = Math.max(0, remaining - full.length);
      expanded += 1;
      // sectionId is cleared: a whole-entry hit anchors to no single section,
      // and the proxy renders '#<sectionId>' only when it is set.
      return { ...h, sectionId: '', content: full };
    }
    return {
      ...h,
      content:
        `${h.content}\n\n[SNIPPET ONLY — one section of a ${entry.body.length}-char entry, ` +
        `not the whole article. Query this title on its own, or with a lower top_k, ` +
        `so fewer entries share the expansion budget and this one is returned in full.]`,
    };
  });
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
  const { prefs, projectName, facets, repositoryId } = await resolveTaskRagContext(db, taskId);

  // --- Local (per-repo) search: unchanged behaviour. ragMode 'none' contributes
  // no local hits; a local failure is still a hard 500 (no facet filter here, so
  // the per-repo SQL is identical to before). ---
  let localHits: RagSearchHit[] = [];
  if (prefs.ragMode !== 'none') {
    let conn: RagConnection | null = null;
    try {
      conn = await resolveRagConnection(prefs, db, projectName);
      if (conn) {
        // Two ways to end up ranking on full text alone, and both must skip the
        // dense half rather than feed it a hash vector: the repo's owner accepted
        // lexical-only after embeddings failed (its stored vectors are hashes), or
        // this one query could not be embedded. A hash vector is noise, not a weak
        // embedding — it can push a genuine lexical hit down the fused ranking.
        const repoLexicalOnly = repositoryId
          ? ((
              await db.query.repositories.findFirst({
                where: eq(schema.repositories.id, repositoryId),
                columns: { ragEmbedLexicalOnly: true },
              })
            )?.ragEmbedLexicalOnly ?? false)
          : false;
        const queryVec = repoLexicalOnly
          ? null
          : await embedQueryOrNull(query, {
              ollamaUrl: prefs.ollamaUrl,
              model: prefs.embeddingModel,
              dimensions: prefs.embeddingDimensions,
            });
        const lexicalOnly = queryVec === null;
        const vec = queryVec ?? [];
        const runbookBoost = await resolveRunbookBoost(db, taskId);
        // Scope per-repo (internal mode) so a project-name-keyed RAG database
        // shared by co-tenant repos never returns another repo's chunks. External/
        // ddev stores are the user's own schema (may lack repository_id) — unscoped.
        const localRepoId = prefs.ragMode === 'internal' ? (repositoryId ?? undefined) : undefined;
        const hits = await ragHybridSearch(
          conn,
          vec,
          query,
          { runbookBoost, lexicalOnly, ...(topK ? { topK } : {}) },
          undefined,
          localRepoId,
        );
        localHits = hits.map((h) => ({ ...h, scope: 'local' as const }));
      }
    } catch (err) {
      // The per-project RAG database is created lazily by resolveRagConnection, but
      // ai_rag_embeddings is only created by the onboarding step 10-rag-populate.
      // Agents run LLM steps well before that (06_5-agent-discovery), so a missing
      // table means "this repo is not indexed yet", not "RAG is broken" — degrade to
      // zero local hits and still serve the global KB. Any other local failure stays
      // a loud 500: a genuinely misconfigured RAG connection must not be swallowed.
      if (isUndefinedTable(err)) {
        log.warn({ taskId, projectName }, 'local rag index not built yet; returning global-only');
      } else {
        log.error({ err, taskId, projectName }, 'local rag search failed');
        throw new HttpError(500, 'rag search failed');
      }
    } finally {
      if (conn) await conn.close().catch(() => {});
    }
  }

  // --- Global KB search: flag-gated, facet-scoped, and fully isolated — its
  // failure must never break per-repo retrieval (plan §6.4). ---
  let globalHits: RagSearchHit[] = [];
  let globalBodies = new Map<string, GlobalKbEntryBody>();
  const globalEnabled = await configService.getBoolean(CONFIG_KEYS.GLOBAL_KB_ENABLED, true);
  if (globalEnabled) {
    try {
      const result = await withGlobalKb(db, async ({ conn, settings }) => {
        const gvec = await embedQuery(query, {
          ollamaUrl: settings.ollamaUrl,
          model: settings.embedModel,
          dimensions: settings.embeddingDimensions,
        });
        const raw = await ragHybridSearch(conn, gvec, query, topK ? { topK } : {}, {
          namespace: settings.namespace,
          facets,
        });
        const scoped = dedupeGlobalByEntry(raw.map((h) => ({ ...h, scope: 'global' as const })));
        // Bodies for the entries that survived dedup, fetched on the SAME
        // connection this block already holds (withGlobalKb opens and closes one
        // per call). Numbered placeholders rather than `= ANY($2)` so the bind
        // does not depend on array-type inference.
        const bodies = new Map<string, GlobalKbEntryBody>();
        if (scoped.length > 0) {
          const paths = scoped.map((h) => h.sourcePath);
          const placeholders = paths.map((_, i) => `$${i + 2}`).join(', ');
          const rows = (await conn.pg.unsafe(
            `SELECT DISTINCT ON (r.source_path) r.source_path, e.title, e.body
               FROM ai_rag_embeddings r
               JOIN global_kb_entries e ON e.id = r.entry_id
              WHERE r.namespace = $1 AND r.source_path IN (${placeholders})`,
            [settings.namespace, ...paths],
          )) as unknown as Array<{ source_path: string; title: string; body: string }>;
          for (const row of rows) bodies.set(row.source_path, { title: row.title, body: row.body });
        }
        return { scoped, bodies };
      });
      globalHits = result.scoped;
      globalBodies = result.bodies;
    } catch (err) {
      log.warn({ err, taskId }, 'global KB search failed; returning local-only');
      globalHits = [];
      globalBodies = new Map();
    }
  }

  const hits = expandGlobalHits(mergeHits(localHits, globalHits, effectiveTopK), globalBodies);
  await logRagQuery(db, taskId, query, topK ?? null, hits);
  return c.json({ hits });
});
