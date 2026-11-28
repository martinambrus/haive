import { sql, type SQL } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import type { FilesReadGroupRow, FilesReadPathRow, FilesReadRollup } from '../stats/files-read.js';

/**
 * The SQL rollup behind the "Files read" report: `cli_invocations.tool_usage -> 'reads'`, one
 * record per run, summed per path and per (step, provider) group. `buildFilesRead` (stats) shapes
 * the result; the population each `FilesReadGroupRow` field sums over is named on the type.
 *
 * Like `rollupToolUsage`, the CALLER composes `where` (scope, attribution, window) and this never
 * decides which rows count. A record may be absent, a JSON null, or an object, and
 * `jsonb_array_elements` throws on a JSON null, so every path is read through a `jsonb_typeof`
 * guard. Characters and tokens exceed 2^31 on a busy install: sums are double precision, never
 * `::int`.
 *
 * Cost is the shape of the SQL. MEASURED on synthetic rows (8,333 runs of 50 listed paths,
 * postgres:18-bookworm): the record is read once per run by the `rr` lateral, because every
 * `tool_usage -> 'reads'` detoasts and copies the whole record (86 of them per row made the group
 * query 3.5 s, now 0.32 s); the per-path query reads each element's numbers once, before it
 * groups, groups under `COLLATE "C"` (the locale's strcoll doubled the sort) and counts entries,
 * not `count(distinct)`, which forces a sort per aggregate (2.5 s, now 0.5 s). Counting entries is
 * exact because a run's `files` holds each path once: the recorder keys it by path
 * (`read-exposure.ts`, the `files` Map).
 */

export interface FilesReadRollupOptions {
  where: SQL;
  /** Paths the per-path query returns; the distinct-path count is taken before the cut. */
  rowLimit: number;
}

const inv = schema.cliInvocations;
/** The run's record, as the `rr` lateral in `from` extracted it once. */
const reads = sql`rr.r`;

const arr = (path: SQL): SQL =>
  sql`(case when jsonb_typeof(${path}) = 'array' then ${path} else '[]'::jsonb end)`;
/** A jsonb number as double precision; 0 when absent, a JSON null or not a number. */
const numOr0 = (path: SQL): SQL =>
  sql`(case when jsonb_typeof(${path}) = 'number' then (${path} #>> '{}')::double precision else 0 end)`;
/** Same, but SQL NULL when unknown: a weight is unknown, never 0. */
const numOrNull = (path: SQL): SQL =>
  sql`(case when jsonb_typeof(${path}) = 'number' then (${path} #>> '{}')::double precision end)`;

const recorded = sql`coalesce(jsonb_typeof(${reads}) = 'object', false)`;
const observable = sql`(${recorded} and ${reads} ->> 'coverage' in ('full', 'partial'))`;
const partial = sql`(${recorded} and ${reads} ->> 'coverage' = 'partial')`;
const weighted = sql`(${observable} and jsonb_typeof(${reads} -> 'fileReads' -> 'weightedChars') = 'number')`;

const tokens = (key: string): SQL => numOr0(sql`(${inv.tokenUsage} -> ${key}::text)`);
const shareRuns = sql`(${weighted} and ${reads} ->> 'resultSeen' = 'true'
  and jsonb_typeof(${inv.tokenUsage} -> 'inputTokens') = 'number'
  and ${tokens('inputTokens')} + ${tokens('cacheReadTokens')} + ${tokens('cacheCreationTokens')} > 0)`;

const num = (value: unknown): number => Number(value) || 0;

type Row = Record<string, unknown>;

async function run(db: Database, query: SQL): Promise<Row[]> {
  return (await db.execute(query)) as unknown as Row[];
}

