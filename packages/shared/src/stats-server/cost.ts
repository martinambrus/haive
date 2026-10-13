import { and, desc, eq, isNotNull, isNull, or, sql, type SQL } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import { COST_METERED_PROVIDERS, resolveCostBasis } from '../cli-providers/catalog.js';
import type { AuthMode, CliProviderName } from '../types/index.js';

/** The one place that decides which dollars are REAL, for every rollup.
 *
 *  Two eras, and the row itself says which one it belongs to:
 *
 *  - `cli_invocations.cost` present — the cost pass ran. It already decided
 *    `billable` at write time, where the provider, its auth mode, the answering model
 *    and the price source were all in hand, so the rollup just honors that flag. This
 *    is what lets zai/muse/openrouter contribute REAL money (computed from their own
 *    per-model rates) while their CLI-reported total, which the claude binary prices
 *    against Anthropic's table, stays out of it.
 *
 *  - `cost` NULL — a row written before the column existed, or one whose cost pass
 *    failed. Falls back to exactly the previous rule: metered provider on api_key
 *    auth only. Keeping this branch is what preserves the real spend already recorded
 *    (grok's api_key invocations) instead of zeroing history.
 *
 *  A CASE on the PRESENCE of the snapshot, never a `coalesce` on its value: a snapshot
 *  that deliberately prices a row at zero (a subscription plan, an unpriced model)
 *  would otherwise fall through and resurrect the legacy number for that row. */
export function realCostUsdSql() {
  return sql<number>`coalesce(sum(${realCostRowSql()}), 0)::double precision`;
}

/** The per-ROW form of the same rule, for callers that bucket in JS instead of grouping in
 *  SQL — the timeline endpoint cuts its day buckets in the viewer's zone with `Intl`, and
 *  re-implementing the cost decision there would be a second copy of the rule that could
 *  drift from this one. Selecting the decision per row keeps ONE cost rule and ONE bucketer. */
export function realCostRowSql() {
  const cost = schema.cliInvocations.cost;
  const tu = schema.cliInvocations.tokenUsage;
  return sql<number>`(
    case
      when ${cost} is not null then
        (case when ${cost} ->> 'billable' = 'true'
              then coalesce((${cost} ->> 'costUsd')::numeric, 0)
              else 0 end)
      when ${schema.cliProviders.name}::text in ${COST_METERED_PROVIDERS}
           and ${schema.cliProviders.authMode} = 'api_key' then
        coalesce((${tu} ->> 'costUsd')::numeric, 0)
      else 0
    end
  )`;
}

/** The mirror of realCostUsdSql: what the invocations that are NOT billed per token
 *  WOULD have cost at list API rates. Never summed into real spend and never shown in
 *  the same colour — it is the counterfactual that says what the subscriptions save,
 *  which is exactly the number a flat plan hides.
 *
 *  Same two eras as the real rule, each restricted to the half that one throws away:
 *
 *  - snapshot present — `billable = false`, minus `source = 'none'`. A `none` row's
 *    costUsd is 0 by construction (unpriced model, partial computation), and a 0 here
 *    would read as "this run was free" rather than "we could not price it".
 *
 *  - `cost` NULL (legacy) — a metered provider on SUBSCRIPTION auth, the exact
 *    complement of the legacy real rule's api_key filter. Metered ONLY, because just a
 *    CLI that prices its own backend reports a usable number: the claude binary applies
 *    Anthropic's table to the zai/muse/openrouter/ollama wrappers too, and that total is
 *    fiction (5,968 USD of it against local ollama tokens on this install alone). codex
 *    and gemini report no cost at all and contribute 0, which is the honest answer.
 *
 *  Priced at whatever rate applied when the run happened, which is the right reading of
 *  "what we would have paid" rather than "what those tokens would cost today". */
export function notionalCostUsdSql() {
  return sql<number>`coalesce(sum(${notionalCostRowSql()}), 0)::double precision`;
}

/** Per-ROW notional cost. Same reason as realCostRowSql. */
export function notionalCostRowSql() {
  const cost = schema.cliInvocations.cost;
  const tu = schema.cliInvocations.tokenUsage;
  return sql<number>`(
    case
      when ${cost} is not null then
        (case when ${cost} ->> 'billable' = 'false' and ${cost} ->> 'source' <> 'none'
              then coalesce((${cost} ->> 'costUsd')::numeric, 0)
              else 0 end)
      when ${schema.cliProviders.name}::text in ${COST_METERED_PROVIDERS}
           and ${schema.cliProviders.authMode} = 'subscription' then
        coalesce((${tu} ->> 'costUsd')::numeric, 0)
      else 0
    end
  )`;
}

