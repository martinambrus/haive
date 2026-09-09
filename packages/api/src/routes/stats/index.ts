import { Hono } from 'hono';
import { and, eq, gte, inArray, isNotNull, isNull, lt, notInArray, or, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { schema } from '@haive/database';
import { CONFIG_KEYS, configService, isDisplayCurrency } from '@haive/shared';
import { computeTaskTiming } from '@haive/shared/timing';
import { buildEstimationAccuracy } from '@haive/shared';
import {
  buildTaskTimeBreakdown,
  computeBusySpan,
  computeDelta,
  dayKey,
  dayKeysBetween,
  hasEnoughSamples,
  knownTaskTypes,
  previousWindow,
  resolveTaskClass,
  sampledRatio,
  normalizeTokens,
  sumNormalizedTokens,
  TASK_CLASSES,
  typesForClass,
  type Delta,
  type TaskClass,
} from '@haive/shared/stats';
import { getDb } from '../../db.js';
import { requireAuth } from '../../middleware/auth.js';
import { HttpError, type AppEnv } from '../../context.js';
import {
  realCostRowSql,
  realCostUsdSql,
  notionalCostRowSql,
  notionalCostUsdSql,
  resolveCostDisplay,
  sumProviderBreakdownWhere,
  type CostDisplay,
  type TaskProviderUsage,
} from '../tasks/_helpers.js';
import { parseStatsQuery, type StatsQuery } from './_query.js';

export const statsRoutes = new Hono<AppEnv>();

statsRoutes.use('*', requireAuth);

/** Task statuses that mean "this task produced nothing".
 *
 *  Surfaced as its own figure because it is otherwise invisible and it is large: MEASURED on
 *  the dev install, 14 of 25 tasks (56%) ended this way, consuming 13% of notional spend and
 *  29% of all agent-hours. */
const ABANDONED_STATUSES = ['failed', 'cancelled'] as const;

/** The reconciliation filter every invocation rollup in this codebase carries. Without it a
 *  window's totals stop matching the per-task figures the task pages already show:
 *  superseded rows are re-rolled work, and a row attributed to no step at all predates the
 *  summary-attribution column and must stay out of both sides. */
function invocationAttributionFilter(): SQL {
  return and(
    isNull(schema.cliInvocations.supersededAt),
    or(
      isNotNull(schema.cliInvocations.taskStepId),
      isNotNull(schema.cliInvocations.summaryForStepId),
    ),
  )!;
}

/** Scope predicate shared by every query: ownership plus the facets.
 *
 *  `cli_invocations`, `task_steps` and `review_findings` carry no `user_id`, so ownership is
 *  always reached through `tasks` — the caller is responsible for having joined it. */
function taskScopeFilter(q: StatsQuery, userId: string): SQL[] {
  const terms: SQL[] = [];
  if (!q.allUsers) terms.push(eq(schema.tasks.userId, userId));
  if (q.repositoryId) terms.push(eq(schema.tasks.repositoryId, q.repositoryId));
  if (q.taskClass) {
    const types = typesForClass(q.taskClass);
    // `other` is defined negatively — whatever the type table does not name — so it cannot be
    // expressed as an IN list. See typesForClass.
    terms.push(
      types
        ? inArray(schema.tasks.type, types as never[])
        : notInArray(schema.tasks.type, knownTaskTypes() as never[]),
    );
  }
  return terms;
}

interface TaskClassCount {
  taskClass: TaskClass;
  started: number;
  completed: number;
  abandoned: number;
}

interface SpendTotals {
  realUsd: number;
  notionalUsd: number;
  unpricedInvocations: number;
  invocations: number;
}

/** Real + notional spend over an arbitrary invocation predicate.
 *
 *  Both halves are reported. On a subscription plan the real number is 0.00 and the whole
 *  value of the product is in the counterfactual — MEASURED on the dev install, $0.00 real
 *  against $717.16 notional across five days — so showing only "spend" would report this
 *  install as costing nothing and saving nothing. */
async function spendOver(
  db: ReturnType<typeof getDb>,
  where: SQL | undefined,
): Promise<SpendTotals> {
  const [row] = await db
    .select({
      realUsd: realCostUsdSql(),
      notionalUsd: notionalCostUsdSql(),
      invocations: sql<number>`count(*)::int`,
      unpricedInvocations: sql<number>`count(*) filter (where ${schema.cliInvocations.cost} ->> 'source' = 'none')::int`,
    })
    .from(schema.cliInvocations)
    .innerJoin(schema.tasks, eq(schema.tasks.id, schema.cliInvocations.taskId))
    .leftJoin(schema.cliProviders, eq(schema.cliProviders.id, schema.cliInvocations.cliProviderId))
    .where(where);
  return {
    realUsd: Number(row?.realUsd) || 0,
    notionalUsd: Number(row?.notionalUsd) || 0,
    invocations: Number(row?.invocations) || 0,
    unpricedInvocations: Number(row?.unpricedInvocations) || 0,
  };
}

/** Agent-hours and the busy-span union over an arbitrary invocation predicate.
 *
 *  Fetches one narrow row per invocation because the union cannot be computed from an
 *  aggregate — see the module comment on computeBusySpan for why this is JS and not SQL. */
async function timeOver(
  db: ReturnType<typeof getDb>,
  where: SQL | undefined,
  timeZone: string,
): Promise<ReturnType<typeof computeBusySpan>> {
  const rows = await db
    .select({
      start: schema.cliInvocations.startedAt,
      end: schema.cliInvocations.endedAt,
    })
    .from(schema.cliInvocations)
    .innerJoin(schema.tasks, eq(schema.tasks.id, schema.cliInvocations.taskId))
    .where(
      and(
        where,
        isNotNull(schema.cliInvocations.startedAt),
        isNotNull(schema.cliInvocations.endedAt),
      ),
    );
  return computeBusySpan(rows, { timeZone });
}

/** Effort (agent work + the user's own focused time) for the tasks that COMPLETED in a window.
 *
 *  Effort has no timestamps — `idle_ms` and `user_active_ms` are client-posted durations with
 *  no location in time — so it can only be attributed to a task and then bucketed by that
 *  task's completion. It can never be unioned or charted "per day of expenditure". */
async function effortOver(
  db: ReturnType<typeof getDb>,
  taskRows: Array<{ id: string; completedAt: Date | null }>,
): Promise<{ workMs: number; idleMs: number; userActiveMs: number; effortMs: number }> {
  if (taskRows.length === 0) return { workMs: 0, idleMs: 0, userActiveMs: 0, effortMs: 0 };
  const stepRows = await db
    .select({
      taskId: schema.taskSteps.taskId,
      startedAt: schema.taskSteps.startedAt,
      endedAt: schema.taskSteps.endedAt,
      idleMs: schema.taskSteps.idleMs,
      userActiveMs: schema.taskSteps.userActiveMs,
      waitingStartedAt: schema.taskSteps.waitingStartedAt,
      status: schema.taskSteps.status,
      carriedWorkMs: schema.taskSteps.carriedWorkMs,
      carriedIdleMs: schema.taskSteps.carriedIdleMs,
      carriedUserActiveMs: schema.taskSteps.carriedUserActiveMs,
    })
    .from(schema.taskSteps)
    .where(
      inArray(
        schema.taskSteps.taskId,
        taskRows.map((t) => t.id),
      ),
    );

  const byTask = new Map<string, (typeof stepRows)[number][]>();
  for (const s of stepRows) {
    const list = byTask.get(s.taskId);
    if (list) list.push(s);
    else byTask.set(s.taskId, [s]);
  }

  const now = Date.now();
  let workMs = 0;
  let idleMs = 0;
  let userActiveMs = 0;
  for (const t of taskRows) {
    // Capped at the task's own completion instant, never the live clock: a step whose
    // ended_at was never stamped otherwise bills start -> now as work and grows on every
    // request. One such row read 670 h against a 1.78 h wall before this cap existed.
    const endMs = t.completedAt ? t.completedAt.getTime() : now;
    const timing = computeTaskTiming(byTask.get(t.id) ?? [], endMs);
    workMs += timing.workMs;
    idleMs += timing.idleMs;
    userActiveMs += timing.userActiveMs;
  }
  return { workMs, idleMs, userActiveMs, effortMs: workMs + userActiveMs };
}

/** Per-provider token totals, normalised for the cache-inclusive reporters before summing.
 *
 *  The order matters: codex and gemini report `input` INCLUSIVE of the cached prefix, so
 *  adding raw fields across providers and normalising once at the end mixes two different
 *  definitions of the same column. See `sumNormalizedTokens`. */
function toRawTotals(
  p: Pick<
    TaskProviderUsage,
    'provider' | 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheCreationTokens'
  >,
) {
  return {
    provider: p.provider,
    inputTokens: p.inputTokens,
    outputTokens: p.outputTokens,
    cacheReadTokens: p.cacheReadTokens,
    cacheCreationTokens: p.cacheCreationTokens,
  };
}

function normalizeBreakdown(breakdown: TaskProviderUsage[]) {
  return sumNormalizedTokens(breakdown.map(toRawTotals));
}

/** The same normalisation, kept per provider.
 *
 *  Attached to the response rather than folded into `TaskProviderUsage` itself: that interface
 *  is mirrored by the task detail page, and this is a statistics concern. Sharing `toRawTotals`
 *  with the total above is what makes Σ these rows equal `tokens` STRUCTURALLY rather than by
 *  two call sites happening to agree — the parts and the whole cannot drift.
 *
 *  Per provider is where the normalisation actually shows: MEASURED, the naive ratio reports
 *  codex at 45.8% cached where it is really 84.6%, because codex counts the cached prefix
 *  inside `input` and the rest of the providers do not. */
function providerTokens(breakdown: TaskProviderUsage[]) {
  return breakdown.map((p) => ({ ...p, tokens: normalizeTokens(toRawTotals(p)) }));
}

/**
 * Range summary: what this window cost, saved, ran and produced.
 *
 * THREE CLOCKS, each labelled, because one window cannot mean the same thing for all of them:
 *  - spend / tokens / agent-hours / busy span are scoped by `cli_invocations.started_at` —
 *    money is spent when the agent ran, whatever the task's own dates are;
 *  - `tasks.started` is scoped by `tasks.created_at` — what you set off in this window;
 *  - `tasks.completed` and all effort are scoped by `tasks.completed_at` — what finished.
 * A task started before the window and finished inside it therefore counts in `completed` but
 * not in `started`, which is the honest reading of both questions rather than a compromise
 * that answers neither.
 */
statsRoutes.get('/summary', async (c) => {
  const userId = c.get('userId');
  const q = parseStatsQuery(c.req.query());
  if (q.allUsers && c.get('userRole') !== 'admin') {
    throw new HttpError(403, 'Admin access required for install-wide statistics');
  }
  const db = getDb();

  const from = new Date(q.fromMs);
  const to = new Date(q.toMs);
  const prev = previousWindow({ fromMs: q.fromMs, toMs: q.toMs });
  const prevFrom = new Date(prev.fromMs);
  const prevTo = new Date(prev.toMs);

  const scope = taskScopeFilter(q, userId);
  const providerTerm = q.cliProviderId
    ? [eq(schema.cliInvocations.cliProviderId, q.cliProviderId)]
    : [];

  // Half-open [from, to): a row exactly on the boundary belongs to one window only, so the
  // current and previous windows can never double-count it.
  const invocationWindow = (lo: Date, hi: Date): SQL =>
    and(
      ...scope,
      ...providerTerm,
      invocationAttributionFilter(),
      gte(schema.cliInvocations.startedAt, lo),
      lt(schema.cliInvocations.startedAt, hi),
    )!;

  const [spend, prevSpend, breakdown, busy, prevBusy] = await Promise.all([
    spendOver(db, invocationWindow(from, to)),
    spendOver(db, invocationWindow(prevFrom, prevTo)),
    sumProviderBreakdownWhere(db, invocationWindow(from, to)),
    timeOver(db, invocationWindow(from, to), q.timeZone),
    timeOver(db, invocationWindow(prevFrom, prevTo), q.timeZone),
  ]);

  // What the abandoned half of the window consumed. Same window, restricted to tasks that
  // ended with nothing to show for it.
  const abandonedSpend = await spendOver(
    db,
    and(invocationWindow(from, to), inArray(schema.tasks.status, [...ABANDONED_STATUSES]))!,
  );
  const abandonedTime = await timeOver(
    db,
    and(invocationWindow(from, to), inArray(schema.tasks.status, [...ABANDONED_STATUSES]))!,
    q.timeZone,
  );

  // Tasks STARTED in the window, by class and outcome.
  const startedRows = await db
    .select({
      type: schema.tasks.type,
      status: schema.tasks.status,
      metadata: schema.tasks.metadata,
      executionPath: schema.tasks.executionPath,
      n: sql<number>`count(*)::int`,
    })
    .from(schema.tasks)
    .where(and(...scope, gte(schema.tasks.createdAt, from), lt(schema.tasks.createdAt, to)))
    .groupBy(
      schema.tasks.type,
      schema.tasks.status,
      schema.tasks.metadata,
      schema.tasks.executionPath,
    );

  const byClass = new Map<TaskClass, TaskClassCount>();
  for (const cls of TASK_CLASSES) {
    byClass.set(cls, { taskClass: cls, started: 0, completed: 0, abandoned: 0 });
  }
  let started = 0;
  let startedAbandoned = 0;
  for (const row of startedRows) {
    const n = Number(row.n) || 0;
    const { taskClass } = resolveTaskClass({
      type: row.type,
      metadata: row.metadata,
      executionPath: row.executionPath,
    });
    const entry = byClass.get(taskClass)!;
    entry.started += n;
    if (row.status === 'completed') entry.completed += n;
    if ((ABANDONED_STATUSES as readonly string[]).includes(row.status)) {
      entry.abandoned += n;
      startedAbandoned += n;
    }
    started += n;
  }

  const [prevStartedRow] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.tasks)
    .where(
      and(...scope, gte(schema.tasks.createdAt, prevFrom), lt(schema.tasks.createdAt, prevTo)),
    );

  // Tasks COMPLETED in the window — the population effort and estimates are measured over.
  const completedRows = await db
    .select({
      id: schema.tasks.id,
      completedAt: schema.tasks.completedAt,
      estimatedTimeHours: schema.tasks.estimatedTimeHours,
      aiEstimatedTimeHours: schema.tasks.aiEstimatedTimeHours,
    })
    .from(schema.tasks)
    .where(
      and(
        ...scope,
        eq(schema.tasks.status, 'completed'),
        isNotNull(schema.tasks.completedAt),
        gte(schema.tasks.completedAt, from),
        lt(schema.tasks.completedAt, to),
      ),
    );

  const prevCompletedRows = await db
    .select({ id: schema.tasks.id, completedAt: schema.tasks.completedAt })
    .from(schema.tasks)
    .where(
      and(
        ...scope,
        eq(schema.tasks.status, 'completed'),
        isNotNull(schema.tasks.completedAt),
        gte(schema.tasks.completedAt, prevFrom),
        lt(schema.tasks.completedAt, prevTo),
      ),
    );

  const [effort, prevEffort] = await Promise.all([
    effortOver(db, completedRows),
    effortOver(db, prevCompletedRows),
  ]);

  const displayCurrencyRaw = await configService.get(CONFIG_KEYS.COST_DISPLAY_CURRENCY);
  // Dated on the window's END rather than today, so re-opening a past range reports the same
  // figure — the same reasoning as dating a task's conversion on the task.
  const costDisplay: CostDisplay = await resolveCostDisplay(
    db,
    isDisplayCurrency(displayCurrencyRaw) ? displayCurrencyRaw : 'USD',
    to,
  );

  const tokens = normalizeBreakdown(breakdown);

  const delta = (cur: number, before: number): Delta => computeDelta(cur, before);

  return c.json({
    range: {
      from: from.toISOString(),
      to: to.toISOString(),
      timeZone: q.timeZone,
      previousFrom: prevFrom.toISOString(),
      previousTo: prevTo.toISOString(),
    },
    scope: {
      allUsers: q.allUsers,
      repositoryId: q.repositoryId,
      cliProviderId: q.cliProviderId,
      taskClass: q.taskClass,
    },
    costDisplay,
    spend: {
      realUsd: spend.realUsd,
      notionalUsd: spend.notionalUsd,
      invocations: spend.invocations,
      unpricedInvocations: spend.unpricedInvocations,
      abandonedRealUsd: abandonedSpend.realUsd,
      abandonedNotionalUsd: abandonedSpend.notionalUsd,
      byProvider: providerTokens(breakdown),
      realDelta: delta(spend.realUsd, prevSpend.realUsd),
      notionalDelta: delta(spend.notionalUsd, prevSpend.notionalUsd),
    },
    tokens,
    time: {
      agentMs: busy.agentMs,
      busyMs: busy.busyMs,
      calendarMs: busy.calendarMs,
      islands: busy.islands,
      concurrency: busy.concurrency,
      dutyCycle: busy.dutyCycle,
      abandonedAgentMs: abandonedTime.agentMs,
      workMs: effort.workMs,
      idleMs: effort.idleMs,
      userActiveMs: effort.userActiveMs,
      effortMs: effort.effortMs,
      agentDelta: delta(busy.agentMs, prevBusy.agentMs),
      effortDelta: delta(effort.effortMs, prevEffort.effortMs),
    },
    tasks: {
      started,
      startedAbandoned,
      completed: completedRows.length,
      // Sample-gated: on a young install this is a ratio over a handful of rows, and a
      // percentage from three tasks reads exactly like one from three hundred.
      abandonedRatio: sampledRatio(startedAbandoned, started),
      byClass: [...byClass.values()],
      startedDelta: delta(started, Number(prevStartedRow?.n) || 0),
      completedDelta: delta(completedRows.length, prevCompletedRows.length),
      withHumanEstimate: completedRows.filter((t) => t.estimatedTimeHours != null).length,
      withAiEstimate: completedRows.filter((t) => t.aiEstimatedTimeHours != null).length,
    },
  });
});