export async function rollupFilesRead(
  db: Database,
  opts: FilesReadRollupOptions,
): Promise<FilesReadRollup> {
  // `offset 0` keeps the planner from inlining `rr`, which would repeat the extraction per use.
  const from = sql`from ${inv}
    inner join ${schema.tasks} on ${schema.tasks.id} = ${inv.taskId}
    cross join lateral (select ${inv.toolUsage} -> 'reads' as r offset 0) rr`;

  /** Sum of `part` over the runs of `population`. */
  const sumOver = (population: SQL, part: SQL): SQL =>
    sql`coalesce(sum(${part}) filter (where ${population}), 0)::double precision`;
  const fileReadsPart = (bucket: string, key: string): SQL =>
    numOr0(sql`(${reads} -> ${bucket}::text -> ${key}::text)`);

  // Per (path, task) first, then per path: `tasks` is the number of those groups. A path that is
  // not a string is dropped (`e.p` null); a weight that is not a number stays null, never 0.
  const pathsQuery = sql`
    select p, reads, chars, weighted_chars, weighted_runs, runs, tasks, count(*) over () as total
    from (
      select p, sum(reads)::double precision as reads, sum(chars)::double precision as chars,
        sum(weighted_chars)::double precision as weighted_chars,
        sum(weighted_runs)::int as weighted_runs, sum(runs)::int as runs, count(*)::int as tasks
      from (
        select e.p, ${inv.taskId} as task_id, sum(e.reads) as reads, sum(e.chars) as chars,
          sum(e.weighted) as weighted_chars, count(e.weighted) as weighted_runs, count(*) as runs
        ${from}
        cross join lateral jsonb_array_elements(${arr(sql`(${reads} -> 'files')`)}) as f(file)
        cross join lateral (select
            case when jsonb_typeof(f.file -> 'path') = 'string'
              then (f.file ->> 'path') collate "C" end as p,
            ${numOr0(sql`(f.file -> 'reads')`)} as reads,
            ${numOr0(sql`(f.file -> 'chars')`)} as chars,
            ${numOrNull(sql`(f.file -> 'weightedChars')`)} as weighted
          offset 0) e
        where ${opts.where} and ${observable} and e.p is not null
        group by 1, 2
      ) t
      group by p
    ) g
    order by weighted_chars desc nulls last, chars desc, p collate "C" asc
    limit ${opts.rowLimit}`;

  const groupsQuery = sql`
    select ${schema.taskSteps.stepId} as step_id, ${schema.cliProviders.name} as provider,
      count(*)::int as runs,
      (count(*) filter (where not ${recorded} and ${inv.endedAt} is null))::int as in_flight,
      (count(*) filter (where ${recorded}))::int as recorded,
      (count(*) filter (where ${observable}))::int as observable,
      (count(*) filter (where ${partial}))::int as partial,
      (count(*) filter (where ${weighted}))::int as weighted,
      ${sumOver(observable, fileReadsPart('fileReads', 'reads'))} as file_reads,
      ${sumOver(observable, fileReadsPart('fileReads', 'chars'))} as file_chars,
      ${sumOver(weighted, fileReadsPart('fileReads', 'weightedChars'))} as weighted_chars,
      ${sumOver(observable, numOr0(sql`(${reads} -> 'overflow' -> 'omitted')`))} as overflow_omitted,
      (count(*) filter (where ${observable}
        and ${numOr0(sql`(${reads} -> 'overflow' -> 'omitted')`)} > 0))::int as overflow_runs,
      ${sumOver(observable, fileReadsPart('overflow', 'reads'))} as overflow_reads,
      ${sumOver(observable, fileReadsPart('overflow', 'chars'))} as overflow_chars,
      ${sumOver(weighted, fileReadsPart('overflow', 'weightedChars'))} as overflow_weighted_chars,
      (count(*) filter (where ${observable}
        and ${fileReadsPart('multiFile', 'reads')} > 0))::int as multi_file_runs,
      ${sumOver(observable, fileReadsPart('multiFile', 'reads'))} as multi_file_reads,
      ${sumOver(observable, fileReadsPart('multiFile', 'chars'))} as multi_file_chars,
      ${sumOver(weighted, fileReadsPart('multiFile', 'weightedChars'))} as multi_file_weighted_chars,
      (count(*) filter (where ${shareRuns}))::int as share_runs,
      ${sumOver(shareRuns, fileReadsPart('fileReads', 'weightedChars'))} as share_weighted_chars,
      ${sumOver(shareRuns, tokens('inputTokens'))} as share_input_tokens,
      ${sumOver(shareRuns, tokens('outputTokens'))} as share_output_tokens,
      ${sumOver(shareRuns, tokens('cacheReadTokens'))} as share_cache_read_tokens,
      ${sumOver(shareRuns, tokens('cacheCreationTokens'))} as share_cache_creation_tokens
    ${from}
    inner join ${schema.taskSteps}
      on ${schema.taskSteps.id} = coalesce(${inv.taskStepId}, ${inv.summaryForStepId})
    left join ${schema.cliProviders} on ${schema.cliProviders.id} = ${inv.cliProviderId}
    where ${opts.where}
    group by ${schema.taskSteps.stepId}, ${schema.cliProviders.name}`;

  // Two statements on two connections, so two READ COMMITTED snapshots a few milliseconds apart: a
  // run whose record is written between them enters one side only. The skew is at most that run;
  // `buildFilesRead` floors every remainder at zero rather than show a negative bucket. One
  // REPEATABLE READ transaction would close it, but then the page waits for the sum of the two scans.
  const [pathRows, groupRows] = await Promise.all([run(db, pathsQuery), run(db, groupsQuery)]);

  const paths: FilesReadPathRow[] = pathRows.map((r) => ({
    path: r.p as string,
    reads: num(r.reads),
    chars: num(r.chars),
    weightedChars: r.weighted_chars === null ? null : num(r.weighted_chars),
    weightedRuns: num(r.weighted_runs),
    runs: num(r.runs),
    tasks: num(r.tasks),
  }));

  const groups: FilesReadGroupRow[] = groupRows.map((r) => ({
    stepId: r.step_id as string,
    provider: typeof r.provider === 'string' ? r.provider : null,
    runs: num(r.runs),
    inFlight: num(r.in_flight),
    recorded: num(r.recorded),
    observable: num(r.observable),
    partial: num(r.partial),
    weighted: num(r.weighted),
    fileReads: num(r.file_reads),
    fileChars: num(r.file_chars),
    weightedChars: num(r.weighted_chars),
    overflowOmitted: num(r.overflow_omitted),
    overflowRuns: num(r.overflow_runs),
    overflowReads: num(r.overflow_reads),
    overflowChars: num(r.overflow_chars),
    overflowWeightedChars: num(r.overflow_weighted_chars),
    multiFileRuns: num(r.multi_file_runs),
    multiFileReads: num(r.multi_file_reads),
    multiFileChars: num(r.multi_file_chars),
    multiFileWeightedChars: num(r.multi_file_weighted_chars),
    shareRuns: num(r.share_runs),
    shareWeightedChars: num(r.share_weighted_chars),
    shareInputTokens: num(r.share_input_tokens),
    shareOutputTokens: num(r.share_output_tokens),
    shareCacheReadTokens: num(r.share_cache_read_tokens),
    shareCacheCreationTokens: num(r.share_cache_creation_tokens),
  }));

  return {
    paths: { rows: paths, count: pathRows.length > 0 ? num(pathRows[0]!.total) : 0 },
    groups,
  };
}
