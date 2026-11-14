/** Explicit, SELECT-only operator replay. Never loads .env, calls a model, or writes files.
 * From packages/worker: pnpm exec tsx scripts/replay-request-usage.ts [--since ISO] [--limit N] [--cli NAME]
 * DATABASE_URL comes only from the operator environment. One aggregate JSON on stdout.
 * Replays the live stream-json and Codex app-server parsers; other channels have no request list.
 */
import { pathToFileURL } from 'node:url';
import { Writable } from 'node:stream';
import { createDatabase, type Database } from '@haive/database';
import { CLI_PROVIDER_LIST } from '@haive/shared';
import { createStreamJsonCollector } from '../src/queues/cli-exec/stream.js';
import { isElidedStreamLog } from '../src/queues/cli-exec/stream-log-buffer.js';
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
  incompleteReasons: Record<string, number>;
}
const counts = (): Counts => ({
  invocations: 0,
  complete: 0,
  incomplete: 0,
  none: 0,
  incompleteReasons: {},
});

export function parseOptions(args: string[]) {
  const options: { since: string | null; limit: number; cli: string | null } = {
    since: null,
    limit: 1000,
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

/** Fake row sources use exactly the same collector as database rows. No ids or text in results. */
export async function replayRequestUsage(source: AsyncIterable<ReplayRow> | Iterable<ReplayRow>) {
  const total = counts();
  const byCli = new Map<string, Counts>();
  const byMainModel = new Map<string, Counts>();
  const counters = {
    sameNameSideModelCandidates: 0,
    sameNameLedgerExcessRuns: 0,
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
    // Stored logs include terminal framing and stderr. As in replayContext, only top-level
    // object lines are events; pass broken object lines too so the real parser refuses them.
    for (const line of row.streamLog.split('\n')) {
      if (!line.trimStart().startsWith('{')) continue;
      collector.onChunk(line + '\n');
      codex?.onChunk(line + '\n');
      try {
        const event = JSON.parse(line);
        appServer ||= typeof event.method === 'string';
      } catch {
        /* The live parsers count malformed event lines. */
      }
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
    if (isElidedStreamLog(row.streamLog)) reasons.add('elided-stream');
    const coverage = !hasChannel
      ? 'none'
      : capture.coverage === 'complete' && reasons.size === 0
        ? 'complete'
        : 'incomplete';
    if (!hasChannel) {
      reasons.clear();
      reasons.add('no-request-channel');
    }
    const cliCounts = byCli.get(cli) ?? counts();
    const modelCounts = byMainModel.get(model) ?? counts();
    byCli.set(cli, cliCounts);
    byMainModel.set(model, modelCounts);
    for (const bucket of [total, cliCounts, modelCounts]) {
      bucket.invocations++;
      bucket[coverage]++;
      if (coverage !== 'complete')
        for (const reason of reasons)
          bucket.incompleteReasons[reason] = (bucket.incompleteReasons[reason] ?? 0) + 1;
    }
    counters.sameNameLedgerExcessRuns += Number(diagnostics.sameNameLedgerExcess);
    // VOLATILE: Haiku is the measured Claude titling family. Excess is a candidate,
    // not proof of a side call: raw streams do not identify CLI-owned requests.
    counters.sameNameSideModelCandidates += Number(
      diagnostics.sameNameLedgerExcess && /^claude-haiku(?:-|$)/.test(model),
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
      'retained stream-json and Codex app-server; channels without request lists count as none',
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