interface DayAccumulator {
  realUsd: number;
  notionalUsd: number;
  invocations: number;
  agentMs: number;
  /** Per provider, because the cache-inclusive reporters must be normalised BEFORE the
   *  providers are added together. */
  tokensByProvider: Map<
    string,
    {
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheCreationTokens: number;
    }
  >;
  tasksStarted: number;
  tasksCompleted: number;
}

function emptyDay(): DayAccumulator {
  return {
    realUsd: 0,
    notionalUsd: 0,
    invocations: 0,
    agentMs: 0,
    tokensByProvider: new Map(),
    tasksStarted: 0,
    tasksCompleted: 0,
  };
}

/**
 * Daily series for the dashboard charts and the stats page's time tab.
 *
 * ONE COST RULE, ONE BUCKETER. The cost decision is selected PER ROW in SQL
 * (`realCostRowSql` / `notionalCostRowSql`) and the day buckets are cut here in JS with
 * `Intl`. The alternative — grouping by `date_trunc` in SQL — would put a second bucketing
 * implementation alongside the one the busy-span union already needs in JS, and two
 * bucketers that must agree eventually will not. The correct SQL form is recorded here for
 * the day that changes:
 *   date_trunc('day', (started_at AT TIME ZONE 'UTC') AT TIME ZONE $tz)
 * A single `AT TIME ZONE $tz` is WRONG — the column is `timestamp without time zone` holding
 * UTC wall clock, so one conversion reads it as already-local and shifts every row by the
 * offset. MEASURED: that moves 5-10% of rows into the wrong day on this install.
 *
 * TWO ATTRIBUTION RULES, deliberately. `busyMs` SPLITS an invocation that crosses local
 * midnight across both days — it measures clock time, and part of it really did happen on
 * each. `agentMs` attributes the whole invocation to the day it STARTED, because it measures
 * work done and splitting it would imply a precision the duration does not have. Both sum to
 * their correct totals; only the within-day split differs, which is why no per-day
 * concurrency ratio is exposed.
 */