export interface TaskProviderUsage {
  /** CliProviderName of the invocations. */
  provider: string;
  /** CliProviderMetadata.costBasis — 'metered' | 'subscription' | 'local' | 'estimate'. */
  costBasis: string;
  invocations: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** Real dollars, by the shared rule in realCostUsdSql. */
  costUsd: number;
  /** What this provider's non-billed-per-token invocations WOULD have cost at list API
   *  rates (see notionalCostUsdSql). Informational only: never added to costUsd, and 0
   *  when nothing in the group could be priced. */
  notionalCostUsd: number;
  /** Where those dollars came from, so the UI can label the number instead of leaving
   *  the reader to guess whether a CLI reported it or Haive priced it. `mixed` when
   *  one provider's invocations in this task used more than one source — normal for a
   *  task that ran before and after a price row appeared. */
  costSource: 'reported' | 'computed' | 'manual' | 'none' | 'mixed' | 'legacy';
  /** Invocations this provider ran that carry tokens but no usable price. The UI shows
   *  this rather than silently understating the total. */
  unpricedInvocations: number;
}

export interface CostDisplay {
  /** The configured display currency. Always what the UI should format in. */
  currency: string;
  /** USD per one unit of `currency`. Divide a USD cost by this. 1 for USD. */
  usdPerUnit: number;
  /** The rate's own date, so the UI can say what it converted at. */
  rateDate: string | null;
  /** True when no rate existed on or before the task's date and the EARLIEST known
   *  rate was used instead. Unavoidable for tasks that predate FX collection, and it
   *  must be shown rather than hidden — an approximate conversion presented as exact
   *  is the same class of error as a guessed price. */
  approximate: boolean;
}

/** Resolve the FX rate a task's costs should be displayed at.
 *
 *  Dated on the TASK, not on each invocation: the point of dating is reproducibility —
 *  re-rendering a finished task next month must yield the same figure — and a task's
 *  completion date is fixed while the per-invocation refinement would move a total by
 *  well under the rounding the UI shows. One lookup per task response rather than a
 *  join across every row.
 *
 *  Lookup is "the most recent rate on or before that date", which is also the correct
 *  reading of a feed that skips weekends and holidays. Falls back to the earliest rate
 *  on record (flagged approximate) for a task older than FX collection, and finally to
 *  USD 1:1 when no rate exists at all — so a missing feed degrades to showing USD
 *  rather than to showing nothing. */
export async function resolveCostDisplay(
  db: Database,
  currency: string,
  on: Date | null,
): Promise<CostDisplay> {
  if (currency === 'USD') {
    return { currency: 'USD', usdPerUnit: 1, rateDate: null, approximate: false };
  }
  const onDate = (on ?? new Date()).toISOString().slice(0, 10);
  const [onOrBefore] = await db
    .select()
    .from(schema.fxRates)
    .where(and(eq(schema.fxRates.currency, currency), sql`${schema.fxRates.rateDate} <= ${onDate}`))
    .orderBy(desc(schema.fxRates.rateDate))
    .limit(1);
  if (onOrBefore) {
    return {
      currency,
      usdPerUnit: onOrBefore.usdPerUnit,
      rateDate: onOrBefore.rateDate,
      approximate: false,
    };
  }
  const [earliest] = await db
    .select()
    .from(schema.fxRates)
    .where(eq(schema.fxRates.currency, currency))
    .orderBy(schema.fxRates.rateDate)
    .limit(1);
  if (earliest) {
    return {
      currency,
      usdPerUnit: earliest.usdPerUnit,
      rateDate: earliest.rateDate,
      approximate: true,
    };
  }
  return { currency: 'USD', usdPerUnit: 1, rateDate: null, approximate: false };
}

/** Collapse the distinct per-invocation cost sources in one group into one label.
 *  An empty set means every row predates the cost pass ('legacy'); more than one
 *  distinct source means the group genuinely mixes them. */
function summarizeCostSources(sources: unknown): TaskProviderUsage['costSource'] {
  const list = Array.isArray(sources)
    ? sources.filter((s): s is string => typeof s === 'string')
    : [];
  if (list.length === 0) return 'legacy';
  if (list.length > 1) return 'mixed';
  const only = list[0];
  return only === 'reported' || only === 'computed' || only === 'manual' || only === 'none'
    ? only
    : 'legacy';
}

