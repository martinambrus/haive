import { sql, type SQL } from 'drizzle-orm';
import { schema } from '@haive/database';
import type { Database } from '../db.js';

/**
 * The one SQL rollup over `cli_invocations.tool_usage`, shared by `GET /stats/tool-usage`
 * (a window) and `GET /tasks/:id/tool-usage` (one task, per step).
 *
 * Like `spendOver` and `sumProviderBreakdownWhere`, the CALLER composes the predicate — scope,
 * attribution, window — and this never decides which rows count. Every query joins `tasks`, so
 * a caller can scope by `tasks.user_id`, and `cli_providers`, for the per-provider coverage.
 *
 * The record is jsonb with a fixed shape (see `InvocationToolUsage`), read here with LATERAL
 * `jsonb_array_elements` / `jsonb_each_text`. Both THROW on a JSON null rather than skipping it,
 * and `loaded` IS a JSON null for codex, amp and gemini rows, so every path is guarded inside
 * the function argument with `arr()` / `obj()` — correct wherever the planner applies the outer
 * qual, which a WHERE on the same column would not be.
 *
 * Grouped by `coalesce(task_step_id, summary_for_step_id)` when `perStep`, the same fold
 * `/stats/steps` and `enrichStepsWithCliStats` use, so a task panel reconciles with the badges
 * beside it. No index on `tool_usage`: each query is a filtered scan narrowed by
 * `cli_invocations_started_at_idx`. If that ever matters the fix is a partial expression index on
 * `(tool_usage ->> 'coverage')`, not a denormalised column.
 */

export interface ToolUsageCoverageRow {
  stepKey: string | null;
  provider: string | null;
  total: number;
  recorded: number;
  observable: number;
  partial: number;
  unobservable: number;
  withLoaded: number;
}

export interface ToolUsageIdRow {
  stepKey: string | null;
  id: string;
  /** Reads, calls or runs — whichever the list counts. */
  n: number;
  runs: number;
  tasks: number;
}

export interface ToolUsageMcpRow {
  stepKey: string | null;
  server: string;
  tool: string;
  calls: number;
  runs: number;
  tasks: number;
}

export interface ToolUsageServerRow {
  stepKey: string | null;
  server: string;
  calls: number;
  runs: number;
  tasks: number;
}

export interface ToolUsageNamedRow {
  stepKey: string | null;
  name: string;
  runs: number;
}

export interface ToolUsageRollup {
  coverage: ToolUsageCoverageRow[];
  /** `n` = runs the persona was assigned in. Counted on any RECORDED row: an assignment is a
   *  dispatch fact, valid on a `coverage: 'none'` row. */
  personasAssigned: ToolUsageIdRow[];
  /** `n` = reads. Observable rows only, like every list below. */
  personasRead: ToolUsageIdRow[];
  skillsInvoked: ToolUsageIdRow[];
  skillsRead: ToolUsageIdRow[];
  mcpTools: ToolUsageMcpRow[];
  mcpServers: ToolUsageServerRow[];
  /** Servers named in a run's `loaded.mcpServers`; `runs` counts rows that carried an inventory. */
  mcpOffered: ToolUsageNamedRow[];
  subagents: ToolUsageIdRow[];
  nativeTools: ToolUsageIdRow[];
}

export interface ToolUsageRollupOptions {
  where: SQL;
  perStep: boolean;
}

const inv = schema.cliInvocations;
const tu = inv.toolUsage;

/** The two observability predicates every reader shares. `recorded` is the column being
 *  non-null; `observable` is the coverage a count may be read from. */
export const toolUsageRecorded = (): SQL => sql`${tu} is not null`;
export const toolUsageObservable = (): SQL => sql`${tu} ->> 'coverage' in ('full', 'partial')`;

const arr = (path: SQL): SQL =>
  sql`(case when jsonb_typeof(${path}) = 'array' then ${path} else '[]'::jsonb end)`;
const obj = (path: SQL): SQL =>
  sql`(case when jsonb_typeof(${path}) = 'object' then ${path} else '{}'::jsonb end)`;

const num = (value: unknown): number => Number(value) || 0;
const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);

type Row = Record<string, unknown>;

