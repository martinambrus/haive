import { scanFences } from '@haive/shared/markdown-fences';
import { createHash } from 'node:crypto';
import { and, asc, eq, isNull, notInArray } from 'drizzle-orm';
import { z } from 'zod';
import { schema, type Database } from '@haive/database';
import { logger } from '@haive/shared';
import type { Insight, LoadedInsight } from '@haive/shared/step';
import type { StepContext } from '../../step-definition.js';
import { lockOwnedStep, StepSupersededError } from '../../step-ownership.js';
import { readValidationSnapshot, validationSnapshotDigest } from './_validation-snapshot.js';

export const INSIGHT_BATCH_EVENT = 'insight.batch';
export const INSIGHT_STEP = '08e-insights-triage';
const itemSchema = z
  .object({
    id: z.string().min(1),
    outcome: z.enum(['applied', 'already_handled', 'not_applied']),
    changes: z.array(z.string().trim().min(1)),
    reason: z.string(),
  })
  .strict()
  .refine((i) => i.outcome !== 'applied' || i.changes.length > 0);
const reportSchema = z
  .object({
    version: z.literal(1),
    batchId: z.string(),
    items: z.array(itemSchema),
    notes: z.string(),
  })
  .strict();
export type InsightItemOutcome = Omit<z.infer<typeof itemSchema>, 'outcome'> & {
  outcome: z.infer<typeof itemSchema>['outcome'] | 'unconfirmed';
};
export interface InsightOutcome {
  version: 1;
  batchId: string;
  items: InsightItemOutcome[];
  implemented: boolean;
  changes: string[];
  notes: string;
}
export function readInsightOutcome(
  raw: unknown,
  batchId: string,
  ids: readonly string[],
): InsightOutcome {
  if (typeof raw === 'string') {
    const final = scanFences(raw.split('\n'))
      .filter((f) => f.lang.toLowerCase() === 'json')
      .at(-1);
    // Neither a final fence nor a whole unfenced reply may be repaired into success
    // after an editor may already have changed the tree. Never extract quoted examples.
    try {
      raw = final
        ? final.close === null
          ? null
          : JSON.parse(final.content.join('\n'))
        : JSON.parse(raw.trim());
    } catch {
      raw = null;
    }
  }
  // Select the final report-shaped envelope BEFORE validation. An invalid final answer must
  // never fall back to an earlier example that happened to validate.
  const candidate =
    raw &&
    typeof raw === 'object' &&
    !Array.isArray(raw) &&
    ('batchId' in raw || 'items' in raw || 'version' in raw)
      ? (raw as Record<string, unknown>)
      : null;
  const parsed = reportSchema.safeParse(candidate);
  const valid =
    parsed.success &&
    parsed.data.batchId === batchId &&
    parsed.data.items.length === ids.length &&
    new Set(parsed.data.items.map((i) => i.id)).size === ids.length &&
    parsed.data.items.every((i) => ids.includes(i.id));
  const notes =
    candidate && candidate.version !== 1
      ? 'Unsupported insight outcome protocol version; selected items are unconfirmed.'
      : 'No valid per-item report; edits may exist. Inspect the workspace before Retry.';
  const items: InsightItemOutcome[] = valid
    ? parsed.data.items
    : ids.map((id) => ({ id, outcome: 'unconfirmed', changes: [], reason: notes }));
  return {
    version: 1,
    batchId,
    items,
    implemented: items.some((i) => i.outcome === 'applied'),
    changes: items.filter((i) => i.outcome === 'applied').flatMap((i) => i.changes),
    notes: valid ? parsed.data.notes : notes,
  };
}

export function selectOfferedInsights(
  offered: readonly Insight[],
  values: unknown,
): LoadedInsight[] {
  const ids = (values as { selectedInsights?: unknown } | null)?.selectedInsights ?? [];
  if (
    !Array.isArray(ids) ||
    ids.some((id) => typeof id !== 'string') ||
    new Set(ids).size !== ids.length
  )
    throw new Error(
      'Invalid insight selection. Refresh the form and select from the offered improvements.',
    );
  const selected = ids.map((id) => offered.find((i) => i.id === id));
  if (selected.some((i) => !i))
    throw new Error('Stale or foreign insight selection. Refresh the form.');
  // Legacy positional ids bind ONLY to their saved snapshot, never to a fresh inventory.
  return selected as LoadedInsight[];
}
export const insightBatchId = (stepRowId: string, generation: number) =>
  `insight-batch-v1-${createHash('sha256')
    .update(JSON.stringify([stepRowId, generation]))
    .digest('hex')}`;

