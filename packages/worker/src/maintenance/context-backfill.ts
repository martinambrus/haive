/** Explicit operator only. No boot hook, configuration service, provider/catalog lookup or model call. */
import path from 'node:path';
import { sql, type SQL } from 'drizzle-orm';
import type { Database } from '@haive/database';
import { z } from 'zod';
import { openDirNoFollow, readFileNoFollow, writeFileNoFollow } from '@haive/shared/fs-safe';
import { createStreamJsonCollector } from '../queues/cli-exec/stream.js';
import { isElidedStreamLog } from '../queues/cli-exec/stream-log-buffer.js';
import { isRecord, readCodexRequestContext } from '../cli-executor/codex-app-server.js';

const MAX_LOG_BYTES = 8 * 1024 * 1024;
const MAX_INVOCATIONS = 64;
export const MAX_STEPS = 100;
const positive = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0;
const contextSchema = z
  .object({
    tokens: z.number().int().nonnegative().nullable(),
    window: z.number().int().positive().nullable(),
    left: z.number().int().min(0).max(100).nullable(),
  })
  .strict();
export type ContextStamp = z.infer<typeof contextSchema>;
export interface Replay {
  state: 'known' | 'missing' | 'partial' | 'ambiguous';
  format: 'claude' | 'codex-app-server' | 'codex-exec' | 'unknown';
  peak: number | null;
  window: number | null;
}
export interface ContextInvocation {
  id: string;
  usage: Record<string, unknown> | null;
  replay: Replay;
  providerName?: string | null;
}
export type Decision = {
  kind: 'changed' | 'unchanged' | 'ambiguous' | 'missing';
  reason: string;
  after?: ContextStamp;
};

/** Parse only top-level retained stream events, using the live context readers. No nested payload search. */
export function replayContext(stream: string | null): Replay {
  const result: Replay = {
    state: stream === null ? 'missing' : 'ambiguous',
    format: 'unknown',
    peak: null,
    window: null,
  };
  if (stream === null) return result;
  const collector = createStreamJsonCollector();
  const requestsOnly = createStreamJsonCollector();
  const formats = new Set<Replay['format']>();
  let malformed = false;
  let claudeAssistant = false;
  let claudeResult = false;
  for (const raw of stream.split('\n')) {
    const line = raw.trim();
    if (!line.startsWith('{')) continue; // command header, stderr and steer echoes are not events
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      malformed = true;
      continue;
    }
    if (!isRecord(event)) continue;
    if (
      event.type === 'assistant' ||
      event.type === 'result' ||
      (event.type === 'system' && event.subtype === 'init')
    ) {
      formats.add('claude');
      claudeAssistant ||= event.type === 'assistant';
      claudeResult ||= event.type === 'result';
      collector.onChunk(line + '\n');
      if (event.type === 'assistant') requestsOnly.onChunk(line + '\n');
    } else if (event.method === 'thread/tokenUsage/updated' && isRecord(event.params)) {
      formats.add('codex-app-server');
      const context = readCodexRequestContext(event.params.tokenUsage);
      if (context.peak !== null) result.peak = Math.max(result.peak ?? 0, context.peak);
      if (context.window !== null) result.window = context.window;
    } else if (typeof event.type === 'string' && /^(thread|turn|item)\./.test(event.type)) {
      formats.add('codex-exec');
    }
  }
  if (formats.size !== 1 || malformed) return result;
  result.format = [...formats][0]!;
  if (result.format === 'claude') {
    const usage = collector.getTokenUsage();
    result.peak = positive(usage?.peakPromptTokens) ? usage.peakPromptTokens : null;
    result.window = positive(usage?.contextWindow) ? usage.contextWindow : null;
    // Without per-message data, a totals-only result cannot prove lack of a request peak.
    if (!claudeAssistant && !result.peak) return result;
    if (!claudeResult && !result.peak) return result;
  }
  result.state = isElidedStreamLog(stream) ? 'partial' : 'known';
  // Elision can leave exactly one zero-usage assistant id beside a cumulative result. The
  // live single-request fallback is valid only on complete logs; report direct-request floors.
  if (result.state === 'partial' && result.format === 'claude') {
    const direct = requestsOnly.getTokenUsage()?.peakPromptTokens;
    result.peak = positive(direct) ? direct : null;
  }
  return result;
}