statsRoutes.get('/timeline', async (c) => {
  const userId = c.get('userId');
  const q = parseStatsQuery(c.req.query());
  if (q.allUsers && c.get('userRole') !== 'admin') {
    throw new HttpError(403, 'Admin access required for install-wide statistics');
  }
  const db = getDb();

  const from = new Date(q.fromMs);
  const to = new Date(q.toMs);
  const scope = taskScopeFilter(q, userId);
  const providerTerm = q.cliProviderId
    ? [eq(schema.cliInvocations.cliProviderId, q.cliProviderId)]
    : [];

  const tu = schema.cliInvocations.tokenUsage;
  const rows = await db
    .select({
      startedAt: schema.cliInvocations.startedAt,
      endedAt: schema.cliInvocations.endedAt,
      provider: schema.cliProviders.name,
      realUsd: realCostRowSql(),
      notionalUsd: notionalCostRowSql(),
      inputTokens: sql<number>`coalesce((${tu} ->> 'inputTokens')::numeric, 0)::bigint`,
      outputTokens: sql<number>`coalesce((${tu} ->> 'outputTokens')::numeric, 0)::bigint`,
      cacheReadTokens: sql<number>`coalesce((${tu} ->> 'cacheReadTokens')::numeric, 0)::bigint`,
      cacheCreationTokens: sql<number>`coalesce((${tu} ->> 'cacheCreationTokens')::numeric, 0)::bigint`,
    })
    .from(schema.cliInvocations)
    .innerJoin(schema.tasks, eq(schema.tasks.id, schema.cliInvocations.taskId))
    .leftJoin(schema.cliProviders, eq(schema.cliProviders.id, schema.cliInvocations.cliProviderId))
    .where(
      and(
        ...scope,
        ...providerTerm,
        invocationAttributionFilter(),
        isNotNull(schema.cliInvocations.startedAt),
        gte(schema.cliInvocations.startedAt, from),
        lt(schema.cliInvocations.startedAt, to),
      ),
    );

  const days = new Map<string, DayAccumulator>();
  const dayOf = (key: string): DayAccumulator => {
    let d = days.get(key);
    if (!d) {
      d = emptyDay();
      days.set(key, d);
    }
    return d;
  };

  for (const row of rows) {
    if (!row.startedAt) continue;
    const d = dayOf(dayKey(row.startedAt.getTime(), q.timeZone));
    d.realUsd += Number(row.realUsd) || 0;
    d.notionalUsd += Number(row.notionalUsd) || 0;
    d.invocations += 1;
    if (row.endedAt) d.agentMs += Math.max(0, row.endedAt.getTime() - row.startedAt.getTime());
    const provider = row.provider ?? 'unknown';
    const t = d.tokensByProvider.get(provider) ?? {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    };
    t.inputTokens += Number(row.inputTokens) || 0;
    t.outputTokens += Number(row.outputTokens) || 0;
    t.cacheReadTokens += Number(row.cacheReadTokens) || 0;
    t.cacheCreationTokens += Number(row.cacheCreationTokens) || 0;
    d.tokensByProvider.set(provider, t);
  }

  // The union, split across local days by the one bucketer.
  const busy = computeBusySpan(
    rows.map((r) => ({ start: r.startedAt, end: r.endedAt })),
    { timeZone: q.timeZone },
  );
  const busyByDay = new Map(busy.buckets.map((b) => [b.bucket, b.busyMs]));

  const [startedRows, completedRows] = await Promise.all([
    db
      .select({ at: schema.tasks.createdAt })
      .from(schema.tasks)
      .where(and(...scope, gte(schema.tasks.createdAt, from), lt(schema.tasks.createdAt, to))),
    db
      .select({ at: schema.tasks.completedAt })
      .from(schema.tasks)
      .where(
        and(
          ...scope,
          eq(schema.tasks.status, 'completed'),
          isNotNull(schema.tasks.completedAt),
          gte(schema.tasks.completedAt, from),
          lt(schema.tasks.completedAt, to),
        ),
      ),
  ]);
  for (const r of startedRows)
    if (r.at) dayOf(dayKey(r.at.getTime(), q.timeZone)).tasksStarted += 1;
  for (const r of completedRows) {
    if (r.at) dayOf(dayKey(r.at.getTime(), q.timeZone)).tasksCompleted += 1;
  }

  // Every day in the range, so a chart draws an explicit zero for a quiet day instead of
  // joining a line straight across it.
  for (const key of dayKeysBetween(q.fromMs, q.toMs, q.timeZone)) dayOf(key);

  const series = [...days.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([bucket, d]) => {
      const tokens = sumNormalizedTokens(
        [...d.tokensByProvider.entries()].map(([provider, t]) => ({ provider, ...t })),
      );
      return {
        bucket,
        realUsd: d.realUsd,
        notionalUsd: d.notionalUsd,
        invocations: d.invocations,
        agentMs: d.agentMs,
        busyMs: busyByDay.get(bucket) ?? 0,
        tasksStarted: d.tasksStarted,
        tasksCompleted: d.tasksCompleted,
        freshInputTokens: tokens.freshInputTokens,
        outputTokens: tokens.outputTokens,
        cacheReadTokens: tokens.cacheReadTokens,
        cacheCreationTokens: tokens.cacheCreationTokens,
        totalTokens: tokens.totalTokens,
      };
    });

  return c.json({
    range: { from: from.toISOString(), to: to.toISOString(), timeZone: q.timeZone },
    totals: {
      realUsd: series.reduce((n, d) => n + d.realUsd, 0),
      notionalUsd: series.reduce((n, d) => n + d.notionalUsd, 0),
      invocations: rows.length,
      agentMs: busy.agentMs,
      busyMs: busy.busyMs,
      islands: busy.islands,
      concurrency: busy.concurrency,
      dutyCycle: busy.dutyCycle,
    },
    days: series,
  });
});