async function run(db: Database, query: SQL): Promise<Row[]> {
  return (await db.execute(query)) as unknown as Row[];
}

export async function rollupToolUsage(
  db: Database,
  opts: ToolUsageRollupOptions,
): Promise<ToolUsageRollup> {
  const stepKey = opts.perStep
    ? sql`coalesce(${inv.taskStepId}, ${inv.summaryForStepId})`
    : sql`null::uuid`;
  const from = sql`from ${inv}
    inner join ${schema.tasks} on ${schema.tasks.id} = ${inv.taskId}
    left join ${schema.cliProviders} on ${schema.cliProviders.id} = ${inv.cliProviderId}`;

  /** One id-keyed list: the LATERAL over `path`, an id expression, a count expression, and the
   *  observability predicate the rows must satisfy. Grouped positionally on step key and id. */
  const idList = (lateral: SQL, id: SQL, n: SQL, predicate: SQL): SQL => sql`
    select ${stepKey} as step_key, ${id} as id, (${n})::int as n,
      count(distinct ${inv.id})::int as runs, count(distinct ${inv.taskId})::int as tasks
    ${from} cross join lateral ${lateral}
    where ${opts.where} and ${predicate}
    group by 1, 2`;

  const [
    coverage,
    personasAssigned,
    personasRead,
    skillsInvoked,
    skillsRead,
    mcpTools,
    mcpServers,
    mcpOffered,
    subagents,
    nativeTools,
  ] = await Promise.all([
    run(
      db,
      sql`
      select ${stepKey} as step_key, ${schema.cliProviders.name} as provider,
        count(*)::int as total,
        count(*) filter (where ${toolUsageRecorded()})::int as recorded,
        count(*) filter (where ${toolUsageObservable()})::int as observable,
        count(*) filter (where ${tu} ->> 'coverage' = 'partial')::int as partial,
        count(*) filter (where ${tu} ->> 'coverage' = 'none')::int as unobservable,
        count(*) filter (where jsonb_typeof(${tu} -> 'loaded') = 'object')::int as with_loaded
      ${from} where ${opts.where} group by 1, 2`,
    ),
    run(
      db,
      idList(
        sql`jsonb_array_elements_text(${arr(sql`${tu} -> 'agents' -> 'assigned'`)}) as r(id)`,
        sql`r.id`,
        sql`count(distinct ${inv.id})`,
        toolUsageRecorded(),
      ),
    ),
    run(
      db,
      idList(
        sql`jsonb_array_elements(${arr(sql`${tu} -> 'agents' -> 'read'`)}) as r(value)`,
        sql`r.value ->> 'id'`,
        sql`sum((r.value ->> 'reads')::numeric)`,
        toolUsageObservable(),
      ),
    ),
    run(
      db,
      idList(
        sql`jsonb_array_elements(${arr(sql`${tu} -> 'skills' -> 'invoked'`)}) as r(value)`,
        sql`coalesce(r.value ->> 'id', '(unnamed)')`,
        sql`sum((r.value ->> 'calls')::numeric)`,
        toolUsageObservable(),
      ),
    ),
    run(
      db,
      idList(
        sql`jsonb_array_elements(${arr(sql`${tu} -> 'skills' -> 'read'`)}) as r(value)`,
        sql`r.value ->> 'id'`,
        sql`sum((r.value ->> 'reads')::numeric)`,
        toolUsageObservable(),
      ),
    ),
    run(
      db,
      sql`
      select ${stepKey} as step_key, r.value ->> 'server' as server, r.value ->> 'tool' as tool,
        sum((r.value ->> 'calls')::numeric)::int as calls,
        count(distinct ${inv.id})::int as runs, count(distinct ${inv.taskId})::int as tasks
      ${from} cross join lateral jsonb_array_elements(${arr(sql`${tu} -> 'mcp'`)}) as r(value)
      where ${opts.where} and ${toolUsageObservable()}
      group by 1, 2, 3`,
    ),
    run(
      db,
      sql`
      select ${stepKey} as step_key, r.value ->> 'server' as server,
        sum((r.value ->> 'calls')::numeric)::int as calls,
        count(distinct ${inv.id})::int as runs, count(distinct ${inv.taskId})::int as tasks
      ${from} cross join lateral jsonb_array_elements(${arr(sql`${tu} -> 'mcp'`)}) as r(value)
      where ${opts.where} and ${toolUsageObservable()}
      group by 1, 2`,
    ),
    run(
      db,
      sql`
      select ${stepKey} as step_key, r.name as name, count(distinct ${inv.id})::int as runs
      ${from} cross join lateral jsonb_array_elements_text(${arr(sql`${tu} -> 'loaded' -> 'mcpServers'`)}) as r(name)
      where ${opts.where} and ${toolUsageRecorded()}
      group by 1, 2`,
    ),
    run(
      db,
      idList(
        sql`jsonb_array_elements(${arr(sql`${tu} -> 'subagents'`)}) as r(value)`,
        sql`coalesce(r.value ->> 'type', '(unnamed)')`,
        sql`sum((r.value ->> 'calls')::numeric)`,
        toolUsageObservable(),
      ),
    ),
    run(
      db,
      idList(
        sql`jsonb_each_text(${obj(sql`${tu} -> 'tools'`)}) as r(key, value)`,
        sql`r.key`,
        sql`sum(r.value::numeric)`,
        toolUsageObservable(),
      ),
    ),
  ]);

  const idRows = (rows: Row[]): ToolUsageIdRow[] =>
    rows
      .filter((r) => typeof r.id === 'string')
      .map((r) => ({
        stepKey: text(r.step_key),
        id: r.id as string,
        n: num(r.n),
        runs: num(r.runs),
        tasks: num(r.tasks),
      }));

  return {
    coverage: coverage.map((r) => ({
      stepKey: text(r.step_key),
      provider: text(r.provider),
      total: num(r.total),
      recorded: num(r.recorded),
      observable: num(r.observable),
      partial: num(r.partial),
      unobservable: num(r.unobservable),
      withLoaded: num(r.with_loaded),
    })),
    personasAssigned: idRows(personasAssigned),
    personasRead: idRows(personasRead),
    skillsInvoked: idRows(skillsInvoked),
    skillsRead: idRows(skillsRead),
    mcpTools: mcpTools
      .filter((r) => typeof r.server === 'string' && typeof r.tool === 'string')
      .map((r) => ({
        stepKey: text(r.step_key),
        server: r.server as string,
        tool: r.tool as string,
        calls: num(r.calls),
        runs: num(r.runs),
        tasks: num(r.tasks),
      })),
    mcpServers: mcpServers
      .filter((r) => typeof r.server === 'string')
      .map((r) => ({
        stepKey: text(r.step_key),
        server: r.server as string,
        calls: num(r.calls),
        runs: num(r.runs),
        tasks: num(r.tasks),
      })),
    mcpOffered: mcpOffered
      .filter((r) => typeof r.name === 'string')
      .map((r) => ({ stepKey: text(r.step_key), name: r.name as string, runs: num(r.runs) })),
    subagents: idRows(subagents),
    nativeTools: idRows(nativeTools),
  };
}

