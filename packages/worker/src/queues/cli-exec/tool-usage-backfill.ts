import { and, count, desc, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import { logger, type InvocationToolUsage } from '@haive/shared';
import { SANDBOX_WORKDIR } from '../../sandbox/sandbox-runner.js';
import {
  applyProviderObservability,
  createToolUsageTally,
  unobservedToolUsage,
  type ToolUsageTally,
} from '../../cli-executor/tool-usage.js';
import { isElidedStreamLog } from './stream-log-buffer.js';

/* ------------------------------------------------------------------ */
/* Backfill cli_invocations.tool_usage from stored transcripts         */
/* ------------------------------------------------------------------ */
/* The live collectors write `tool_usage` for every run from the day they shipped. Everything
 * before that sits in `stream_log` — MEASURED on the dev install: 3,367 transcripts, 782 MB —
 * and this reads it back through the SAME tally the collectors feed, so the two cannot
 * disagree about what a run used.
 *
 * Runs at boot as a convergent data migration with a time budget (a large install converges
 * over a few boots instead of holding one boot for the whole rewrite), and from
 * `scripts/backfill-tool-usage.ts` for a one-shot full run. Idempotent by construction: it
 * selects `tool_usage IS NULL` and writes every examined row, so a re-run finds nothing — a
 * row whose transcript carries no tool events gets `coverage: 'none'` rather than staying
 * NULL, which is the whole reason that value exists (see the column's note). */

const log = logger.child({ module: 'tool-usage-backfill' });

/** Justified against the measurement above: 232 KB per row on average, one `JSON.parse` per
 *  line — what the live collector does in real time — so the whole dev install is ~15-30 s.
 *  10 s a boot converges in two or three boots and bounds the boot delay, since data
 *  migrations run before any queue starts. Batches of 25 keep at most 100 MB of transcript in
 *  flight at the 4 MiB head+tail cap. */
export const TOOL_USAGE_BACKFILL_BOOT_BUDGET_MS = 10_000;
export const TOOL_USAGE_BACKFILL_BATCH_SIZE = 25;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `2026-09-14 07:01:44.848` — the zone-less form a `timestamp without time zone` column
 *  compares against directly. Exported for the test. */
export function timestampLiteral(date: Date): string {
  return date.toISOString().replace('T', ' ').replace('Z', '');
}

/** Feed one parsed transcript line to the tally, dispatching on the line's SHAPE rather than
 *  on the provider: the three vocabularies are disjoint (claude-family `type` in
 *  `system|assistant|user|result|…`, codex exec `type` in `thread.*|turn.*|item.*|error`,
 *  app-server `method`/`id`), and one codex row can hold an app-server transcript followed by
 *  the exec fallback's. Exactly the events the live collectors feed, nothing more, so a
 *  backfilled record and a live one read the same run identically. */
function feedTranscriptLine(tally: ToolUsageTally, event: Record<string, unknown>): void {
  if (event.type === 'system' && event.subtype === 'init') {
    tally.claudeInit(event);
    return;
  }
  if (event.type === 'assistant') {
    const message = isRecord(event.message) ? event.message : null;
    const content = message && Array.isArray(message.content) ? message.content : [];
    for (const block of content) {
      if (isRecord(block) && block.type === 'tool_use' && typeof block.name === 'string') {
        tally.claudeToolUse(block.name, block.input);
      }
    }
    return;
  }
  if (event.type === 'item.completed' && isRecord(event.item)) {
    tally.codexExecItem(event.item);
    return;
  }
  if (event.method === 'item/completed' && isRecord(event.params) && isRecord(event.params.item)) {
    tally.codexAppServerItem(event.params.item);
  }
}

/** One stored transcript → one record. Pure, so the tests and the script drive it directly.
 *
 *  The transcript is the persisted replay: the ANSI command header, the CLI's own lines, stderr
 *  chunks, the `[you] …` steer echoes and the elision marker. Only a line that starts with `{`
 *  and parses is an event; everything else falls out here. A null transcript, or one that
 *  carried no tool-bearing event, is `coverage: 'none'`, and the elision marker downgrades a
 *  parsed one to `partial`, since a count over a transcript missing its middle is a floor. */
export function toolUsageFromStreamLog(
  providerName: string | null,
  streamLog: string | null,
  workdir: string,
): InvocationToolUsage {
  if (streamLog === null) return unobservedToolUsage('backfill');
  const tally = createToolUsageTally({ workdir });
  for (const rawLine of streamLog.split('\n')) {
    const line = rawLine.trim();
    if (!line.startsWith('{')) continue;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (isRecord(event)) feedTranscriptLine(tally, event);
  }
  const usage = tally.finalize('backfill', isElidedStreamLog(streamLog));
  return applyProviderObservability(usage, providerName) ?? usage;
}

export interface ToolUsageBackfillOptions {
  /** Wall-clock budget; checked between batches, so the overshoot is at most one batch. */
  budgetMs: number;
  batchSize: number;
  /** False = examine and count without writing (the script's dry run). */
  apply: boolean;
  /** The sandbox mount root the transcripts' paths are relative to. */
  workdir?: string;
  /** Every examined row, in order — the script prints a sample from it. */
  onRow?: (invocationId: string, providerName: string | null, usage: InvocationToolUsage) => void;
}

export interface ToolUsageBackfillResult {
  examined: number;
  full: number;
  partial: number;
  none: number;
  written: number;
  /** Rows still matching the selection when the run stopped. */
  remaining: number;
  elapsedMs: number;
  budgetExhausted: boolean;
}

/** Examine every ended invocation whose `tool_usage` is still NULL, newest first, and write
 *  what its transcript says it used.
 *
 *  Keyset-paged on `(ended_at, id)` in BOTH modes, so a dry run cannot spin on rows it never
 *  writes and an apply run does not depend on the predicate shrinking underneath it. The write
 *  is a compare-and-swap on `tool_usage IS NULL`: a completion write that raced this one wins.
 *  A row whose transcript throws is logged with its id and skipped — it stays NULL and visible,
 *  which is a bug signal rather than a data state, since every input path here is defensive. */
export async function backfillToolUsage(
  db: Database,
  opts: ToolUsageBackfillOptions,
): Promise<ToolUsageBackfillResult> {
  const startedAt = Date.now();
  const workdir = opts.workdir ?? SANDBOX_WORKDIR;
  const result: ToolUsageBackfillResult = {
    examined: 0,
    full: 0,
    partial: 0,
    none: 0,
    written: 0,
    remaining: 0,
    elapsedMs: 0,
    budgetExhausted: false,
  };
  const inv = schema.cliInvocations;
  const base = and(isNull(inv.toolUsage), isNotNull(inv.endedAt));
  // The cursor's timestamp travels as a LITERAL with an explicit cast, never as a JS Date: inside
  // a raw `sql` tuple drizzle hands the value to postgres.js unmapped, and postgres.js has no
  // serializer for `timestamp without time zone`, so a Date bound there fails the Bind step
  // ("must be of type string … Received an instance of Date") — MEASURED on the dev install at
  // the second batch of the first boot. The column holds UTC wall clock, which is what the
  // zone-less ISO form is.
  let cursor: { endedAt: string; id: string } | null = null;

  for (;;) {
    if (Date.now() - startedAt > opts.budgetMs) {
      result.budgetExhausted = true;
      break;
    }
    const rows = await db
      .select({
        id: inv.id,
        endedAt: inv.endedAt,
        streamLog: inv.streamLog,
        providerName: schema.cliProviders.name,
      })
      .from(inv)
      .leftJoin(schema.cliProviders, eq(schema.cliProviders.id, inv.cliProviderId))
      .where(
        cursor
          ? and(
              base,
              sql`(${inv.endedAt}, ${inv.id}) < (${cursor.endedAt}::timestamp, ${cursor.id}::uuid)`,
            )
          : base,
      )
      .orderBy(desc(inv.endedAt), desc(inv.id))
      .limit(opts.batchSize);
    if (rows.length === 0) break;

    for (const row of rows) {
      cursor = { endedAt: timestampLiteral(row.endedAt as Date), id: row.id };
      let usage: InvocationToolUsage;
      try {
        usage = toolUsageFromStreamLog(row.providerName ?? null, row.streamLog, workdir);
      } catch (err) {
        log.error({ err, invocationId: row.id }, 'tool usage backfill could not read a transcript');
        continue;
      }
      result.examined += 1;
      result[usage.coverage] += 1;
      opts.onRow?.(row.id, row.providerName ?? null, usage);
      if (!opts.apply) continue;
      const written = await db
        .update(inv)
        .set({ toolUsage: usage })
        .where(and(eq(inv.id, row.id), isNull(inv.toolUsage)))
        .returning({ id: inv.id });
      result.written += written.length;
    }
  }

  const [pending] = await db.select({ n: count() }).from(inv).where(base);
  // A dry run wrote nothing, so what it examined still matches the selection.
  result.remaining = Math.max(0, Number(pending?.n ?? 0) - (opts.apply ? 0 : result.examined));
  result.elapsedMs = Date.now() - startedAt;
  return result;
}

/** The boot-time entry: budgeted, and quiet when there is nothing to do. */
export async function backfillToolUsageAtBoot(db: Database): Promise<void> {
  const result = await backfillToolUsage(db, {
    budgetMs: TOOL_USAGE_BACKFILL_BOOT_BUDGET_MS,
    batchSize: TOOL_USAGE_BACKFILL_BATCH_SIZE,
    apply: true,
  });
  if (result.examined > 0) {
    log.info(
      {
        examined: result.examined,
        full: result.full,
        partial: result.partial,
        none: result.none,
        written: result.written,
        remaining: result.remaining,
        elapsedMs: result.elapsedMs,
      },
      'backfilled tool usage on stored transcripts',
    );
  }
  if (result.budgetExhausted && result.remaining > 0) {
    log.info(
      { remaining: result.remaining },
      'tool usage backfill paused at its boot budget; resumes next boot',
    );
  }
}