/**
 * Per-task breakdown of the window's agent time — the rows behind the Time tab's tiles.
 *
 * The interval set is identical to the one `/summary` builds its agent-hours and busy-span tiles
 * from (`invocationWindow` + `timeOver`), so Σ row `agentMs` equals that tile exactly. Busy span
 * deliberately does NOT add up across rows: two tasks running the same minute each own that
 * minute, while the window owns it once. See `buildTaskTimeBreakdown`.
 *
 * Intervals are not clamped at `to` for the same reason the tiles do not clamp them — an
 * invocation counts where it STARTED, whole. Clamping here alone would break the reconciliation
 * that is the point of the table.
 *
 * Its own endpoint rather than extra fields on `/timeline`, which the page fetches eagerly for
 * every tab: rows bolted there would ride along on five tabs that never render them.
 */
statsRoutes.get('/tasks', async (c) => {
  const userId = c.get('userId');
  const q = parseStatsQuery(c.req.query());
  if (q.allUsers && c.get('userRole') !== 'admin') {
    throw new HttpError(403, 'Admin access required for install-wide statistics');
  }
  const db = getDb();

  const from = new Date(q.fromMs);
  const to = new Date(q.toMs);
  const scope = taskScopeFilter(q, userId);
  const providerTerm = q.cliProviderId
    ? [eq(schema.cliInvocations.cliProviderId, q.cliProviderId)]
    : [];

  const intervals = await db
    .select({
      taskId: schema.cliInvocations.taskId,
      start: schema.cliInvocations.startedAt,
      end: schema.cliInvocations.endedAt,
    })
    .from(schema.cliInvocations)
    .innerJoin(schema.tasks, eq(schema.tasks.id, schema.cliInvocations.taskId))
    .where(
      and(
        ...scope,
        ...providerTerm,
        invocationAttributionFilter(),
        isNotNull(schema.cliInvocations.startedAt),
        isNotNull(schema.cliInvocations.endedAt),
        gte(schema.cliInvocations.startedAt, from),
        lt(schema.cliInvocations.startedAt, to),
      ),
    );

  const breakdown = buildTaskTimeBreakdown(intervals, { timeZone: q.timeZone });

  // Metadata for the rows that survived the cap only: a two-year window can rank thousands of
  // tasks and still needs titles for two hundred.
  const ids = breakdown.rows.map((r) => r.taskId);
  const meta = ids.length
    ? await db
        .select({
          id: schema.tasks.id,
          title: schema.tasks.title,
          type: schema.tasks.type,
          status: schema.tasks.status,
          metadata: schema.tasks.metadata,
          executionPath: schema.tasks.executionPath,
          repositoryId: schema.tasks.repositoryId,
          repositoryName: schema.repositories.name,
        })
        .from(schema.tasks)
        .leftJoin(schema.repositories, eq(schema.repositories.id, schema.tasks.repositoryId))
        .where(inArray(schema.tasks.id, ids))
    : [];
  const byId = new Map(meta.map((m) => [m.id, m]));

  return c.json({
    range: { from: from.toISOString(), to: to.toISOString(), timeZone: q.timeZone },
    rows: breakdown.rows.map((r) => {
      // Present unless the task was deleted between the two queries — the innerJoin above
      // proves it existed a moment ago.
      const m = byId.get(r.taskId);
      return {
        ...r,
        title: m?.title ?? null,
        taskClass: m
          ? resolveTaskClass({
              type: m.type,
              metadata: m.metadata,
              executionPath: m.executionPath,
            }).taskClass
          : null,
        status: m?.status ?? null,
        repositoryId: m?.repositoryId ?? null,
        repositoryName: m?.repositoryName ?? null,
      };
    }),
    taskCount: breakdown.taskCount,
    truncated: breakdown.truncated,
  });
});

/** How many step rows a single response ranks. Mirrors TASK_TIME_ROW_LIMIT's reasoning: the cap
 *  is applied AFTER the sort so it drops the smallest consumers, and the caller is told it
 *  happened — a partial sum presented as a total is worse than no table. There are ~60 step ids
 *  in the engine, so this only binds if a future one fans out. */
const STEP_ROW_LIMIT = 60;

