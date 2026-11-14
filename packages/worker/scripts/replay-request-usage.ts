/** Explicit, SELECT-only operator replay. Never loads .env, calls a model, or writes files.
 * From packages/worker: pnpm exec tsx scripts/replay-request-usage.ts [--since ISO] [--limit N] [--cli NAME]
 * DATABASE_URL comes only from the operator environment. One aggregate JSON on stdout.
 * Replays the live stream-json and Codex app-server parsers; other channels have no request list.
 * stream_log is header + interleaved stdout/stderr without channel framing. Replay accepts only
 * complete single-line event objects; skipped object-like lines are counted separately. General
 * malformed-stream evidence is therefore unobservable and excluded. A broken line beginning with
 * an event discriminator is separately reported as malformed-event-line, never fed to a parser.
 * Elided or byte-cap-sized transcripts have unknown-truncated coverage. Defaults to all rows,
 * read in bounded cursor batches; --limit optionally narrows the inventory.
 */
import { pathToFileURL } from 'node:url';
import { Writable } from 'node:stream';
import { createDatabase, type Database } from '@haive/database';
import { CLI_PROVIDER_LIST } from '@haive/shared';
import { createStreamJsonCollector } from '../src/queues/cli-exec/stream.js';
import {
  isElidedStreamLog,
  STREAM_LOG_HEAD_CHARS,
  STREAM_LOG_TAIL_CHARS,
} from '../src/queues/cli-exec/stream-log-buffer.js';
import { createCodexAppServerSession } from '../src/cli-executor/codex-app-server.js';

export interface ReplayRow {
  cli: string | null;
  mainModel: string | null;
  streamLog: string;
  exitCode: number | null;
  ended?: boolean;
}
interface Counts {
  invocations: number;
  complete: number;
  incomplete: number;
  none: number;
  'unknown-truncated': number;
  truncatedLogs: number;
  skippedNonEventLines: number;
  malformedEventLines: number;
  incompleteReasons: Record<string, number>;
}
const counts = (): Counts => ({
  invocations: 0,
  complete: 0,
  incomplete: 0,
  none: 0,
  'unknown-truncated': 0,
  truncatedLogs: 0,
  skippedNonEventLines: 0,
  malformedEventLines: 0,
  incompleteReasons: {},
});

// Half-open buckets; the final bucket is unbounded. Zero-prompt output-only excess
// belongs in the first bucket. Runs with no excess do not enter the histogram.
const EXCESS_PROMPT_BUCKET_EDGES = [0, 1000, 10_000, 100_000, 200_000, 272_000] as const;
const excessCounts = () => ({
  histogram: EXCESS_PROMPT_BUCKET_EDGES.map((minInclusive, i) => ({
    minInclusive,
    maxExclusive: EXCESS_PROMPT_BUCKET_EDGES[i + 1] ?? null,
    runs: 0,
  })),
  // Conservative potential ambiguity, including inclusive tiers at the boundary.
  // These are bounds on unattributed usage, never inferred request sizes or prices.
  atOrAboveTierThreshold: { '100000': 0, '200000': 0, '272000': 0 },
});
type ModelCounts = Counts & { sameModelExcess: ReturnType<typeof excessCounts> };

export function parseOptions(args: string[]) {
  const options: { since: string | null; limit: number | null; cli: string | null } = {
    since: null,
    limit: null,
    cli: null,
  };
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i]!;
    const value = args[i + 1];
    if (!['--since', '--limit', '--cli'].includes(flag) || !value || seen.has(flag))
      throw new Error('invalid replay option');
    seen.add(flag);
    if (flag === '--since') {
      if (
        !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) ||
        !Number.isFinite(Date.parse(value))
      )
        throw new Error('since must be an ISO timestamp with timezone');
      options.since = new Date(value).toISOString();
    } else if (flag === '--limit') {
      if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1)
        throw new Error('limit must be a positive safe integer');
      options.limit = Number(value);
    } else {
      if (!CLI_PROVIDER_LIST.some((p) => p.name === value)) throw new Error('unknown CLI');
      options.cli = value;
    }
  }
  return options;
}

// The writer caps characters, not bytes. Treat this byte threshold conservatively too,
// including legacy markerless logs: a retained transcript at the cap cannot prove completeness.
export const REPLAY_STREAM_LOG_BYTE_CAP = STREAM_LOG_HEAD_CHARS + STREAM_LOG_TAIL_CHARS;

