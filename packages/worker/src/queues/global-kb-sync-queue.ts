import { createHash } from 'node:crypto';
import { Queue, Worker, type Job } from 'bullmq';
import { and, eq, isNull, lt } from 'drizzle-orm';
import {
  GLOBAL_KB_JOB_NAMES,
  QUEUE_NAMES,
  logger,
  type GlobalKbSyncJobPayload,
} from '@haive/shared';
import { vectorLiteral } from '@haive/shared/rag';
import {
  embedBatch,
  resolveEmbedBatchSize,
  RagEmbedFailureError,
} from '../step-engine/steps/_rag-embed-health.js';
import {
  globalKbEntries,
  resolveGlobalKbSettings,
  withGlobalKb,
  type GlobalKbContext,
} from '@haive/shared/global-kb';
import { getDb } from '../db.js';
import { getBullRedis } from '../redis.js';
import {
  capChunks,
  chunkSection,
  contextHeader,
  extractMarkdownSections,
  slugifyHeading,
} from '../step-engine/steps/onboarding/_rag-chunkers.js';

const log = logger.child({ module: 'global-kb-sync' });

function entryContentHash(body: string, facets: unknown): string {
  return createHash('sha256')
    .update(body)
    .update(JSON.stringify(facets ?? {}))
    .digest('hex');
}

/** Remove an entry's vectors unless it is ACTIVE at the moment the delete runs.
 *
 *  Decided under `FOR SHARE`, which conflicts with the lock every status writer takes, so a job
 *  queued before the entry was reactivated — or one BullMQ redelivers after a stall, once its lock
 *  has expired and the reactivation's upsert has already run — cannot remove the vectors that
 *  reactivation wrote. MEASURED on the unguarded version: a supersession `delete` delivered after the
 *  reactivated entry's upsert left it `active`/`embedded` with 0 chunks, which nothing would ever
 *  serve. A missing row counts as retired. This is reconciliation, not the only defence: every path
 *  that retires an entry already removes its vectors in its own transaction. */
async function removeVectorsUnlessActive(
  ctx: GlobalKbContext,
  namespace: string,
  entryId: string,
): Promise<boolean> {
  return ctx.conn.pg.begin(async (tx) => {
    const live = (await tx.unsafe(`SELECT status FROM global_kb_entries WHERE id = $1 FOR SHARE`, [
      entryId,
    ])) as unknown as Array<{ status: string }>;
    if (live[0]?.status === 'active') return false;
    await tx.unsafe(`DELETE FROM ai_rag_embeddings WHERE namespace = $1 AND entry_id = $2`, [
      namespace,
      entryId,
    ]);
    return true;
  });
}

type SyncWriteOutcome = 'written' | 'stale' | 'retired';

/** Land a sync's results, or refuse to — decided, written and stamped in ONE locked transaction.
 *
 *  The job reads the entry and then embeds, which is slow (one CPU batch measured 50-69s), so by the
 *  time results exist the row may have moved on. Two ways, both MEASURED:
 *  - it left `active`: an archive committed meanwhile, and replacing chunks re-inserted every vector
 *    of an archived entry;
 *  - its content changed: a re-scope committed meanwhile (the PATCH corrects the chunks' facets in its
 *    own transaction), and replacing chunks wrote the OLD scope back over that correction.
 *  So the current row is re-read here. A retired entry keeps no vectors; a changed one keeps what it
 *  has, for the sync its edit enqueued to replace; only an unchanged active entry gets these results.
 *  The revision is the title plus `entryContentHash(body, facets)`, every input the chunks are built
 *  from.
 *
 *  `FOR UPDATE`, not `FOR SHARE`: the stamp writes this row inside the same transaction, and two syncs
 *  of one entry holding SHARE locks would deadlock upgrading them. It still serialises with every
 *  status writer, and each path locks the entry row before its chunks, so the order never inverts.
 *  The stamp is inside for the same reason the check is: an edit landing between a separate stamp and
 *  this commit would be marked `embedded` for content that was never embedded. */
