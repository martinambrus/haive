import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Database } from '@haive/database';
import { logger } from '@haive/shared';
import {
  classifyGlobalKbError,
  resolveGlobalKbSettings,
  withGlobalKb,
  type GlobalKbErrorClass,
  type HouseRulesSimilarity,
  type HouseRulesStamp,
} from '@haive/shared/global-kb';
import { cosineSimilarity, ollamaEmbed, vectorLiteral } from '@haive/shared/rag';
import { DISPATCH_KB_BOUNDS, timed } from './global-kb-context.js';
import { readTaskText } from './house-rules-dispatch.js';

const log = logger.child({ module: 'house-rules-similarity' });

/** The embedding model's context is 4096 tokens; the title, description and spec opening stay well inside it. */
export const SIMILARITY_QUERY_MAX_CHARS = 2_500;

type Candidates = NonNullable<HouseRulesSimilarity['scores']>;

function failureClass(err: unknown): GlobalKbErrorClass {
  if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
    return 'timeout';
  }
  return classifyGlobalKbError(err);
}

const queryOf = (text: string): string =>
  text
    .trim()
    .slice(0, SIMILARITY_QUERY_MAX_CHARS)
    .replace(/[\uD800-\uDBFF]$/, '');

/** A jsonb store's vectors, as the driver hands them over: parsed, or still the raw text. */
function vectorOf(value: unknown): number[] | null {
  const parsed = typeof value === 'string' ? (JSON.parse(value) as unknown) : value;
  return Array.isArray(parsed) ? (parsed as number[]) : null;
}

/** The best cosine per entry, computed over the fetched vectors of a store without pgvector. */
function bestCosines(
  rows: Array<{ id: string; hash: string | null; embedding: unknown }>,
  query: number[],
): Array<{ id: string; hash: string | null; score: number }> {
  const best = new Map<string, { id: string; hash: string | null; score: number }>();
  for (const row of rows) {
    const vector = vectorOf(row.embedding);
    if (vector === null) continue;
    const score = cosineSimilarity(query, vector);
    if (score > (best.get(row.id)?.score ?? -Infinity)) {
      best.set(row.id, { id: row.id, hash: row.hash, score });
    }
  }
  return [...best.values()];
}

/** The highest cosine between the query and any row of each candidate; a rule with no vector keeps
 *  null, and one whose enforced hash is no longer the stamped one is marked stale rather than scored. */
async function measure(
  db: Database,
  taskId: string,
  candidates: Candidates,
): Promise<HouseRulesSimilarity> {
  const startedAt = Date.now();
  const query = queryOf(await readTaskText(db, taskId));
  if (query === '') throw new Error('the task has no text to compare');
  const settings = await resolveGlobalKbSettings();
  const { ollamaUrl, embedModel, embeddingDimensions } = settings;
  if (!ollamaUrl || !embedModel) throw new Error('no embedder is configured');
  // Default = ingest budget (RAG_EMBED_TIMEOUT_MS): a cold load measured 42.8 s and an abort cancels it.
  const [vector] = await ollamaEmbed(ollamaUrl, embedModel, [query]);
  if (vector?.length !== embeddingDimensions) {
    throw new Error('the query vector is not the width of the index');
  }
  const ids = `{${candidates.map((c) => c.id).join(',')}}`;
  const rows = await withGlobalKb(
    db,
    ({ db: gdb }) =>
      timed(gdb, DISPATCH_KB_BOUNDS.statementTimeoutMs, async (tx) => {
        const columns = (await tx.execute(sql`
          select 1 from information_schema.columns
          where table_name = 'ai_rag_embeddings' and column_name = 'vector'`)) as unknown as unknown[];
        if (columns.length > 0) {
          const read = await tx.execute(sql`
            select r.entry_id::text as id, e.enforced_hash as hash,
              max(1 - (r.vector <=> ${vectorLiteral(vector)}::vector)) as score
            from ai_rag_embeddings r
            join global_kb_entries e on e.id = r.entry_id
            where r.namespace = ${settings.namespace}
              and r.entry_id = any(${ids}::uuid[])
              and e.embed_status = 'embedded'
            group by r.entry_id, e.enforced_hash`);
          return read as unknown as Array<{
            id: string;
            hash: string | null;
            score: number | string;
          }>;
        }
        const read = await tx.execute(sql`
          select r.entry_id::text as id, e.enforced_hash as hash, r.embedding_json as embedding
          from ai_rag_embeddings r
          join global_kb_entries e on e.id = r.entry_id
          where r.namespace = ${settings.namespace}
            and r.entry_id = any(${ids}::uuid[])
            and e.embed_status = 'embedded'`);
        return bestCosines(
          read as unknown as Array<{ id: string; hash: string | null; embedding: unknown }>,
          vector,
        );
      }),
    {
      connectTimeoutSeconds: DISPATCH_KB_BOUNDS.connectTimeoutSeconds,
      deadlineMs: DISPATCH_KB_BOUNDS.deadlineMs,
      settings,
    },
  );
  const byId = new Map(rows.map((row) => [row.id, row]));
  return {
    status: 'ok',
    model: embedModel,
    queryHash: createHash('sha256').update(query).digest('hex'),
    ms: Date.now() - startedAt,
    scores: candidates.map((c) => {
      const row = byId.get(c.id);
      if (!row) return { ...c, score: null };
      if (row.hash !== c.hash) return { ...c, score: null, stale: true };
      return { ...c, score: Number(row.score) };
    }),
  };
}

/** Compare-and-set on `pending`: a second amendment of a row, or one of a row the start never
 *  stamped, changes nothing. */
async function amend(
  db: Database,
  invocationId: string,
  record: HouseRulesSimilarity,
): Promise<void> {
  await db.execute(sql`
    update cli_invocations
    set house_rules = jsonb_set(house_rules, '{similarity}', ${JSON.stringify(record)}::jsonb)
    where id = ${invocationId}::uuid
      and house_rules->'similarity'->>'status' = 'pending'`);
}

async function score(
  db: Database,
  invocationId: string,
  taskId: string,
  candidates: Candidates,
): Promise<void> {
  let record: HouseRulesSimilarity;
  try {
    record = await measure(db, taskId, candidates);
  } catch (err) {
    log.warn({ err, invocationId, taskId }, 'house rules could not be scored against the task');
    record = { status: 'failed', errorClass: failureClass(err) };
  }
  try {
    await amend(db, invocationId, record);
  } catch (err) {
    log.warn({ err, invocationId }, 'the house rules scores could not be recorded');
  }
}

/** Starts the scoring of a run whose start wrote a pending record, and returns at once: the CLI
 *  runs for minutes, so a cold embedder costs the dispatch nothing. Never throws. */
export function scoreHouseRulesInBackground(
  db: Database,
  invocationId: string,
  taskId: string,
  stamp: HouseRulesStamp | null,
): void {
  const pending = stamp?.similarity;
  if (pending?.status !== 'pending' || !pending.scores?.length) return;
  void score(db, invocationId, taskId, pending.scores);
}