export function deriveContext(before: ContextStamp, invocations: ContextInvocation[]): Decision {
  if (invocations.length === 0)
    return { kind: 'unchanged', reason: 'no eligible invocations', after: before };
  const weighted: Array<{
    id: string;
    weight: number;
    peak: number | null;
    window: number | null;
    providerName?: string | null;
  }> = [];
  for (const inv of invocations) {
    const storedPeak = positive(inv.usage?.peakPromptTokens) ? inv.usage.peakPromptTokens : null;
    const replay = inv.replay;
    if (storedPeak && replay.state === 'known' && replay.peak && storedPeak !== replay.peak)
      return { kind: 'ambiguous', reason: 'recorded peak disagrees with retained replay' };
    if (!storedPeak && replay.state !== 'known')
      return {
        kind: replay.state === 'missing' ? 'missing' : 'ambiguous',
        reason: `${replay.state} request evidence`,
      };
    const peak = storedPeak ?? replay.peak;
    const total = ['inputTokens', 'cacheReadTokens', 'cacheCreationTokens'].reduce(
      (sum, k) => sum + (positive(inv.usage?.[k]) ? (inv.usage![k] as number) : 0),
      0,
    );
    weighted.push({
      id: inv.id,
      weight: peak ?? total,
      peak,
      providerName: inv.providerName,
      window: positive(inv.usage?.contextWindow) ? inv.usage.contextWindow : replay.window,
    });
  }
  weighted.sort((a, b) => b.weight - a.weight || a.id.localeCompare(b.id));
  const selected = weighted[0]!;
  if (selected.weight <= 0)
    return { kind: 'unchanged', reason: 'no usable selection weight', after: before };
  if (weighted[1]?.weight === selected.weight)
    return { kind: 'ambiguous', reason: 'tied invocation selection' };
  let after: ContextStamp = { tokens: null, window: null, left: null };
  if (selected.peak !== null) {
    // A recorded CLI window corrects the old table fallback (notably Claude's 200k → 1m).
    // OpenRouter's historical catalog outranked that value, but its past catalog is unavailable.
    if (
      selected.providerName === 'openrouter' &&
      positive(before.window) &&
      positive(selected.window) &&
      before.window !== selected.window
    )
      return { kind: 'ambiguous', reason: 'historical OpenRouter catalog denominator unavailable' };
    // Missing raw evidence alone does not invalidate an internally consistent modern stamp.
    const window = selected.window ?? (before.tokens === selected.peak ? before.window : null);
    if (!positive(window))
      return { kind: 'ambiguous', reason: 'historical denominator unavailable' };
    after = {
      tokens: selected.peak,
      window,
      left: Math.max(0, Math.min(100, 100 - Math.round((selected.peak / window) * 100))),
    };
  }
  return {
    kind:
      before.tokens === after.tokens && before.window === after.window && before.left === after.left
        ? 'unchanged'
        : 'changed',
    reason:
      selected.peak === null ? 'recorded format has no per-request peak' : 'recorded request peak',
    after,
  };
}

const rowSchema = z
  .object({
    id: z.string().uuid(),
    taskId: z.string().uuid(),
    version: z.string().regex(/^\d+$/),
    endedAt: z.string(),
    before: contextSchema,
    after: contextSchema,
    evidence: z.string().regex(/^[a-f0-9]{32}$/),
  })
  .strict();
export const backupSchema = z
  .object({
    format: z.literal('haive-context-backfill-v1'),
    database: z.string(),
    createdAt: z.string(),
    afterVersion: z.string().regex(/^\d+$/),
    rows: z.array(rowSchema).max(MAX_STEPS),
  })
  .strict();