/**
 * Per-step-id breakdown of the window's agent time and spend.
 *
 * The fact nobody could read before: which STEP the money and the hours go to. MEASURED on the
 * dev install, four steps hold ~85% of all agent-hours.
 *
 * Attribution is `coalesce(task_step_id, summary_for_step_id)`, the same fold
 * `enrichStepsWithCliStats` applies per task, so a window total equals the sum of the per-step
 * badges the task pages already show. That expression yields the step's UUID, hence the extra
 * join to reach the human `step_id` this groups by.
 *
 * `invocationAttributionFilter` APPLIES here, unlike on /reliability. That endpoint deliberately
 * counts superseded and unattributed rows because those rows ARE the waste it measures; a spend
 * rollup is the opposite case and has to reconcile.
 *
 * `tokens` answers the question `CONFIG_KEYS.PROMPT_CACHING_1H` asks an admin and nothing could
 * previously show them: whether a step REUSES its cached prefix or re-writes it. Read
 * `tokens.cacheWriteShare`, not `cacheHitRatio` — cache creation is absent from the latter's
 * denominator, so MEASURED it calls 00-plan-sequence a 99.99% cache hit while that step writes
 * 84k cache tokens per fan-out agent. A write bills at 1.25x input against a read's 0.1x.
 *
 * agentMs is summed from the timestamps rather than from `duration_ms`, matching how every other
 * agent-hours figure in this file is defined — and MEASURED, 17 rows on this install carry both
 * timestamps and a null `duration_ms`, which the column form would silently drop. It is summed
 * and never unioned: the busy-span union is per task and does not decompose by step (agent-hours
 * is partition-invariant, busy span is not — see task-time.ts).
 *
 * Step FAILURE counts stay out of this response. `task_steps` is windowed on its own created_at
 * because a step has no started_at until it runs, while this rollup is windowed on the invocation
 * clock; one row carrying both would report a "runs" and a "failed" that describe different sets.
 * /reliability already ranks failing steps on the correct clock.
 */
statsRoutes.get('/steps', async (c) => {
  const userId = c.get('userId');
  const q = parseStatsQuery(c.req.query());
  if (q.allUsers && c.get('userRole') !== 'admin') {
    throw new HttpError(403, 'Admin access required for install-wide statistics');
  }
  const db = getDb();

  const from = new Date(q.fromMs);
  const to = new Date(q.toMs);
  const scope = taskScopeFilter(q, userId);
  const providerTerm = q.cliProviderId
    ? [eq(schema.cliInvocations.cliProviderId, q.cliProviderId)]
    : [];
  const window = and(
    ...scope,
    ...providerTerm,
    invocationAttributionFilter(),
    gte(schema.cliInvocations.startedAt, from),
    lt(schema.cliInvocations.startedAt, to),
  );

  // Double precision rather than bigint: a millisecond sum is exact well past any window this
  // API will serve, and it comes back as a number instead of a driver string.
  const agentMsSql = sql<number>`coalesce(sum(
    greatest(0, extract(epoch from (${schema.cliInvocations.endedAt} - ${schema.cliInvocations.startedAt})) * 1000)
  ), 0)::double precision`;

  const servedSql = sql<string | null>`${schema.cliInvocations.modelIdentity} ->> 'served'`;
  const tu = schema.cliInvocations.tokenUsage;

  const [stepRows, modelRows, tokenRows] = await Promise.all([
    db
      .select({
        stepId: schema.taskSteps.stepId,
        invocations: sql<number>`count(*)::int`,
        agentMs: agentMsSql,
        realUsd: realCostUsdSql(),
        notionalUsd: notionalCostUsdSql(),
        unpricedInvocations: sql<number>`count(*) filter (where ${schema.cliInvocations.cost} ->> 'source' = 'none')::int`,
        taskCount: sql<number>`count(distinct ${schema.cliInvocations.taskId})::int`,
      })
      .from(schema.cliInvocations)
      .innerJoin(schema.tasks, eq(schema.tasks.id, schema.cliInvocations.taskId))
      .innerJoin(
        schema.taskSteps,
        sql`${schema.taskSteps.id} = coalesce(${schema.cliInvocations.taskStepId}, ${schema.cliInvocations.summaryForStepId})`,
      )
      .leftJoin(
        schema.cliProviders,
        eq(schema.cliProviders.id, schema.cliInvocations.cliProviderId),
      )
      .where(window)
      .groupBy(schema.taskSteps.stepId),
    db
      .select({
        served: servedSql,
        invocations: sql<number>`count(*)::int`,
        agentMs: agentMsSql,
        differs: sql<number>`count(*) filter (where ${schema.cliInvocations.modelIdentity} ->> 'match' = 'differs')::int`,
      })
      .from(schema.cliInvocations)
      .innerJoin(schema.tasks, eq(schema.tasks.id, schema.cliInvocations.taskId))
      .where(window)
      .groupBy(servedSql),
    // Token buckets keep the PROVIDER dimension the rollup above does not need, because the
    // cache-inclusive reporters have to be normalised before they are added — see toRawTotals.
    // Same window, same attribution join, so these rows partition exactly the set above.
    db
      .select({
        stepId: schema.taskSteps.stepId,
        provider: schema.cliProviders.name,
        inputTokens: sql<number>`coalesce(sum((${tu} ->> 'inputTokens')::numeric), 0)::int`,
        outputTokens: sql<number>`coalesce(sum((${tu} ->> 'outputTokens')::numeric), 0)::int`,
        cacheReadTokens: sql<number>`coalesce(sum((${tu} ->> 'cacheReadTokens')::numeric), 0)::int`,
        cacheCreationTokens: sql<number>`coalesce(sum((${tu} ->> 'cacheCreationTokens')::numeric), 0)::int`,
      })
      .from(schema.cliInvocations)
      .innerJoin(schema.tasks, eq(schema.tasks.id, schema.cliInvocations.taskId))
      .innerJoin(
        schema.taskSteps,
        sql`${schema.taskSteps.id} = coalesce(${schema.cliInvocations.taskStepId}, ${schema.cliInvocations.summaryForStepId})`,
      )
      .leftJoin(
        schema.cliProviders,
        eq(schema.cliProviders.id, schema.cliInvocations.cliProviderId),
      )
      .where(window)
      .groupBy(schema.taskSteps.stepId, schema.cliProviders.name),
  ]);

  // Per step, normalise each provider's totals and THEN add them — never the reverse; the sum
  // of raw fields mixes two definitions of `input`. A row whose provider was deleted (the FK
  // nulls) is skipped exactly as providerBreakdownWhere skips it, so this reconciles with
  // /summary; MEASURED 0 such rows of 1,853 attributed invocations on this install.
  const rawByStep = new Map<string, ReturnType<typeof toRawTotals>[]>();
  for (const r of tokenRows) {
    if (!r.provider) continue;
    const list = rawByStep.get(r.stepId);
    const raw = toRawTotals({
      provider: r.provider,
      inputTokens: Number(r.inputTokens) || 0,
      outputTokens: Number(r.outputTokens) || 0,
      cacheReadTokens: Number(r.cacheReadTokens) || 0,
      cacheCreationTokens: Number(r.cacheCreationTokens) || 0,
    });
    if (list) list.push(raw);
    else rawByStep.set(r.stepId, [raw]);
  }

  const ranked = stepRows
    .map((r) => {
      const invocations = Number(r.invocations) || 0;
      const tokens = sumNormalizedTokens(rawByStep.get(r.stepId) ?? []);
      return {
        stepId: r.stepId,
        invocations,
        agentMs: Number(r.agentMs) || 0,
        realUsd: Number(r.realUsd) || 0,
        notionalUsd: Number(r.notionalUsd) || 0,
        unpricedInvocations: Number(r.unpricedInvocations) || 0,
        taskCount: Number(r.taskCount) || 0,
        tokens,
        // The same share, carrying the count a reader should judge it by. `n` is INVOCATIONS,
        // not the token denominator sampledRatio() would have used: a 100% write share off two
        // runs is uninformative however many tokens those two runs moved.
        cacheWriteShareSampled: {
          ratio: tokens.cacheWriteShare,
          n: invocations,
          sufficient: hasEnoughSamples(invocations),
        },
      };
    })
    // Tie-broken on the step id so the cap always cuts the same rows — the same reason
    // buildTaskTimeBreakdown breaks its own ties rather than leaving the order to the planner.
    .sort(
      (a, b) =>
        b.agentMs - a.agentMs || b.invocations - a.invocations || a.stepId.localeCompare(b.stepId),
    );

  const currency = await configService.get(CONFIG_KEYS.COST_DISPLAY_CURRENCY);
  const costDisplay = await resolveCostDisplay(
    db,
    isDisplayCurrency(currency) ? currency : 'USD',
    to,
  );

  return c.json({
    range: { from: from.toISOString(), to: to.toISOString(), timeZone: q.timeZone },
    costDisplay,
    rows: ranked.slice(0, STEP_ROW_LIMIT),
    stepCount: ranked.length,
    truncated: ranked.length > STEP_ROW_LIMIT,
    // `served` null covers two cases that are one fact for a reader: no identity was recorded at
    // all, and an identity that names no model. codex and amp report NOTHING by design and are
    // permanently match:'unknown', so this bucket is expected rather than a gap to chase — the
    // client labels it, and nothing here folds it into a model or into a zero.
    models: modelRows
      .map((r) => ({
        served: r.served,
        invocations: Number(r.invocations) || 0,
        agentMs: Number(r.agentMs) || 0,
        differs: Number(r.differs) || 0,
      }))
      .sort((a, b) => b.invocations - a.invocations),
  });
});