async function writeSyncResults(
  ctx: GlobalKbContext,
  entry: typeof globalKbEntries.$inferSelect,
  sourcePath: string,
  chunks: ReadonlyArray<{
    sectionId: string;
    chunkIndex: number;
    chunkHash: string;
    content: string;
  }>,
  embeddings: ReadonlyArray<number[]>,
): Promise<SyncWriteOutcome> {
  const usedPgvector = chunks.length > 0 ? await hasVectorColumn(ctx) : false;
  const facetsJson = JSON.stringify(entry.facets ?? {});
  const revision = entryContentHash(entry.body, entry.facets);
  const outcome = await ctx.conn.pg.begin(async (tx): Promise<SyncWriteOutcome> => {
    const [live] = (await tx.unsafe(
      `SELECT status, title, body, facets FROM global_kb_entries WHERE id = $1 FOR UPDATE`,
      [entry.id],
    )) as unknown as Array<{ status: string; title: string; body: string; facets: unknown }>;
    if (!live || live.status !== 'active') {
      await tx.unsafe(`DELETE FROM ai_rag_embeddings WHERE namespace = $1 AND entry_id = $2`, [
        entry.namespace,
        entry.id,
      ]);
      return 'retired';
    }
    if (live.title !== entry.title || entryContentHash(live.body, live.facets) !== revision) {
      return 'stale';
    }
    await tx.unsafe(`DELETE FROM ai_rag_embeddings WHERE namespace = $1 AND entry_id = $2`, [
      entry.namespace,
      entry.id,
    ]);
    for (let i = 0; i < chunks.length; i += 1) {
      const chunk = chunks[i]!;
      const common = [
        entry.namespace,
        entry.userId,
        entry.id,
        sourcePath,
        chunk.sectionId,
        chunk.chunkIndex,
        chunk.chunkHash,
        facetsJson,
        chunk.content,
      ];
      if (usedPgvector) {
        await tx.unsafe(
          `INSERT INTO ai_rag_embeddings (namespace, user_id, entry_id, source_type, source_path, section_id, chunk_index, chunk_hash, facets, content, vector)
           VALUES ($1, $2, $3, 'kb', $4, $5, $6, $7, $8::jsonb, $9, $10::vector)`,
          [...common, vectorLiteral(embeddings[i]!)],
        );
      } else {
        await tx.unsafe(
          `INSERT INTO ai_rag_embeddings (namespace, user_id, entry_id, source_type, source_path, section_id, chunk_index, chunk_hash, facets, content, embedding_json)
           VALUES ($1, $2, $3, 'kb', $4, $5, $6, $7, $8::jsonb, $9, $10::jsonb)`,
          [...common, JSON.stringify(embeddings[i]!)],
        );
      }
    }
    // A timestamp column holds UTC wall clock; an ISO string with its zone ignored is exactly what
    // drizzle writes for `new Date()` everywhere else.
    await tx.unsafe(
      `UPDATE global_kb_entries SET embed_status = 'embedded', content_hash = $2, updated_at = $3::timestamp WHERE id = $1`,
      [entry.id, revision, new Date().toISOString()],
    );
    return 'written';
  });
  return outcome as SyncWriteOutcome;
}

/** Whether a failed sync may stamp the row `failed`: only while the row still holds the revision the
 *  job read, and only if no other job has already embedded that revision. A newer edit committed
 *  during the embed has marked the row `pending`, and the reconcile re-queues `pending` rows alone, so
 *  an unconditional stamp hid exactly the revision whose lost enqueue that sweep exists to recover. */
export function failedStampApplies(
  job: { title: string; revision: string },
  live:
    | { title: string; revision: string; embedStatus: string; contentHash: string | null }
    | undefined,
): boolean {
  if (!live || live.title !== job.title || live.revision !== job.revision) return false;
  return !(live.embedStatus === 'embedded' && live.contentHash === job.revision);
}

/** The stamp under the same row lock `writeSyncResults` takes, so an edit cannot land between the
 *  check and the write. */
async function markSyncFailed(
  ctx: GlobalKbContext,
  entry: typeof globalKbEntries.$inferSelect,
): Promise<void> {
  await ctx.conn.pg.begin(async (tx) => {
    const [live] = (await tx.unsafe(
      `SELECT title, body, facets, embed_status, content_hash FROM global_kb_entries WHERE id = $1 FOR UPDATE`,
      [entry.id],
    )) as unknown as Array<{
      title: string;
      body: string;
      facets: unknown;
      embed_status: string;
      content_hash: string | null;
    }>;
    const stamp = failedStampApplies(
      { title: entry.title, revision: entryContentHash(entry.body, entry.facets) },
      live && {
        title: live.title,
        revision: entryContentHash(live.body, live.facets),
        embedStatus: live.embed_status,
        contentHash: live.content_hash,
      },
    );
    if (stamp) {
      await tx.unsafe(`UPDATE global_kb_entries SET embed_status = 'failed' WHERE id = $1`, [
        entry.id,
      ]);
    }
  });
}

async function hasVectorColumn(ctx: GlobalKbContext): Promise<boolean> {
  const rows = (await ctx.conn.pg.unsafe(
    `SELECT 1 FROM information_schema.columns WHERE table_name = 'ai_rag_embeddings' AND column_name = 'vector'`,
  )) as unknown as unknown[];
  return Array.isArray(rows) && rows.length > 0;
}