export type ContextBackup = z.infer<typeof backupSchema>;
type PlannedRow = ContextBackup['rows'][number];
type Reader = Pick<Database, 'execute'>;
interface Snapshot {
  id: string;
  taskId: string;
  version: string;
  endedAt: string;
  before: ContextStamp;
  evidence: string;
}
export interface Scope {
  limit?: number;
  after?: string;
  taskId?: string;
  stepId?: string;
}
export interface Inventory {
  candidate: number;
  changed: number;
  unchanged: number;
  ambiguous: number;
  missing: number;
  elidedInvocations: number;
  missingInvocations: number;
  oversizedInvocations: number;
  unsupportedInvocations: number;
  lowerBoundSamples: Array<{ invocationId: string; peakLowerBound: number | null }>;
  nextAfter: string | null;
  hasMore: boolean;
  rows: PlannedRow[];
  reasons: Record<string, number>;
}

/** Only relevant metadata plus a digest, never raw evidence, enters an artifact. xmin also fences edits
 *  to invocation columns we do not inspect. Ordered aggregate detects inserts/deletes/superseding. */
const evidenceSql = sql`coalesce((select md5(string_agg(md5(jsonb_build_array(i.id, i.xmin::text,
  i.cli_provider_id, i.mode, i.token_usage, i.model_identity, i.started_at, i.ended_at,
  i.superseded_at, md5(i.stream_log))::text), '' order by i.id))
  from cli_invocations i where i.task_step_id = s.id), md5(''))`;
async function snapshot(db: Reader, id: string): Promise<Snapshot | null> {
  const [row] = await db.execute<
    Snapshot & Record<string, unknown>
  >(sql`select s.id, s.task_id as "taskId", s.xmin::text as version,
    s.ended_at::text as "endedAt", jsonb_build_object('tokens',s.context_tokens,'window',s.context_window_size,'left',s.context_left_percent) as before,
    ${evidenceSql} as evidence from task_steps s where s.id=${id}::uuid and s.status='done' and s.ended_at is not null`);
  return row ?? null;
}

