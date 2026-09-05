import { eq } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import { hashEmbed, ollamaEmbed, resolveEmbedBudget } from '@haive/shared/rag';
import { logger } from '@haive/shared';

type Logger = ReturnType<typeof logger.child>;

/* ------------------------------------------------------------------ */
/* Strict batch embedding                                              */
/* ------------------------------------------------------------------ */

export type EmbedBatchOutcome =
  /** Real model vectors. */
  | { kind: 'embedded'; embeddings: number[][] }
  /** Deterministic hash vectors, written DELIBERATELY: either this repo has no
   *  embedding endpoint at all (a homogeneous, whole-repo choice) or strict mode
   *  is off and the admin has accepted the old behaviour. */
  | { kind: 'hashed'; embeddings: number[][] }
  /** Strict mode, and the embed failed. No vectors — the caller must skip these
   *  chunks or fail, never substitute. */
  | { kind: 'failed'; reason: string };

export interface EmbedBatchOpts {
  ollamaUrl: string | null;
  model: string | null;
  dimensions: number;
  /** False when the endpoint was never configured or the boot probe failed. */
  useOllama: boolean;
  texts: string[];
}

/** Turn a rejected embed into the sentence a user reads on the step banner.
 *  Timeouts are named as such because the fix differs: a timeout means the model
 *  is there and too slow for the budget (raise it, or lower the batch size),
 *  while any other error means the endpoint answered wrongly. */
function describeEmbedFailure(err: unknown, model: string | null, timeoutMs: number): string {
  const isTimeout =
    err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
  const model_ = model ?? 'the embedding model';
  if (isTimeout) {
    return `${model_} did not answer within ${Math.round(timeoutMs / 1000)}s`;
  }
  const message = err instanceof Error ? err.message : String(err);
  return `${model_} failed: ${message.slice(0, 300)}`;
}

/** Embed one batch of chunk texts.
 *
 *  The whole point of this module: an embed failure MUST NOT silently become a
 *  hash vector once the index already holds real ones. A hash vector is not a
 *  weaker embedding, it is noise — it makes the dense half of the RRF fusion rank
 *  by nothing, and neither the index nor the search can tell the two kinds apart
 *  afterwards. MEASURED on an 8-core CPU-only host with qwen3-embedding:4b, a
 *  batch of 8 real code chunks takes 50-69s, so under the old hard 60s budget that
 *  substitution was the DEFAULT outcome on a CPU host rather than an edge case.
 *
 *  `useOllama: false` is the one legitimate hash path and is never a failure: a
 *  repo with no embedding endpoint gets hash vectors for EVERY chunk, which is
 *  homogeneous and therefore honest. */
export async function embedBatch(opts: EmbedBatchOpts): Promise<EmbedBatchOutcome> {
  const { ollamaUrl, model, dimensions, useOllama, texts } = opts;
  if (!useOllama || !ollamaUrl || !model) {
    return { kind: 'hashed', embeddings: texts.map((t) => hashEmbed(t, dimensions)) };
  }
  const { embedTimeoutMs, strict } = await resolveEmbedBudget();
  try {
    return {
      kind: 'embedded',
      embeddings: await ollamaEmbed(ollamaUrl, model, texts, {
        timeoutMs: embedTimeoutMs,
      }),
    };
  } catch (err) {
    const reason = describeEmbedFailure(err, model, embedTimeoutMs);
    if (!strict) {
      return { kind: 'hashed', embeddings: texts.map((t) => hashEmbed(t, dimensions)) };
    }
    return { kind: 'failed', reason };
  }
}

/** The configured ingest batch size, so the loops chunk by the admin's value
 *  rather than the compile-time constant. */
export async function resolveEmbedBatchSize(): Promise<number> {
  return (await resolveEmbedBudget()).batchSize;
}

/** Thrown by the ONBOARDING populate step, which fails rather than skipping: its
 *  entire contract is "the index is now populated", and a human is watching it.
 *  The mid-run sync steps (02, 11c) skip the chunks and carry on instead — a
 *  broken index must not block every task on the repository. */
export class RagEmbedFailureError extends Error {
  constructor(public readonly reason: string) {
    super(`RAG embedding failed: ${reason}`);
    this.name = 'RagEmbedFailureError';
  }
}

/* ------------------------------------------------------------------ */
/* Per-repo degradation record                                         */
/* ------------------------------------------------------------------ */

export interface RagEmbedHealth {
  degradedAt: Date | null;
  degradedReason: string | null;
  lexicalOnly: boolean;
}