/** Reconcile the global vector store to an entry's current state. Active entries
 *  are (re)chunked + (re)embedded with the GLOBAL embed model (hash fallback) and
 *  their chunks fully replaced; everything else has its chunks removed. */
export async function syncGlobalKbEntry(payload: GlobalKbSyncJobPayload): Promise<void> {
  await withGlobalKb(getDb(), async (ctx) => {
    const { entryId, namespace } = payload;

    if (payload.reason === 'delete') {
      if (!(await removeVectorsUnlessActive(ctx, namespace, entryId))) {
        log.info({ entryId }, 'stale global KB delete job skipped: the entry is active again');
      }
      return;
    }

    const entry = await ctx.db.query.globalKbEntries.findFirst({
      where: eq(globalKbEntries.id, entryId),
    });

    // Only `active` entries are retrievable; anything else holds no vectors. Re-checked under the
    // lock at delete time: if a reactivation committed since the read above, its own upsert embeds it.
    if (!entry || entry.status !== 'active') {
      await removeVectorsUnlessActive(ctx, namespace, entryId);
      return;
    }

    try {
      const sourcePath = `global_kb/${slugifyHeading(entry.title)}-${entry.id.slice(0, 8)}.md`;
      const sections = extractMarkdownSections(entry.body, sourcePath);
      // The header roots on the entry TITLE, never on sourcePath — that filename
      // is synthetic and would only add noise to the embedding.
      const built = sections.flatMap((s) =>
        chunkSection(s, { header: contextHeader(entry.title, s.breadcrumb) }),
      );
      const { chunks, dropped } = capChunks(built);
      if (dropped > 0) {
        log.warn(
          { entryId: entry.id, kept: chunks.length, dropped },
          'global KB entry exceeded the per-entry chunk budget; tail not embedded',
        );
      }

      let outcome: SyncWriteOutcome;
      if (chunks.length > 0) {
        const texts = chunks.map((c) => c.content);
        const useOllama = !!(ctx.conn.ollamaUrl && ctx.conn.embedModel);
        // Batched, unlike before: one entry can carry up to MAX_CHUNKS_PER_FILE (80)
        // chunks, and sending all of them in a single /api/embed made this the most
        // timeout-prone embed call in the codebase.
        const batchSize = await resolveEmbedBatchSize();
        const embeddings: number[][] = [];
        for (let start = 0; start < texts.length; start += batchSize) {
          const outcome = await embedBatch({
            ollamaUrl: ctx.conn.ollamaUrl,
            model: ctx.conn.embedModel,
            dimensions: ctx.conn.embeddingDimensions,
            useOllama,
            texts: texts.slice(start, start + batchSize),
          });
          if (outcome.kind === 'failed') {
            // Throw BEFORE the delete+insert transaction below, so the entry keeps
            // the chunks it already had rather than losing them for hash noise.
            log.error({ entryId, start, reason: outcome.reason }, 'global KB embed failed');
            throw new RagEmbedFailureError(outcome.reason);
          }
          embeddings.push(...outcome.embeddings);
        }

        outcome = await writeSyncResults(ctx, entry, sourcePath, chunks, embeddings);
      } else {
        // No extractable content (e.g. an empty body): the same guarded write clears stale chunks.
        outcome = await writeSyncResults(ctx, entry, sourcePath, [], []);
      }
      if (outcome === 'retired') {
        log.info(
          { entryId: entry.id },
          'global KB entry left active while syncing; vectors removed, not re-inserted',
        );
        return;
      }
      if (outcome === 'stale') {
        log.info(
          { entryId: entry.id },
          'global KB entry changed while syncing; results discarded for its own sync to re-embed',
        );
        return;
      }
      log.info({ entryId: entry.id, chunks: chunks.length }, 'global KB entry synced');
    } catch (err) {
      await markSyncFailed(ctx, entry).catch(() => {});
      throw err;
    }
  });
}

const PURGE_INTERVAL_MS = 24 * 60 * 60 * 1000; // daily
const PURGE_JOB_ID = 'global-kb-purge-archived-repeatable';

/** Hard-delete archived (superseded) entries whose superseded_at is older than the
 *  configured retention window, reclaiming the rows the activation-supersession path
 *  leaves behind. Their vectors were already dropped on supersession; this clears any
 *  stragglers too. retentionDays <= 0 keeps archived entries forever (no purge).
 *  Entries archived without a superseded_at timestamp are never purged. */