/** The same rollup over an arbitrary set of invocations — a date range, a repository, one
 *  user's rows — for the statistics endpoints.
 *
 *  Shares one body with the per-task version rather than copying forty lines of cost SQL,
 *  because the two totals have to agree: a task's provider card and the same task inside a
 *  stats window must not disagree about what it cost.
 *
 *  `where` is ANDed with the reconciliation filter every invocation rollup carries
 *  (non-superseded, attributed to a step). Callers scope by user through the `tasks` join. */
export async function sumProviderBreakdownWhere(
  db: Database,
  where: SQL | undefined,
): Promise<TaskProviderUsage[]> {
  return providerBreakdownWhere(db, where);
}

export async function providerBreakdownWhere(
  db: Database,
  where: SQL | undefined,
): Promise<TaskProviderUsage[]> {
  const tu = schema.cliInvocations.tokenUsage;
  const rows = await db
    .select({
      provider: schema.cliProviders.name,
      authMode: schema.cliProviders.authMode,
      invocations: sql<number>`count(*)::int`,
      inputTokens: sql<number>`coalesce(sum((${tu} ->> 'inputTokens')::numeric), 0)::int`,
      outputTokens: sql<number>`coalesce(sum((${tu} ->> 'outputTokens')::numeric), 0)::int`,
      cacheReadTokens: sql<number>`coalesce(sum((${tu} ->> 'cacheReadTokens')::numeric), 0)::int`,
      cacheCreationTokens: sql<number>`coalesce(sum((${tu} ->> 'cacheCreationTokens')::numeric), 0)::int`,
      costUsd: realCostUsdSql(),
      // The subscription counterfactual, kept beside the real number rather than folded
      // into it — the UI shows it greyed and clearly labelled as not-spent.
      notionalCostUsd: notionalCostUsdSql(),
      // Distinct non-null sources present in this group, so the caller can label the
      // number ('mixed' when a provider's invocations disagree). Legacy rows report no
      // source at all and fall out as an empty array.
      costSources: sql<
        string[]
      >`coalesce(array_agg(distinct ${schema.cliInvocations.cost} ->> 'source') filter (where ${schema.cliInvocations.cost} is not null), '{}')`,
      unpricedInvocations: sql<number>`count(*) filter (where ${schema.cliInvocations.cost} ->> 'source' = 'none')::int`,
    })
    .from(schema.cliInvocations)
    // Behaviour-neutral for the per-task caller and required by the range callers, which scope
    // by tasks.user_id: cli_invocations.task_id is NOT NULL with a cascade FK, so an inner join
    // here can never drop a row that the un-joined query would have returned.
    .innerJoin(schema.tasks, eq(schema.tasks.id, schema.cliInvocations.taskId))
    .leftJoin(schema.cliProviders, eq(schema.cliProviders.id, schema.cliInvocations.cliProviderId))
    .where(
      and(
        where,
        isNull(schema.cliInvocations.supersededAt),
        or(
          isNotNull(schema.cliInvocations.taskStepId),
          isNotNull(schema.cliInvocations.summaryForStepId),
        ),
      ),
    )
    .groupBy(schema.cliProviders.name, schema.cliProviders.authMode);

  const out: TaskProviderUsage[] = [];
  for (const row of rows) {
    if (!row.provider) continue; // provider row deleted (cli_provider_id set null) — skip
    const name = row.provider as CliProviderName;
    const authMode = (row.authMode ?? 'subscription') as AuthMode;
    const basis = resolveCostBasis(name, authMode);
    const inputTokens = Number(row.inputTokens) || 0;
    const outputTokens = Number(row.outputTokens) || 0;
    const invocations = Number(row.invocations) || 0;
    if (inputTokens === 0 && outputTokens === 0 && invocations === 0) continue;
    out.push({
      provider: name,
      costBasis: basis,
      invocations,
      inputTokens,
      outputTokens,
      cacheReadTokens: Number(row.cacheReadTokens) || 0,
      cacheCreationTokens: Number(row.cacheCreationTokens) || 0,
      // No basis gate here any more: realCostUsdSql already applied the billable
      // decision per row, and re-gating on the CURRENT provider config would zero a
      // legitimately-computed cost whenever a provider's auth mode changed later.
      costUsd: Number(row.costUsd) || 0,
      notionalCostUsd: Number(row.notionalCostUsd) || 0,
      costSource: summarizeCostSources(row.costSources),
      unpricedInvocations: Number(row.unpricedInvocations) || 0,
    });
  }
  return out.sort((a, b) => b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens));
}