/**
 * Reliability: what wasted time, and where.
 *
 * The dimension the original request did not name and the most actionable one in a multi-CLI
 * tool — every column here already existed and none of it was surfaced anywhere.
 *
 * Two counts are deliberately NOT filtered by `invocationAttributionFilter`. Superseded rows
 * ARE the waste being measured (re-rolled work thrown away), and a run killed before it could
 * be attributed to a step is exactly the failure worth counting. Every other figure keeps the
 * filter so it reconciles with the task pages.
 */
statsRoutes.get('/reliability', async (c) => {
  const userId = c.get('userId');
  const q = parseStatsQuery(c.req.query());
  if (q.allUsers && c.get('userRole') !== 'admin') {
    throw new HttpError(403, 'Admin access required for install-wide statistics');
  }
  const db = getDb();
  const from = new Date(q.fromMs);
  const to = new Date(q.toMs);
  const scope = taskScopeFilter(q, userId);
  const providerTerm = q.cliProviderId
    ? [eq(schema.cliInvocations.cliProviderId, q.cliProviderId)]
    : [];
  const window = and(
    ...scope,
    ...providerTerm,
    isNotNull(schema.cliInvocations.startedAt),
    gte(schema.cliInvocations.startedAt, from),
    lt(schema.cliInvocations.startedAt, to),
  );

  const [totals] = await db
    .select({
      invocations: sql<number>`count(*)::int`,
      superseded: sql<number>`count(*) filter (where ${schema.cliInvocations.supersededAt} is not null)::int`,
      // A NULL exit code on a run that ENDED is a process that was killed or orphaned, not one
      // still going: the live rows are excluded by the ended_at test.
      killed: sql<number>`count(*) filter (where ${schema.cliInvocations.endedAt} is not null and ${schema.cliInvocations.exitCode} is null)::int`,
      nonZeroExit: sql<number>`count(*) filter (where ${schema.cliInvocations.exitCode} is not null and ${schema.cliInvocations.exitCode} <> 0)::int`,
      // Within 2% of the hard budget. A run that ends AT its timeout was cut off, and that is
      // invisible in an exit code (the process is killed, so it reports none).
      nearTimeout: sql<number>`count(*) filter (where ${schema.cliInvocations.timeoutMs} is not null and ${schema.cliInvocations.durationMs} >= ${schema.cliInvocations.timeoutMs} * 0.98)::int`,
      withTimeout: sql<number>`count(*) filter (where ${schema.cliInvocations.timeoutMs} is not null)::int`,
      identityDiffers: sql<number>`count(*) filter (where ${schema.cliInvocations.modelIdentity} ->> 'match' = 'differs')::int`,
      identityKnown: sql<number>`count(*) filter (where ${schema.cliInvocations.modelIdentity} ->> 'match' is not null)::int`,
    })
    .from(schema.cliInvocations)
    .innerJoin(schema.tasks, eq(schema.tasks.id, schema.cliInvocations.taskId))
    .where(window);

  const fatalRows = await db
    .select({
      provider: schema.cliProviders.name,
      fatalClass: schema.cliInvocations.providerFatalClass,
      n: sql<number>`count(*)::int`,
    })
    .from(schema.cliInvocations)
    .innerJoin(schema.tasks, eq(schema.tasks.id, schema.cliInvocations.taskId))
    .leftJoin(schema.cliProviders, eq(schema.cliProviders.id, schema.cliInvocations.cliProviderId))
    .where(and(window, isNotNull(schema.cliInvocations.providerFatalClass)))
    .groupBy(schema.cliProviders.name, schema.cliInvocations.providerFatalClass);

  // Steps are scoped through their task, and by the task's own window rather than the
  // invocation clock: a step has no started_at until it runs.
  const stepWindow = and(
    ...scope,
    gte(schema.taskSteps.createdAt, from),
    lt(schema.taskSteps.createdAt, to),
  );
  const [stepTotals] = await db
    .select({
      steps: sql<number>`count(*)::int`,
      failed: sql<number>`count(*) filter (where ${schema.taskSteps.status} = 'failed')::int`,
      // Output that could not be parsed and silently fell back to a stub. A quality loss that
      // finalises as `done`, so nothing else reports it.
      degraded: sql<number>`count(*) filter (where ${schema.taskSteps.degradedNote} is not null)::int`,
      maxRound: sql<number>`coalesce(max(${schema.taskSteps.round}), 0)::int`,
    })
    .from(schema.taskSteps)
    .innerJoin(schema.tasks, eq(schema.tasks.id, schema.taskSteps.taskId))
    .where(stepWindow);

  const failingSteps = await db
    .select({ stepId: schema.taskSteps.stepId, n: sql<number>`count(*)::int` })
    .from(schema.taskSteps)
    .innerJoin(schema.tasks, eq(schema.tasks.id, schema.taskSteps.taskId))
    .where(and(stepWindow, eq(schema.taskSteps.status, 'failed')))
    .groupBy(schema.taskSteps.stepId)
    .orderBy(sql`count(*) desc`)
    .limit(10);

  const eventRows = await db
    .select({ eventType: schema.taskEvents.eventType, n: sql<number>`count(*)::int` })
    .from(schema.taskEvents)
    .innerJoin(schema.tasks, eq(schema.tasks.id, schema.taskEvents.taskId))
    .where(
      and(
        ...scope,
        gte(schema.taskEvents.createdAt, from),
        lt(schema.taskEvents.createdAt, to),
        inArray(schema.taskEvents.eventType, ['step.retry', 'step.revise', 'step.failed']),
      ),
    )
    .groupBy(schema.taskEvents.eventType);

  const invocations = Number(totals?.invocations) || 0;
  const steps = Number(stepTotals?.steps) || 0;
  return c.json({
    range: { from: from.toISOString(), to: to.toISOString(), timeZone: q.timeZone },
    invocations: {
      total: invocations,
      superseded: Number(totals?.superseded) || 0,
      killed: Number(totals?.killed) || 0,
      nonZeroExit: Number(totals?.nonZeroExit) || 0,
      nearTimeout: Number(totals?.nearTimeout) || 0,
      withTimeout: Number(totals?.withTimeout) || 0,
      identityDiffers: Number(totals?.identityDiffers) || 0,
      identityKnown: Number(totals?.identityKnown) || 0,
      supersededRatio: sampledRatio(Number(totals?.superseded) || 0, invocations),
      killedRatio: sampledRatio(Number(totals?.killed) || 0, invocations),
      nearTimeoutRatio: sampledRatio(
        Number(totals?.nearTimeout) || 0,
        Number(totals?.withTimeout) || 0,
      ),
    },
    fatalClasses: fatalRows.map((r) => ({
      provider: r.provider ?? 'unknown',
      fatalClass: r.fatalClass ?? 'unknown',
      count: Number(r.n) || 0,
    })),
    steps: {
      total: steps,
      failed: Number(stepTotals?.failed) || 0,
      degraded: Number(stepTotals?.degraded) || 0,
      maxRound: Number(stepTotals?.maxRound) || 0,
      failedRatio: sampledRatio(Number(stepTotals?.failed) || 0, steps),
      degradedRatio: sampledRatio(Number(stepTotals?.degraded) || 0, steps),
      topFailing: failingSteps.map((r) => ({ stepId: r.stepId, count: Number(r.n) || 0 })),
    },
    events: Object.fromEntries(eventRows.map((r) => [r.eventType, Number(r.n) || 0])),
  });
});