/** Fake row sources use exactly the same collector as database rows. No ids or text in results. */
export async function replayRequestUsage(
  source: AsyncIterable<ReplayRow> | Iterable<ReplayRow>,
  options: { streamLogByteCap?: number } = {},
) {
  const total = counts();
  const byCli = new Map<string, Counts>();
  const byMainModel = new Map<string, ModelCounts>();
  const counters = {
    sameNameSideModelCandidates: 0,
    sameNameLedgerExcessRuns: 0,
    unobservedSameModelRuns: 0,
    absentModelUsageAcceptedComplete: 0,
    emptyModelUsageAcceptedComplete: 0,
    outputOnlyContradictoryRuns: 0,
    killedFallbackRuns: 0,
    noResultFallbackRuns: 0,
    fallbackOutputZeroRuns: 0,
  };
  for await (const row of source) {
    const collector = createStreamJsonCollector();
    const codex =
      row.cli === 'codex'
        ? createCodexAppServerSession({ prompt: '', model: null, effort: null })
        : null;
    // Handshake output goes to a memory-only sink: no process, provider or network call.
    const sink = new Writable({
      write(_chunk, _encoding, done) {
        done();
      },
    });
    codex?.attach(sink);
    let appServer = false;
    let skippedNonEventLines = 0;
    let malformedEventLines = 0;
    const truncated =
      isElidedStreamLog(row.streamLog) ||
      Buffer.byteLength(row.streamLog) >= (options.streamLogByteCap ?? REPLAY_STREAM_LOG_BYTE_CAP);
    for (const line of row.streamLog.split('\n')) {
      if (!line.trimStart().startsWith('{')) continue;
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(line);
      } catch {
        skippedNonEventLines++;
        // A compact event discriminator cut off mid-line is different from the bare "{"
        // of pretty-printed stderr. Report it independently of the live malformed counter.
        if (/^\s*\{\s*"(?:type|method|id)"\s*:/.test(line)) malformedEventLines++;
        continue;
      }
      const streamEvent = typeof event.type === 'string';
      const rpcEvent =
        typeof event.method === 'string' ||
        typeof event.id === 'string' ||
        typeof event.id === 'number';
      if (!streamEvent && !rpcEvent) {
        skippedNonEventLines++;
        continue;
      }
      collector.onChunk(line + '\n');
      codex?.onChunk(line + '\n');
      appServer ||= codex !== null && !streamEvent && rpcEvent;
    }
    codex?.close();
    sink.destroy();
    const capture = appServer && codex ? codex.getRequestUsage() : collector.getRequestUsage();
    const diagnostics = collector.getRequestUsageDiagnostics();
    const identity = appServer && codex ? codex.getModelReport() : collector.getModelIdentity();
    const model = identity?.served ?? identity?.requested ?? row.mainModel ?? 'unknown';
    const cli = row.cli ?? 'unknown';
    const reasons = new Set(capture.reasons);
    // These CLIs have their own aggregate-only envelopes; an antigravity result is
    // not a Claude result just because both call the event "result".
    const hasChannel =
      !['gemini', 'antigravity'].includes(cli) &&
      (appServer ||
        (capture.requests?.length ?? 0) > 0 ||
        diagnostics.resultCount > 0 ||
        identity !== null);
    if (appServer && collector.getRequestUsage().requests?.length)
      reasons.add('mixed-request-channels');
    // Transcript noise must never manufacture the live parser's malformed-stream reason.
    reasons.delete('malformed-stream');
    if (malformedEventLines > 0) reasons.add('malformed-event-line');
    const coverage = truncated
      ? 'unknown-truncated'
      : !hasChannel && malformedEventLines === 0
        ? 'none'
        : capture.coverage === 'complete' && reasons.size === 0
          ? 'complete'
          : 'incomplete';
    if (coverage === 'unknown-truncated') {
      reasons.clear();
    } else if (coverage === 'none') {
      reasons.clear();
      reasons.add('no-request-channel');
    }
    const cliCounts = byCli.get(cli) ?? counts();
    const modelCounts = byMainModel.get(model) ?? { ...counts(), sameModelExcess: excessCounts() };
    byCli.set(cli, cliCounts);
    byMainModel.set(model, modelCounts);
    for (const bucket of [total, cliCounts, modelCounts]) {
      bucket.invocations++;
      bucket[coverage]++;
      bucket.truncatedLogs += Number(truncated);
      bucket.skippedNonEventLines += skippedNonEventLines;
      bucket.malformedEventLines += malformedEventLines;
      if (coverage !== 'complete')
        for (const reason of reasons)
          bucket.incompleteReasons[reason] = (bucket.incompleteReasons[reason] ?? 0) + 1;
    }
    if (coverage === 'complete' && capture.unobservedSameModel?.length) {
      const promptTokens = capture.unobservedSameModel.reduce(
        (sum, usage) => sum + usage.inputTokens + usage.cacheReadTokens + usage.cacheCreationTokens,
        0,
      );
      const magnitude = modelCounts.sameModelExcess;
      magnitude.histogram.find(
        (bucket) => bucket.maxExclusive === null || promptTokens < bucket.maxExclusive,
      )!.runs++;
      for (const threshold of ['100000', '200000', '272000'] as const)
        magnitude.atOrAboveTierThreshold[threshold] += Number(promptTokens >= Number(threshold));
    }
    if (truncated) continue;
    counters.sameNameLedgerExcessRuns += Number(
      coverage === 'complete' && diagnostics.sameNameLedgerExcess,
    );
    counters.unobservedSameModelRuns += Number(
      coverage === 'complete' && (capture.unobservedSameModel?.length ?? 0) > 0,
    );
    // VOLATILE: Haiku is the measured Claude titling family. Excess is a candidate,
    // not proof of a side call: raw streams do not identify CLI-owned requests.
    counters.sameNameSideModelCandidates += Number(
      coverage === 'complete' &&
        diagnostics.sameNameLedgerExcess &&
        /^claude-haiku(?:-|$)/.test(model),
    );
    counters.absentModelUsageAcceptedComplete += Number(
      diagnostics.absentModelUsageAcceptedComplete && coverage === 'complete',
    );
    counters.emptyModelUsageAcceptedComplete += Number(
      diagnostics.emptyModelUsageAcceptedComplete && coverage === 'complete',
    );
    counters.outputOnlyContradictoryRuns += Number(
      diagnostics.outputOnlyContradiction && reasons.has('contradictory-request'),
    );
    const fallback =
      !appServer &&
      hasChannel &&
      diagnostics.resultCount === 0 &&
      collector.getTokenUsage() !== null;
    counters.noResultFallbackRuns += Number(fallback);
    counters.killedFallbackRuns += Number(
      fallback &&
        (row.exitCode === 137 ||
          row.exitCode === 143 ||
          (row.exitCode === null && row.ended === true)),
    );
    counters.fallbackOutputZeroRuns += Number(
      fallback && collector.getTokenUsage()?.outputTokens === 0,
    );
  }
  return {
    scope:
      'retained single-line stream-json and Codex app-server events; malformed-stream unobservable; truncated logs unknown-truncated; channels without request lists count as none',
    total,
    byCli: [...byCli].sort(([a], [b]) => a.localeCompare(b)).map(([cli, c]) => ({ cli, ...c })),
    byMainModel: [...byMainModel]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([model, c]) => ({ model, ...c })),
    counters,
  };
}