export async function inventoryContext(db: Database, scope: Scope = {}): Promise<Inventory> {
  const limit = scope.limit ?? 25;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_STEPS)
    throw new Error('limit must be 1..100');
  const filters: SQL[] = [
    sql`s.status='done'`,
    sql`s.ended_at is not null`,
    sql`(s.context_tokens is not null or exists(select 1 from cli_invocations i where i.task_step_id=s.id and i.superseded_at is null and i.mode <> 'agent_mining'))`,
  ];
  if (scope.after) filters.push(sql`s.id > ${z.uuid().parse(scope.after)}::uuid`);
  if (scope.taskId) filters.push(sql`s.task_id = ${z.uuid().parse(scope.taskId)}::uuid`);
  if (scope.stepId) filters.push(sql`s.id = ${z.uuid().parse(scope.stepId)}::uuid`);
  const ids = await db.execute<{ id: string }>(
    sql`select s.id from task_steps s where ${sql.join(filters, sql` and `)} order by s.id limit ${limit + 1}`,
  );
  const result: Inventory = {
    candidate: 0,
    changed: 0,
    unchanged: 0,
    ambiguous: 0,
    missing: 0,
    elidedInvocations: 0,
    missingInvocations: 0,
    oversizedInvocations: 0,
    unsupportedInvocations: 0,
    lowerBoundSamples: [],
    nextAfter: null,
    hasMore: ids.length > limit,
    rows: [],
    reasons: {},
  };
  for (const { id } of ids.slice(0, limit)) {
    result.candidate++;
    result.nextAfter = id;
    const original = await snapshot(db, id);
    let decision: Decision;
    if (!original) {
      result.ambiguous++;
      continue;
    }
    const invs = await db.execute<{
      id: string;
      usage: Record<string, unknown> | null;
      bytes: number | null;
      ended: boolean;
      providerName: string | null;
    }>(
      sql`select i.id, i.token_usage as usage, octet_length(i.stream_log) as bytes, i.ended_at is not null as ended, p.name as "providerName" from cli_invocations i left join cli_providers p on p.id=i.cli_provider_id where i.task_step_id=${id}::uuid and i.superseded_at is null and i.mode <> 'agent_mining' order by i.id limit ${MAX_INVOCATIONS + 1}`,
    );
    if (invs.length > MAX_INVOCATIONS || invs.some((i) => !i.ended))
      decision = { kind: 'ambiguous', reason: 'too many or unended invocations' };
    else {
      const contexts: ContextInvocation[] = [];
      for (const inv of invs) {
        let replay: Replay;
        if (inv.bytes === null) {
          result.missingInvocations++;
          replay = replayContext(null);
        } else if (inv.bytes > MAX_LOG_BYTES) {
          result.oversizedInvocations++;
          replay = { ...replayContext(null), state: 'ambiguous' };
        } else {
          const [log] = await db.execute<{ stream: string | null }>(
            sql`select case when octet_length(stream_log) <= ${MAX_LOG_BYTES} then stream_log end as stream from cli_invocations where id=${inv.id}::uuid`,
          );
          replay = replayContext(log?.stream ?? null);
        }
        if (replay.state === 'partial') {
          result.elidedInvocations++;
          if (result.lowerBoundSamples.length < 20)
            result.lowerBoundSamples.push({ invocationId: inv.id, peakLowerBound: replay.peak });
        }
        if (replay.format === 'codex-exec' || replay.format === 'unknown')
          result.unsupportedInvocations++;
        contexts.push({ id: inv.id, usage: inv.usage, replay, providerName: inv.providerName });
      }
      decision = deriveContext(original.before, contexts);
      const latest = await snapshot(db, id);
      if (!latest || latest.version !== original.version || latest.evidence !== original.evidence)
        decision = { kind: 'ambiguous', reason: 'changed during inventory' };
    }
    result[decision.kind]++;
    result.reasons[decision.reason] = (result.reasons[decision.reason] ?? 0) + 1;
    if (decision.kind === 'changed') result.rows.push({ ...original, after: decision.after! });
  }
  return result;
}

async function databaseIdentity(db: Reader): Promise<string> {
  const [row] = await db.execute<{ identity: string }>(
    sql`select jsonb_build_array(current_database(), (select oid::text from pg_database where datname=current_database()), inet_server_addr()::text, inet_server_port())::text as identity`,
  );
  return row!.identity;
}

export async function saveContextBackup(
  root: string,
  rel: string,
  backup: ContextBackup,
): Promise<void> {
  backupSchema.parse(backup);
  const parent = path.posix.dirname(rel);
  if (parent === '.')
    throw new Error('backup must be below an existing subdirectory of artifact-root');
  // File fsync and containing directory fsync BOTH precede the first database mutation.
  const directory = await openDirNoFollow(root, parent);
  try {
    await writeFileNoFollow(root, rel, JSON.stringify(backup) + '\n', {
      mode: 'create-exclusive',
      fileMode: 0o400,
      durable: true,
    });
    await directory.sync();
  } finally {
    await directory.close();
  }
}
export async function readContextBackup(root: string, rel: string): Promise<ContextBackup> {
  const read = await readFileNoFollow(root, rel, { strict: true, maxBytes: 1024 * 1024 });
  if (!read || read.truncated) throw new Error('missing or oversized backup');
  return backupSchema.parse(JSON.parse(read.data.toString('utf8')));
}

export interface MutationResult {
  planned: number;
  written: number;
  conflicts: number;
  conflictIds: string[];
}
/** NOWAIT everywhere: follow run → step order, without a task-row lock. Taking
 *  a KEY UPDATE lock on the step also blocks new invocation FK inserts until the evidence check
 *  and mutation finish. A savepoint releases a conflicted row's locks; no filesystem IO is here. */