/**
 * Quality: what the reviewers raised, and what became of it.
 *
 * Two things this must not claim. `fixed` is deliberately never written to `review_findings`,
 * so an `open` row is NOT evidence that a defect still stands — a reviewer that was skipped,
 * budget-killed or simply reworded produces the same absence. And `dimension` lives in `raw`
 * and only when the reviewer emitted it, so anything else is reported as `unclassified` rather
 * than folded into a neighbour.
 */
statsRoutes.get('/quality', async (c) => {
  const userId = c.get('userId');
  const q = parseStatsQuery(c.req.query());
  if (q.allUsers && c.get('userRole') !== 'admin') {
    throw new HttpError(403, 'Admin access required for install-wide statistics');
  }
  const db = getDb();
  const from = new Date(q.fromMs);
  const to = new Date(q.toMs);
  const scope = taskScopeFilter(q, userId);
  const window = and(
    ...scope,
    gte(schema.reviewFindings.createdAt, from),
    lt(schema.reviewFindings.createdAt, to),
  );

  const [totals] = await db
    .select({
      findings: sql<number>`count(*)::int`,
      blocking: sql<number>`count(*) filter (where ${schema.reviewFindings.blocking})::int`,
      recurring: sql<number>`count(*) filter (where ${schema.reviewFindings.recurrenceCount} > 0)::int`,
      tasks: sql<number>`count(distinct ${schema.reviewFindings.taskId})::int`,
    })
    .from(schema.reviewFindings)
    .innerJoin(schema.tasks, eq(schema.tasks.id, schema.reviewFindings.taskId))
    .where(window);

  const [bySeverity, byDisposition, byReviewer, byDimension] = await Promise.all([
    db
      .select({ key: schema.reviewFindings.severity, n: sql<number>`count(*)::int` })
      .from(schema.reviewFindings)
      .innerJoin(schema.tasks, eq(schema.tasks.id, schema.reviewFindings.taskId))
      .where(window)
      .groupBy(schema.reviewFindings.severity),
    db
      .select({ key: schema.reviewFindings.disposition, n: sql<number>`count(*)::int` })
      .from(schema.reviewFindings)
      .innerJoin(schema.tasks, eq(schema.tasks.id, schema.reviewFindings.taskId))
      .where(window)
      .groupBy(schema.reviewFindings.disposition),
    db
      .select({
        reviewerId: schema.reviewFindings.reviewerId,
        n: sql<number>`count(*)::int`,
        refuted: sql<number>`count(*) filter (where ${schema.reviewFindings.disposition} = 'dismissed_refuted')::int`,
        blocking: sql<number>`count(*) filter (where ${schema.reviewFindings.blocking})::int`,
      })
      .from(schema.reviewFindings)
      .innerJoin(schema.tasks, eq(schema.tasks.id, schema.reviewFindings.taskId))
      .where(window)
      .groupBy(schema.reviewFindings.reviewerId)
      .orderBy(sql`count(*) desc`)
      .limit(20),
    db
      .select({
        // `raw ->> 'dimension'` is present only when the reviewer emitted one; coalescing to a
        // named bucket keeps that visible instead of implying full coverage.
        key: sql<string>`coalesce(${schema.reviewFindings.raw} ->> 'dimension', 'unclassified')`,
        n: sql<number>`count(*)::int`,
      })
      .from(schema.reviewFindings)
      .innerJoin(schema.tasks, eq(schema.tasks.id, schema.reviewFindings.taskId))
      .where(window)
      .groupBy(sql`coalesce(${schema.reviewFindings.raw} ->> 'dimension', 'unclassified')`),
  ]);

  const findings = Number(totals?.findings) || 0;
  const asCounts = (rows: Array<{ key: string | null; n: number }>) =>
    rows
      .map((r) => ({ key: r.key ?? 'unknown', count: Number(r.n) || 0 }))
      .sort((a, b) => b.count - a.count);

  return c.json({
    range: { from: from.toISOString(), to: to.toISOString(), timeZone: q.timeZone },
    totals: {
      findings,
      blocking: Number(totals?.blocking) || 0,
      recurring: Number(totals?.recurring) || 0,
      tasksWithFindings: Number(totals?.tasks) || 0,
      recurringRatio: sampledRatio(Number(totals?.recurring) || 0, findings),
    },
    bySeverity: asCounts(bySeverity),
    byDisposition: asCounts(byDisposition),
    byDimension: asCounts(byDimension),
    byReviewer: byReviewer.map((r) => ({
      reviewerId: r.reviewerId,
      count: Number(r.n) || 0,
      blocking: Number(r.blocking) || 0,
      // How much of what this reviewer raised was disproved by the refutation pass. A high
      // share is reviewer NOISE, which is the only thing here that judges a reviewer.
      refutedRatio: sampledRatio(Number(r.refuted) || 0, Number(r.n) || 0),
    })),
    // Stated on the response rather than left for the reader to infer, because absence of a
    // finding is the one thing this table cannot be read as.
    caveat:
      'A finding is never marked fixed: absence in a later round is not evidence of a fix, since a skipped or budget-killed reviewer produces the same absence.',
  });
});

/**
 * Estimate accuracy across every repository, using the same aggregator the per-repo dashboard
 * already uses so the two cannot disagree about what MAPE means here.
 */
statsRoutes.get('/estimates', async (c) => {
  const userId = c.get('userId');
  const q = parseStatsQuery(c.req.query());
  if (q.allUsers && c.get('userRole') !== 'admin') {
    throw new HttpError(403, 'Admin access required for install-wide statistics');
  }
  const db = getDb();
  const from = new Date(q.fromMs);
  const to = new Date(q.toMs);
  const scope = taskScopeFilter(q, userId);

  const rows = await db
    .select({
      id: schema.tasks.id,
      title: schema.tasks.title,
      completedAt: schema.tasks.completedAt,
      aiEstimatedTimeHours: schema.tasks.aiEstimatedTimeHours,
      estimatedTimeHours: schema.tasks.estimatedTimeHours,
    })
    .from(schema.tasks)
    .where(
      and(
        ...scope,
        eq(schema.tasks.status, 'completed'),
        isNotNull(schema.tasks.completedAt),
        gte(schema.tasks.completedAt, from),
        lt(schema.tasks.completedAt, to),
        isNotNull(schema.tasks.aiEstimatedTimeHours),
      ),
    );

  const effortByTask = new Map<string, number>();
  if (rows.length > 0) {
    const stepRows = await db
      .select({
        taskId: schema.taskSteps.taskId,
        startedAt: schema.taskSteps.startedAt,
        endedAt: schema.taskSteps.endedAt,
        idleMs: schema.taskSteps.idleMs,
        userActiveMs: schema.taskSteps.userActiveMs,
        waitingStartedAt: schema.taskSteps.waitingStartedAt,
        status: schema.taskSteps.status,
        carriedWorkMs: schema.taskSteps.carriedWorkMs,
        carriedIdleMs: schema.taskSteps.carriedIdleMs,
        carriedUserActiveMs: schema.taskSteps.carriedUserActiveMs,
      })
      .from(schema.taskSteps)
      .where(
        inArray(
          schema.taskSteps.taskId,
          rows.map((r) => r.id),
        ),
      );
    const byTask = new Map<string, (typeof stepRows)[number][]>();
    for (const s of stepRows) {
      const list = byTask.get(s.taskId);
      if (list) list.push(s);
      else byTask.set(s.taskId, [s]);
    }
    const now = Date.now();
    for (const t of rows) {
      // Capped at the task's own completion, for the reason the per-repo endpoint records: an
      // uncapped open step inflates "actual" and biases the estimator against its own past.
      const endMs = t.completedAt ? t.completedAt.getTime() : now;
      const timing = computeTaskTiming(byTask.get(t.id) ?? [], endMs);
      effortByTask.set(t.id, (timing.workMs + timing.userActiveMs) / 3_600_000);
    }
  }

  const accuracy = buildEstimationAccuracy(
    rows.map((t) => ({
      taskId: t.id,
      title: t.title,
      completedAt: t.completedAt ? t.completedAt.toISOString() : null,
      aiEstimatedHours: t.aiEstimatedTimeHours ?? 0,
      confirmedHours: t.estimatedTimeHours ?? null,
      actualHours: Math.round((effortByTask.get(t.id) ?? 0) * 100) / 100,
    })),
  );

  return c.json({
    range: { from: from.toISOString(), to: to.toISOString(), timeZone: q.timeZone },
    ...accuracy,
  });
});