export async function replayDatabase(db: Database, options: ReturnType<typeof parseOptions>) {
  // Server-enforced read-only from BEGIN, including cursor fetches. No table locks or writes.
  return db.$client.begin('isolation level repeatable read read only', async (tx) => {
    const rows = tx<ReplayRow[]>`
      SELECT p.name AS cli,
             COALESCE(i.model_identity->>'served', i.model_identity->>'requested') AS "mainModel",
             i.stream_log AS "streamLog", i.exit_code AS "exitCode", i.ended_at IS NOT NULL AS ended
      FROM cli_invocations i LEFT JOIN cli_providers p ON p.id = i.cli_provider_id
      WHERE i.stream_log IS NOT NULL
        AND (${options.since}::timestamp IS NULL OR i.created_at >= ${options.since}::timestamp)
        AND (${options.cli}::text IS NULL OR p.name::text = ${options.cli})
      ORDER BY i.created_at DESC, i.id DESC LIMIT ${options.limit}
    `;
    async function* source() {
      for await (const batch of rows.cursor(50)) for (const row of batch) yield row;
    }
    return { options, ...(await replayRequestUsage(source())) };
  });
}

async function main() {
  let db: Database | undefined;
  try {
    const options = parseOptions(process.argv.slice(2));
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL required');
    db = createDatabase(process.env.DATABASE_URL);
    process.stdout.write(JSON.stringify(await replayDatabase(db, options)) + '\n');
  } catch {
    // Database errors can include query values or connection credentials. Emit neither.
    process.stderr.write('Request-usage replay refused or failed; no raw error emitted.\n');
    process.exitCode = 1;
  } finally {
    try {
      await db?.$client.end({ timeout: 5 });
    } catch {
      process.stderr.write(
        'Request-usage replay connection shutdown failed; no raw error emitted.\n',
      );
      process.exitCode = 1;
    }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