async function mutate(
  db: Database,
  rows: PlannedRow[],
  expectedVersion: string | null,
  apply: boolean,
): Promise<MutationResult> {
  const result: MutationResult = {
    planned: rows.length,
    written: 0,
    conflicts: 0,
    conflictIds: [],
  };
  for (const row of rows) {
    await db.execute(sql`savepoint haive_context_row`);
    try {
      // Keep query failures inside postgres.js's own savepoint scope too: it remembers any
      // rejected query in a scope and rejects that transaction even after a manual ROLLBACK TO.
      await db.transaction(async (tx) => {
        await tx.execute(
          sql`select id from cli_invocations where task_step_id=${row.id}::uuid order by id for update nowait`,
        );
        await tx.execute(sql`select id from task_steps where id=${row.id}::uuid for update nowait`);
        const current = await snapshot(tx, row.id);
        const expected = expectedVersion === null ? row.before : row.after;
        if (
          !current ||
          current.taskId !== row.taskId ||
          current.version !== (expectedVersion ?? row.version) ||
          current.endedAt !== row.endedAt ||
          current.evidence !== row.evidence ||
          current.before.tokens !== expected.tokens ||
          current.before.window !== expected.window ||
          current.before.left !== expected.left
        )
          throw new Error('context-backfill-conflict');
      });
    } catch (err) {
      await db.execute(sql`rollback to savepoint haive_context_row`);
      await db.execute(sql`release savepoint haive_context_row`);
      const cause = err as { message?: string; code?: string; cause?: { code?: string } };
      if (
        cause.message !== 'context-backfill-conflict' &&
        cause.code !== '55P03' &&
        cause.cause?.code !== '55P03'
      )
        throw err;
      result.conflicts++;
      result.conflictIds.push(row.id);
      continue;
    }
    // postgres.js's savepoint callback does NOT issue RELEASE on success. Explicit RELEASE is
    // essential: release our enclosing named savepoint (and all library savepoints beneath it)
    // so the UPDATE's xmin is the parent xid already saved in the durable plan.
    await db.execute(sql`release savepoint haive_context_row`);
    if (apply) {
      const after = expectedVersion === null ? row.after : row.before;
      await db.execute(
        sql`update task_steps set context_tokens=${after.tokens}, context_window_size=${after.window}, context_left_percent=${after.left} where id=${row.id}::uuid`,
      );
      result.written++;
    }
  }
  return result;
}

/** Allocate the transaction's resulting xmin before writing its immutable plan. A crash after
 *  any UPDATE still leaves the exact undo version on disk, even if no receipt was printed. */
export async function applyContextInventory(
  db: Database,
  inventory: Inventory,
  root: string,
  rel: string,
): Promise<MutationResult> {
  return db.transaction(async (tx) => {
    const [version] = await tx.execute<{ version: string }>(
      sql`select (pg_current_xact_id()::text::numeric % 4294967296)::text as version`,
    );
    const backup: ContextBackup = {
      format: 'haive-context-backfill-v1',
      database: await databaseIdentity(tx),
      createdAt: new Date().toISOString(),
      afterVersion: version!.version,
      rows: inventory.rows,
    };
    await saveContextBackup(root, rel, backup);
    // Nested transactions are savepoints; each successful row shares this durable planned xmin.
    return mutate(tx as unknown as Database, backup.rows, null, true);
  });
}
export async function undoContextBackup(
  db: Database,
  backup: ContextBackup,
  apply = false,
): Promise<MutationResult> {
  backupSchema.parse(backup);
  if ((await databaseIdentity(db)) !== backup.database)
    throw new Error('backup belongs to another database');
  return db.transaction(async (tx) =>
    mutate(tx as unknown as Database, backup.rows, backup.afterVersion, apply),
  );
}