/**
 * Plan progress and velocity.
 *
 * Two different questions, deliberately reported as two different numbers:
 *
 *  - PROGRESS is "how much of the plan already exists" — a snapshot over `status`. A
 *    `from_repo` plan starts partly complete by construction, because its nodes describe code
 *    that is already written.
 *  - VELOCITY is "how much did we finish in this window" — and it can only count nodes that
 *    TRANSITIONED into `done`, which is what `plan_nodes.done_at` records. A node created
 *    already done contributes to progress and not to velocity. Conflating the two produces a
 *    chart that is one enormous spike on the day the plan was built.
 *
 * Coverage is reported rather than assumed: a node greened before `done_at` existed, or one
 * restored from the committed plan mirror, carries no date. Those are counted and named, so a
 * low velocity reading can be told apart from a missing measurement.
 *
 * Scoped through `repositories.user_id` — `plan_nodes` carries neither a user nor a task.
 */
statsRoutes.get('/plan', async (c) => {
  const userId = c.get('userId');
  const q = parseStatsQuery(c.req.query());
  if (q.allUsers && c.get('userRole') !== 'admin') {
    throw new HttpError(403, 'Admin access required for install-wide statistics');
  }
  const db = getDb();
  const from = new Date(q.fromMs);
  const to = new Date(q.toMs);

  const scope = [
    ...(q.allUsers ? [] : [eq(schema.repositories.userId, userId)]),
    ...(q.repositoryId ? [eq(schema.planNodes.repositoryId, q.repositoryId)] : []),
  ];

  const rows = await db
    .select({
      repositoryId: schema.planNodes.repositoryId,
      repositoryName: schema.repositories.name,
      status: schema.planNodes.status,
      taskable: schema.planNodes.taskable,
      n: sql<number>`count(*)::int`,
      // Done nodes whose completion moment is actually known. The complement is what the
      // coverage note names.
      dated: sql<number>`count(*) filter (where ${schema.planNodes.doneAt} is not null)::int`,
    })
    .from(schema.planNodes)
    .innerJoin(schema.repositories, eq(schema.repositories.id, schema.planNodes.repositoryId))
    .where(scope.length ? and(...scope) : undefined)
    .groupBy(
      schema.planNodes.repositoryId,
      schema.repositories.name,
      schema.planNodes.status,
      schema.planNodes.taskable,
    );

  // Nodes that TRANSITIONED into done inside the window, for the velocity series. Bucketed by
  // the same JS day-cutter every other series uses, so a plan chart and a spend chart agree
  // about where a day starts.
  const completedRows = await db
    .select({ doneAt: schema.planNodes.doneAt })
    .from(schema.planNodes)
    .innerJoin(schema.repositories, eq(schema.repositories.id, schema.planNodes.repositoryId))
    .where(
      and(
        ...scope,
        isNotNull(schema.planNodes.doneAt),
        gte(schema.planNodes.doneAt, from),
        lt(schema.planNodes.doneAt, to),
      ),
    );

  const byDay = new Map<string, number>();
  for (const key of dayKeysBetween(q.fromMs, q.toMs, q.timeZone)) byDay.set(key, 0);
  for (const r of completedRows) {
    if (!r.doneAt) continue;
    const key = dayKey(r.doneAt.getTime(), q.timeZone);
    byDay.set(key, (byDay.get(key) ?? 0) + 1);
  }

  interface RepoAcc {
    repositoryId: string;
    name: string;
    total: number;
    taskable: number;
    byStatus: Record<string, number>;
    doneDated: number;
  }
  const repos = new Map<string, RepoAcc>();
  for (const r of rows) {
    const acc = repos.get(r.repositoryId) ?? {
      repositoryId: r.repositoryId,
      name: r.repositoryName ?? 'unknown',
      total: 0,
      taskable: 0,
      byStatus: {},
      doneDated: 0,
    };
    const n = Number(r.n) || 0;
    acc.total += n;
    if (r.taskable) acc.taskable += n;
    acc.byStatus[r.status] = (acc.byStatus[r.status] ?? 0) + n;
    if (r.status === 'done') acc.doneDated += Number(r.dated) || 0;
    repos.set(r.repositoryId, acc);
  }

  const repoList = [...repos.values()].sort((a, b) => b.total - a.total);
  const totals = repoList.reduce(
    (acc, r) => {
      acc.nodes += r.total;
      acc.taskable += r.taskable;
      acc.doneDated += r.doneDated;
      for (const [k, v] of Object.entries(r.byStatus)) acc.byStatus[k] = (acc.byStatus[k] ?? 0) + v;
      return acc;
    },
    { nodes: 0, taskable: 0, doneDated: 0, byStatus: {} as Record<string, number> },
  );

  const done = totals.byStatus['done'] ?? 0;
  // `not_applicable` counts as settled: it is a verdict a person entered, and a node written
  // off is not outstanding work. Same rule the status roll-up applies when greening a parent.
  const settled = done + (totals.byStatus['not_applicable'] ?? 0);
  const remaining = Math.max(0, totals.nodes - settled);

  const completedInWindow = completedRows.length;
  const windowDays = Math.max(1, (q.toMs - q.fromMs) / 86_400_000);
  const perWeek = completedInWindow > 0 ? (completedInWindow / windowDays) * 7 : 0;

  return c.json({
    range: { from: from.toISOString(), to: to.toISOString(), timeZone: q.timeZone },
    totals: {
      nodes: totals.nodes,
      taskable: totals.taskable,
      byStatus: totals.byStatus,
      settled,
      remaining,
      // Progress over the WHOLE plan, not the window: "how much of this project exists".
      progressRatio: sampledRatio(settled, totals.nodes),
    },
    velocity: {
      completedInWindow,
      perWeek: Math.round(perWeek * 10) / 10,
      // Remaining work at the rate this window actually showed. Null rather than Infinity when
      // nothing completed: "at zero per week it never finishes" is arithmetic, not a forecast.
      projectedWeeksRemaining: perWeek > 0 ? Math.round((remaining / perWeek) * 10) / 10 : null,
      days: [...byDay.entries()]
        .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
        .map(([bucket, completed]) => ({ bucket, completed })),
    },
    coverage: {
      doneTotal: done,
      doneDated: totals.doneDated,
      doneUndated: Math.max(0, done - totals.doneDated),
    },
    repositories: repoList,
  });
});