const selectedSchema = z
  .object({
    id: z.string(),
    identity: z.string(),
    sourceStep: z.string(),
    title: z.string(),
    location: z.string(),
    description: z.string(),
  })
  .strict();
const savedItemSchema = z
  .object({
    id: z.string(),
    outcome: z.enum(['applied', 'already_handled', 'not_applied', 'unconfirmed']),
    changes: z.array(z.string()),
    reason: z.string(),
  })
  .strict();
const journalSchema = z
  .object({
    version: z.literal(1),
    protocolVersion: z.literal(1),
    mode: z.enum(['manual_08e', 'auto_08e', 'gate3']),
    batchId: z.string(),
    sourceStepRowId: z.string(),
    generation: z.number().int().nonnegative(),
    stage: z.enum(['intent', 'reservation', 'invocation', 'outcome']),
    selected: z.array(selectedSchema),
    items: z.array(savedItemSchema),
    notes: z.string(),
    miningId: z.string().nullable(),
    invocationId: z.string().nullable(),
    // Host evidence only. Legacy/missing/incomplete snapshots never authorize skipping checks.
    // Accept old journals for recovery, but never copy their per-file maps into new events.
    worktreeBefore: z.record(z.string(), z.string()).nullable().optional(),
    worktreeBeforeDigest: z
      .object({
        sha256: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .nullable(),
        incomplete: z.boolean(),
      })
      .strict()
      .optional(),
    worktreeUnchanged: z.boolean().optional(),
  })
  .strict()
  .transform(({ worktreeBefore: legacySnapshot, ...record }) => ({
    ...record,
    // Old equality was against the writer's own start, so it cannot authorize a skip.
    ...(legacySnapshot !== undefined && record.worktreeUnchanged !== undefined
      ? { worktreeUnchanged: false }
      : {}),
  }));
export type InsightBatchRecord = z.infer<typeof journalSchema>;
export function readInsightBatchRecord(payload: unknown): InsightBatchRecord {
  const value = payload as { version?: unknown; protocolVersion?: unknown } | null;
  if (value?.version !== 1 || value?.protocolVersion !== 1)
    throw new Error('Unsupported insight batch protocol version.');
  const record = journalSchema.parse(payload);
  const ids = new Set(record.selected.map((i) => i.id));
  if (
    ids.size !== record.selected.length ||
    record.items.length !== ids.size ||
    new Set(record.items.map((i) => i.id)).size !== ids.size ||
    record.items.some((i) => !ids.has(i.id)) ||
    record.items.some((i) => i.outcome === 'applied' && !i.changes.some((c) => c.trim()))
  )
    throw new Error('Invalid insight batch item set.');
  return record;
}
export async function loadInsightBatchRecords(
  db: Database,
  taskId: string,
  options: { skipUnreadable?: boolean } = {},
): Promise<InsightBatchRecord[]> {
  const rows = await db
    .select({ payload: schema.taskEvents.payload })
    .from(schema.taskEvents)
    .where(
      and(
        eq(schema.taskEvents.taskId, taskId),
        eq(schema.taskEvents.eventType, INSIGHT_BATCH_EVENT),
      ),
    )
    .orderBy(asc(schema.taskEvents.createdAt), asc(schema.taskEvents.id));
  const records: InsightBatchRecord[] = [];
  for (const row of rows) {
    try {
      records.push(readInsightBatchRecord(row.payload));
    } catch (err) {
      if (!options.skipUnreadable) throw err;
      // The projection may re-offer an item; writes and recovery must still refuse it.
      // Do not log parse errors: validation diagnostics can contain agent-authored text.
      logger.warn(
        { taskId },
        'Skipping unreadable insight batch in acted projection; items remain unacted',
      );
    }
  }
  return records;
}

/** Required state: lock the source row before checking for a duplicate, then hold the task
 * fence through commit. No transaction spans dispatch, file reads or Redis. */