/* ------------------------------------------------------------------ */
/* The unused report's three questions                                  */
/* ------------------------------------------------------------------ */

const iso = (value: unknown): string | null => {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string' && value.length > 0) return new Date(value).toISOString();
  return null;
};

const from = sql`from ${inv} inner join ${schema.tasks} on ${schema.tasks.id} = ${inv.taskId}`;

export type ToolUsageSeenKind = 'agent' | 'skill' | 'mcp';

export interface ToolUsageLastSeenRow {
  kind: ToolUsageSeenKind;
  id: string;
  /** ISO time of the newest run under `where` that used it. */
  lastSeenAt: string;
}

/** When each persona (assigned ∪ opened), skill (invoked ∪ opened) and MCP server (called) was
 *  LAST used under `where`. The unused report passes the caller's whole history — scope and
 *  attribution, no window — because "not seen in this window" and "never seen since install"
 *  are different claims and only the second supports deleting a file. */
export async function toolUsageLastSeen(db: Database, where: SQL): Promise<ToolUsageLastSeenRow[]> {
  const part = (kind: ToolUsageSeenKind, lateral: SQL, id: SQL, predicate: SQL): SQL => sql`
    select ${sql.raw(`'${kind}'`)} as kind, ${id} as id, ${inv.startedAt} as started_at
    ${from} cross join lateral ${lateral} where ${where} and ${predicate}`;
  const rows = await run(
    db,
    sql`
    select u.kind as kind, u.id as id, max(u.started_at) as last_seen from (
      ${part(
        'agent',
        sql`jsonb_array_elements_text(${arr(sql`${tu} -> 'agents' -> 'assigned'`)}) as r(id)`,
        sql`r.id`,
        toolUsageRecorded(),
      )}
      union all
      ${part(
        'agent',
        sql`jsonb_array_elements(${arr(sql`${tu} -> 'agents' -> 'read'`)}) as r(value)`,
        sql`r.value ->> 'id'`,
        toolUsageObservable(),
      )}
      union all
      ${part(
        'skill',
        sql`jsonb_array_elements(${arr(sql`${tu} -> 'skills' -> 'invoked'`)}) as r(value)`,
        sql`r.value ->> 'id'`,
        toolUsageObservable(),
      )}
      union all
      ${part(
        'skill',
        sql`jsonb_array_elements(${arr(sql`${tu} -> 'skills' -> 'read'`)}) as r(value)`,
        sql`r.value ->> 'id'`,
        toolUsageObservable(),
      )}
      union all
      ${part(
        'mcp',
        sql`jsonb_array_elements(${arr(sql`${tu} -> 'mcp'`)}) as r(value)`,
        sql`r.value ->> 'server'`,
        toolUsageObservable(),
      )}
    ) u where u.id is not null group by 1, 2`,
  );
  const out: ToolUsageLastSeenRow[] = [];
  for (const r of rows) {
    const lastSeenAt = iso(r.last_seen);
    if (typeof r.id !== 'string' || lastSeenAt === null) continue;
    if (r.kind !== 'agent' && r.kind !== 'skill' && r.kind !== 'mcp') continue;
    out.push({ kind: r.kind, id: r.id, lastSeenAt });
  }
  return out;
}