/** For each purged row, the nearest predecessor that SURVIVES the sweep: its own
 *  `supersedes_entry_id`, followed past rows purged alongside it. Null when nothing older survives,
 *  or when the purged links form a cycle. */
export function survivingPredecessors(
  purged: ReadonlyArray<{ id: string; supersedes_entry_id: string | null }>,
): Map<string, string | null> {
  const next = new Map(purged.map((r) => [r.id, r.supersedes_entry_id]));
  const out = new Map<string, string | null>();
  for (const { id } of purged) {
    const seen = new Set([id]);
    let target = next.get(id) ?? null;
    while (target !== null && next.has(target) && !seen.has(target)) {
      seen.add(target);
      target = next.get(target) ?? null;
    }
    out.set(id, target !== null && seen.has(target) ? null : target);
  }
  return out;
}

export async function purgeArchivedGlobalKbEntries(): Promise<void> {
  const settings = await resolveGlobalKbSettings();
  if (!settings.enabled) return;
  const days = settings.archiveRetentionDays;
  if (!Number.isFinite(days) || days <= 0) return;
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  await withGlobalKb(getDb(), async (ctx) => {
    // ONE conditional statement, never select-then-delete-by-id. The WHERE is the whole decision,
    // and when the delete has to wait for a concurrent writer's row lock Postgres re-evaluates it
    // against the row that writer committed — so an entry reactivated while the sweep runs (the
    // PATCH holds the row, then commits `active` with `superseded_at` cleared) no longer matches and
    // survives. MEASURED on the select-then-delete version: a reactivation held open while the purge
    // ran was deleted the moment it committed, after the page had reported success. The cutoff is
    // bound the way drizzle binds a Date to a `timestamp` column, an ISO string whose zone is
    // ignored, so the retention window is unchanged. Vectors go in the same transaction as rows.
    const purged = (await ctx.conn.pg.begin(async (tx) => {
      const rows = (await tx.unsafe(
        `DELETE FROM global_kb_entries
          WHERE status = 'archived' AND superseded_at < $1::timestamp
          RETURNING id, namespace, supersedes_entry_id`,
        [cutoff.toISOString()],
      )) as unknown as Array<{ id: string; namespace: string; supersedes_entry_id: string | null }>;
      // Rows that replaced a purged entry now replace its nearest surviving predecessor, as the
      // api's DELETE route does, or the chain the successor lookup walks breaks at the gap.
      const predecessor = survivingPredecessors(rows);
      for (const r of rows) {
        await tx.unsafe(`DELETE FROM ai_rag_embeddings WHERE namespace = $1 AND entry_id = $2`, [
          r.namespace,
          r.id,
        ]);
        await tx.unsafe(
          `UPDATE global_kb_entries
              SET supersedes_entry_id = CASE WHEN id = $1::uuid THEN NULL ELSE $1::uuid END
            WHERE supersedes_entry_id = $2::uuid`,
          [predecessor.get(r.id) ?? null, r.id],
        );
      }
      return rows.length;
    })) as number;
    if (purged > 0) {
      log.info({ purged, retentionDays: days }, 'purged expired archived global KB entries');
    }
  });
}

/** Register the daily archived-entry retention sweep. Idempotent: upsertJobScheduler keys on
 *  PURGE_JOB_ID, so a restart UPDATES the one scheduler. The legacy-repeatable pre-sweep this
 *  used to carry is gone — bullmq 6 removed getRepeatableJobs/removeRepeatableByKey, and
 *  38e13a2 already cleared the backlog while those APIs still existed. */
export async function scheduleGlobalKbPurge(): Promise<void> {
  const queue = new Queue(QUEUE_NAMES.GLOBAL_KB_SYNC, { connection: getBullRedis() });
  await queue.upsertJobScheduler(
    PURGE_JOB_ID,
    { every: PURGE_INTERVAL_MS },
    {
      name: GLOBAL_KB_JOB_NAMES.PURGE_ARCHIVED,
      data: {},
      opts: { removeOnComplete: true, removeOnFail: 5 },
    },
  );
}

const RECONCILE_INTERVAL_MS = 5 * 60 * 1000;
// The api's own enqueue follows its commit by milliseconds and the live-job check cannot see an
// `add` still in flight, so only an entry pending for longer than this is treated as lost.
const RECONCILE_GRACE_MS = 2 * 60 * 1000;
const RECONCILE_JOB_ID = 'global-kb-reconcile-pending-repeatable';

/** The pending entries no job will embed. Only a waiting or running UPSERT counts as queued: a
 *  `delete` job leaves an active entry alone, so it never embeds one. */