export async function appendInsightBatch(
  ctx: StepContext,
  record: InsightBatchRecord,
): Promise<InsightBatchRecord> {
  ctx.throwIfCancelled();
  const result = await ctx.db.transaction(async (tx) => {
    if (!(await lockOwnedStep(tx, ctx.taskStepId))) throw new StepSupersededError(ctx.taskStepId);
    const [source] = await tx
      .select({ generation: schema.taskSteps.rerunGeneration, taskId: schema.taskSteps.taskId })
      .from(schema.taskSteps)
      .where(eq(schema.taskSteps.id, ctx.taskStepId));
    if (
      !source ||
      source.taskId !== ctx.taskId ||
      source.generation !== record.generation ||
      record.sourceStepRowId !== ctx.taskStepId
    )
      throw new StepSupersededError(ctx.taskStepId);
    const [task] = await tx
      .select({ id: schema.tasks.id, pausedAt: schema.tasks.pausedAt })
      .from(schema.tasks)
      .where(
        and(
          eq(schema.tasks.id, ctx.taskId),
          eq(schema.tasks.userId, ctx.userId),
          ...(ctx.epoch == null ? [] : [eq(schema.tasks.orchestrationEpoch, ctx.epoch)]),
          notInArray(schema.tasks.status, ['failed', 'cancelled', 'completed']),
          isNull(schema.tasks.deadAt),
        ),
      )
      .for('share');
    if (!task) throw new StepSupersededError(ctx.taskStepId);
    ctx.throwIfCancelled();
    const existing = (await loadInsightBatchRecords(tx as unknown as Database, ctx.taskId)).find(
      (r) =>
        r.batchId === record.batchId &&
        r.stage === record.stage &&
        r.generation === record.generation,
    );
    if (existing) return existing;
    if (record.mode === 'auto_08e' && record.stage === 'intent' && task.pausedAt)
      throw new StepSupersededError(ctx.taskStepId);
    const checked = readInsightBatchRecord(record);
    await tx.insert(schema.taskEvents).values({
      taskId: ctx.taskId,
      taskStepId: ctx.taskStepId,
      eventType: INSIGHT_BATCH_EVENT,
      payload: checked,
    });
    ctx.throwIfCancelled();
    return checked;
  });
  ctx.throwIfCancelled();
  return result;
}
export async function ensureInsightIntent(
  ctx: StepContext,
  selected: LoadedInsight[],
  mode: InsightBatchRecord['mode'] = 'manual_08e',
): Promise<InsightBatchRecord> {
  const generation = ctx.rerunGeneration ?? 0;
  const record: InsightBatchRecord = {
    version: 1,
    protocolVersion: 1,
    mode,
    batchId: insightBatchId(ctx.taskStepId, generation),
    sourceStepRowId: ctx.taskStepId,
    generation,
    stage: 'intent',
    selected: selected.map(({ id, identity, sourceStep, title, location, description }) => ({
      id,
      identity,
      sourceStep,
      title,
      location,
      description,
    })),
    items: selected.map((i) => ({
      id: i.id,
      outcome: 'unconfirmed',
      changes: [],
      reason: 'Application has no confirmed report; it may have been interrupted.',
    })),
    notes: '',
    miningId: null,
    invocationId: null,
    ...(mode === 'gate3'
      ? {
          worktreeBeforeDigest: validationSnapshotDigest(
            await readValidationSnapshot(ctx, { requireComplete: true }),
          ),
        }
      : {}),
  };
  const saved = await appendInsightBatch(ctx, record);
  if (
    JSON.stringify(saved.selected.map((i) => i.id).sort()) !==
    JSON.stringify(selected.map((i) => i.id).sort())
  )
    throw new Error(
      'This insight batch already has a different selection. Retry to start a new batch.',
    );
  return saved;
}
export async function recordInsightInvocation(
  ctx: StepContext,
  agentId: string,
  miningId: string,
  invocationId: string,
): Promise<void> {
  const records = await loadInsightBatchRecords(ctx.db, ctx.taskId);
  ctx.throwIfCancelled();
  const intent = records.find(
    (r) =>
      r.batchId === insightBatchId(ctx.taskStepId, ctx.rerunGeneration ?? 0) &&
      r.stage === 'intent',
  );
  if (!intent || agentId !== `implementer-${intent.batchId}`)
    throw new Error('Insight invocation has no matching durable intent.');
  const saved = await appendInsightBatch(ctx, {
    ...intent,
    stage: 'invocation',
    miningId,
    invocationId,
  });
  if (saved.invocationId !== invocationId || saved.miningId !== miningId)
    throw new Error('Insight batch already owns another invocation; refusing a second editor.');
}

/** Called inside the reservation transaction, after its insert and source ownership lock.
 * Keeping the reference in that transaction prevents Retry from erasing an unjournaled row. */
export async function recordInsightReservation(
  ctx: StepContext,
  agentId: string,
  miningId: string,
): Promise<void> {
  const records = await loadInsightBatchRecords(ctx.db, ctx.taskId);
  ctx.throwIfCancelled();
  const intent = records.find(
    (r) =>
      r.batchId === insightBatchId(ctx.taskStepId, ctx.rerunGeneration ?? 0) &&
      r.stage === 'intent',
  );
  if (!intent || agentId !== `implementer-${intent.batchId}`)
    throw new Error('Insight reservation has no matching durable intent.');
  const saved = await appendInsightBatch(ctx, { ...intent, stage: 'reservation', miningId });
  if (saved.miningId !== miningId)
    throw new Error('Insight batch already owns another reservation.');
}