export interface ToolUsageLoadedRow {
  kind: 'agent' | 'skill';
  id: string;
  runs: number;
}

/** Ids the CLIs reported as LOADED (`loaded.agents`, `loaded.skills`) on recorded rows under
 *  `where`: the inventory a run saw, against which "installed but not on disk" is judged. MCP
 *  servers have their own list in the main rollup (`mcpOffered`). */
export async function toolUsageLoadedIds(db: Database, where: SQL): Promise<ToolUsageLoadedRow[]> {
  const part = (kind: 'agent' | 'skill', field: string): SQL => sql`
    select ${sql.raw(`'${kind}'`)} as kind, r.id as id, ${inv.id} as inv_id
    ${from} cross join lateral jsonb_array_elements_text(${arr(sql`${tu} -> 'loaded' -> ${sql.raw(`'${field}'`)}`)}) as r(id)
    where ${where} and ${toolUsageRecorded()}`;
  const rows = await run(
    db,
    sql`
    select u.kind as kind, u.id as id, count(distinct u.inv_id)::int as runs from (
      ${part('agent', 'agents')}
      union all
      ${part('skill', 'skills')}
    ) u group by 1, 2`,
  );
  return rows
    .filter((r) => typeof r.id === 'string' && (r.kind === 'agent' || r.kind === 'skill'))
    .map((r) => ({ kind: r.kind as 'agent' | 'skill', id: r.id as string, runs: num(r.runs) }));
}

export interface ToolUsageObservableSpan {
  runs: number;
  /** ISO time of the earliest observable run under `where`; null when there is none. */
  since: string | null;
}

/** How many observable runs `where` covers and from when — the denominators an unused row is
 *  read against. */
export async function toolUsageObservableSpan(
  db: Database,
  where: SQL,
): Promise<ToolUsageObservableSpan> {
  const [row] = await run(
    db,
    sql`
    select count(*) filter (where ${toolUsageObservable()})::int as runs,
      min(${inv.startedAt}) filter (where ${toolUsageObservable()}) as since
    ${from} where ${where}`,
  );
  return { runs: num(row?.runs), since: iso(row?.since) };
}