export function pickLostSyncs<T extends { id: string }>(
  pending: T[],
  liveJobs: Array<{ name: string; data?: Partial<GlobalKbSyncJobPayload> }>,
): T[] {
  const queued = new Set(
    liveJobs
      .filter((j) => j.name === GLOBAL_KB_JOB_NAMES.SYNC_ENTRY && j.data?.reason === 'upsert')
      .map((j) => j.data?.entryId),
  );
  return pending.filter((e) => !queued.has(e.id));
}

/** Re-queue the sync of every ACTIVE entry still `pending` with no job to embed it.
 *
 *  Writers commit `embed_status = 'pending'` and enqueue only afterwards, outside the transaction,
 *  so the row is the durable record of an owed sync and the enqueue is just the fast path. An `add`
 *  that throws (Redis refusing writes) or never lands (the api dies while it waits on a reconnect)
 *  used to leave an activated entry with no vectors and nothing that would ever queue them — and an
 *  activation that archived a predecessor had already deleted ITS vectors in the same transaction,
 *  so the topic dropped out of retrieval entirely. Entries with a live upsert are skipped, or a slow
 *  embed backlog would gain a duplicate on every sweep. */
export async function reconcilePendingGlobalKbSyncs(): Promise<void> {
  const settings = await resolveGlobalKbSettings();
  if (!settings.enabled) return;
  const cutoff = new Date(Date.now() - RECONCILE_GRACE_MS);
  const pending = await withGlobalKb(getDb(), (ctx) =>
    ctx.db
      .select({ id: globalKbEntries.id, namespace: globalKbEntries.namespace })
      .from(globalKbEntries)
      .where(
        and(
          eq(globalKbEntries.status, 'active'),
          isNull(globalKbEntries.supersededAt),
          eq(globalKbEntries.embedStatus, 'pending'),
          lt(globalKbEntries.updatedAt, cutoff),
        ),
      ),
  );
  if (pending.length === 0) return;
  const queue = new Queue(QUEUE_NAMES.GLOBAL_KB_SYNC, { connection: getBullRedis() });
  try {
    const lost = pickLostSyncs(
      pending,
      await queue.getJobs(['active', 'waiting', 'delayed', 'prioritized']),
    );
    for (const e of lost) {
      await queue.add(
        GLOBAL_KB_JOB_NAMES.SYNC_ENTRY,
        {
          entryId: e.id,
          namespace: e.namespace,
          reason: 'upsert',
        } satisfies GlobalKbSyncJobPayload,
        { removeOnComplete: true, removeOnFail: 20 },
      );
    }
    if (lost.length > 0) {
      log.info(
        { requeued: lost.length, pending: pending.length },
        'requeued global KB syncs that were never queued',
      );
    }
  } finally {
    await queue.close().catch(() => {});
  }
}

/** Register the lost-sync reconcile, keyed on RECONCILE_JOB_ID like the purge. A scheduler outlives
 *  the code that registered it: rolling this back also takes `removeJobScheduler(RECONCILE_JOB_ID)`. */
export async function scheduleGlobalKbReconcile(): Promise<void> {
  const queue = new Queue(QUEUE_NAMES.GLOBAL_KB_SYNC, { connection: getBullRedis() });
  await queue.upsertJobScheduler(
    RECONCILE_JOB_ID,
    { every: RECONCILE_INTERVAL_MS },
    {
      name: GLOBAL_KB_JOB_NAMES.RECONCILE_PENDING,
      data: {},
      opts: { removeOnComplete: true, removeOnFail: 5 },
    },
  );
}

export function startGlobalKbSyncWorker(): Worker {
  const worker = new Worker<GlobalKbSyncJobPayload>(
    QUEUE_NAMES.GLOBAL_KB_SYNC,
    async (job: Job<GlobalKbSyncJobPayload>) => {
      switch (job.name) {
        case GLOBAL_KB_JOB_NAMES.SYNC_ENTRY:
          await syncGlobalKbEntry(job.data);
          return;
        case GLOBAL_KB_JOB_NAMES.PURGE_ARCHIVED:
          await purgeArchivedGlobalKbEntries();
          return;
        case GLOBAL_KB_JOB_NAMES.RECONCILE_PENDING:
          await reconcilePendingGlobalKbSyncs();
          return;
        default:
          throw new Error(`Unknown global-kb job: ${job.name}`);
      }
    },
    { connection: getBullRedis(), concurrency: 2 },
  );

  worker.on('completed', (job) => {
    logger.info({ jobId: job.id, name: job.name }, 'global KB sync job completed');
  });
  worker.on('failed', (job, err) => {
    logger.warn({ jobId: job?.id, name: job?.name, err }, 'global KB sync job failed');
  });

  return worker;
}