const HEALTHY: RagEmbedHealth = { degradedAt: null, degradedReason: null, lexicalOnly: false };

export async function loadRagEmbedHealth(
  db: Database,
  repositoryId: string | null,
): Promise<RagEmbedHealth> {
  if (!repositoryId) return HEALTHY;
  const row = await db.query.repositories.findFirst({
    where: eq(schema.repositories.id, repositoryId),
    columns: {
      ragEmbedDegradedAt: true,
      ragEmbedDegradedReason: true,
      ragEmbedLexicalOnly: true,
    },
  });
  if (!row) return HEALTHY;
  return {
    degradedAt: row.ragEmbedDegradedAt,
    degradedReason: row.ragEmbedDegradedReason,
    lexicalOnly: row.ragEmbedLexicalOnly,
  };
}

/** Remember that this repo's embeddings broke, so the condition outlives the step
 *  row (a manual retry nulls `task_steps.output`) and every later RAG step can say
 *  so. Best-effort with an error log rather than a throw: the caller is already
 *  mid-recovery from a failed embed, and losing the banner is better than losing
 *  the run. Does not overwrite an EARLIER degradation timestamp — the first
 *  failure is when this started, and the reason is refreshed to the latest one. */
export async function recordRagEmbedDegraded(
  db: Database,
  repositoryId: string | null,
  reason: string,
  log: Logger,
): Promise<void> {
  if (!repositoryId) return;
  try {
    const current = await loadRagEmbedHealth(db, repositoryId);
    await db
      .update(schema.repositories)
      .set({
        ragEmbedDegradedAt: current.degradedAt ?? new Date(),
        ragEmbedDegradedReason: reason,
      })
      .where(eq(schema.repositories.id, repositoryId));
  } catch (err) {
    log.error({ err, repositoryId }, 'failed to record rag embed degradation');
  }
}

/** Clear the degradation after a run embedded everything it was asked to. Only
 *  clears the flag, never `ragEmbedLexicalOnly` — that one is a decision a person
 *  made and only a person retracts. */
export async function clearRagEmbedDegraded(
  db: Database,
  repositoryId: string | null,
  log: Logger,
): Promise<void> {
  if (!repositoryId) return;
  try {
    await db
      .update(schema.repositories)
      .set({ ragEmbedDegradedAt: null, ragEmbedDegradedReason: null })
      .where(eq(schema.repositories.id, repositoryId));
  } catch (err) {
    log.error({ err, repositoryId }, 'failed to clear rag embed degradation');
  }
}

/* ------------------------------------------------------------------ */
/* Step banner                                                         */
/* ------------------------------------------------------------------ */

/** Amber-banner copy for any RAG step, so a degraded repo says so everywhere and
 *  not only on the step that broke. Gated on `degradedAt` / `lexicalOnly` — the
 *  STRUCTURAL columns — never on the presence of `degradedReason`, which is
 *  display copy that outlives the state it describes. */
export function ragEmbedWarning(
  health: RagEmbedHealth,
  thisRun: { skippedChunks: number } = { skippedChunks: 0 },
): string | null {
  if (health.lexicalOnly) {
    return (
      'This repository is set to lexical-only RAG: chunks are stored without model ' +
      'embeddings and search ranks by full-text relevance alone. Semantic matches are ' +
      'unavailable until embeddings are re-enabled on the repository tooling page, ' +
      'which re-indexes the repository.'
    );
  }
  if (!health.degradedAt) return null;
  const skipped =
    thisRun.skippedChunks > 0
      ? ` ${thisRun.skippedChunks} chunk${thisRun.skippedChunks === 1 ? '' : 's'} from this run ` +
        'were left unindexed rather than stored with meaningless vectors, so they are ' +
        'not searchable yet.'
      : ' Chunks left unindexed by the failure are not searchable yet.';
  return (
    `RAG embeddings are failing for this repository — ${health.degradedReason ?? 'reason unrecorded'}.` +
    `${skipped} Retry or accept lexical-only search on the repository tooling page; ` +
    'raising the embedding timeout or lowering the batch size in Admin usually fixes a ' +
    'slow host.'
  );
}

/** Join the RAG step warnings into the single `task_steps.warning_message` column.
 *  Returns null when there is nothing to say, so a healthy run CLEARS a stale
 *  banner from a previous pass instead of leaving it behind. */
export function composeRagWarning(...parts: Array<string | null>): string | null {
  const kept = parts.filter((p): p is string => !!p);
  return kept.length > 0 ? kept.join('\n\n') : null;
}
