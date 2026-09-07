'use client';

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import dynamic from 'next/dynamic';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  api,
  getStatsEstimates,
  getStatsPlan,
  getStatsQuality,
  getStatsReliability,
  getStatsSteps,
  getStatsSummary,
  getStatsTaskTime,
  getStatsTimeline,
  getUiPrefs,
  putUiPrefs,
  type Repository,
  type StatsEstimates,
  type StatsPlan,
  type StatsQuality,
  type StatsQueryParams,
  type StatsReliability,
  type StatsSteps,
  type StatsSummary,
  type StatsTaskClass,
  type StatsTaskTime,
  type StatsTimeline,
  type UiPrefs,
} from '@/lib/api-client';
import { Card, CardDescription, CardHeader, CardTitle, Input } from '@/components/ui';
import { StatTile } from '@/components/stats/stat-tile';
import { ActivityHeatmap } from '@/components/stats/activity-heatmap';
import { StackedShareBar } from '@/components/stats/stacked-share-bar';
import { RankedBars, InlineBar } from '@/components/stats/ranked-bars';
import { CHART_COLORS, TOKEN_COLORS } from '@/components/stats/palette';
import { usePageTitle } from '@/lib/use-page-title';
import { formatDuration } from '@/lib/format-duration';
import { formatCost } from '@/lib/format-cost';
import { formatTokens } from '@/lib/format-tokens';
import {
  formatAgentHours,
  formatConcurrency,
  formatCount,
  formatPercent,
  formatProjection,
  formatSampledRatio,
  isUnderSampled,
} from '@/lib/stats/format-stats';
import { isHeatMetric, localDayRange, type HeatMetric } from '@/lib/stats/heat-scale';
import {
  isRangePresetId,
  parseCustomRange,
  presetIsRedundant,
  RANGE_PRESETS,
  resolvePreset,
  toDatetimeLocal,
  type RangePresetId,
} from '@/lib/stats/range-presets';

const SpendChart = dynamic(() => import('@/components/stats/charts').then((m) => m.SpendChart), {
  ssr: false,
  loading: () => <div className="h-[220px] text-sm text-neutral-500">Loading chart...</div>,
});
const ActivityChart = dynamic(
  () => import('@/components/stats/charts').then((m) => m.ActivityChart),
  {
    ssr: false,
    loading: () => <div className="h-[220px] text-sm text-neutral-500">Loading chart...</div>,
  },
);
const PlanVelocityChart = dynamic(
  () => import('@/components/stats/charts').then((m) => m.PlanVelocityChart),
  {
    ssr: false,
    loading: () => <div className="h-[220px] text-sm text-neutral-500">Loading chart...</div>,
  },
);

/** Repeated rather than shared: four other pages already carry their own copy of this string,
 *  and unifying them is a refactor this change has no business making. */
const SELECT_CLASS =
  'h-9 rounded-md border border-neutral-800 bg-neutral-950 px-2 text-sm text-neutral-100 outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500';

const TABS = ['money', 'time', 'steps', 'plan', 'reliability', 'quality', 'estimates'] as const;
type Tab = (typeof TABS)[number];
const TAB_LABELS: Record<Tab, string> = {
  money: 'Money',
  time: 'Time & throughput',
  steps: 'Steps & models',
  plan: 'Plan',
  reliability: 'Reliability',
  quality: 'Quality',
  estimates: 'Estimates',
};

const TASK_CLASS_OPTIONS: Array<{ value: '' | StatsTaskClass; label: string }> = [
  { value: '', label: 'All classes' },
  { value: 'work', label: 'Work' },
  { value: 'plan', label: 'Plan' },
  { value: 'setup', label: 'Setup' },
  { value: 'run', label: 'Run' },
  { value: 'other', label: 'Other' },
];

/** Derived from the filter options rather than restated, so a relabelled class renames both. */
const TASK_CLASS_LABELS = new Map(TASK_CLASS_OPTIONS.map((o) => [o.value, o.label]));

/** Severity is an ORDERED SCALE, so its breakdown renders in scale order rather than by count —
 *  sorting a scale by size destroys the thing the scale encodes. The endpoint groups without an
 *  ORDER BY, so the order has to be imposed here; an unknown key sorts last rather than being
 *  dropped. The colours are the reserved status steps, which is what a severity IS, and each one
 *  is read alongside its own label rather than from the hue alone. */
const SEVERITY_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
const SEVERITY_COLOR: Record<string, string> = {
  critical: '#d03b3b',
  high: '#ec835a',
  medium: '#fab219',
  low: '#a3a3a3',
};

/** Mirrors ABANDONED_STATUSES in the stats route: a task that ended with nothing to show. */
const ABANDONED_TASK_STATUSES = new Set(['failed', 'cancelled']);

function isTab(v: string | null): v is Tab {
  return !!v && (TABS as readonly string[]).includes(v);
}

export default function StatsPage() {
  return (
    // useSearchParams needs a Suspense boundary to keep the route from opting the whole page
    // out of static rendering.
    <Suspense fallback={<div className="text-sm text-neutral-500">Loading...</div>}>
      <StatsPageInner />
    </Suspense>
  );
}

function StatsPageInner() {
  usePageTitle('Statistics');
  const router = useRouter();
  const searchParams = useSearchParams();

  // URL is the source of truth for every filter, so a view is shareable and the back button
  // works — the same arrangement the tasks listing uses.
  const preset: RangePresetId = isRangePresetId(searchParams.get('preset'))
    ? (searchParams.get('preset') as RangePresetId)
    : '30d';
  const tab: Tab = isTab(searchParams.get('tab')) ? (searchParams.get('tab') as Tab) : 'money';
  const heatMetric: HeatMetric = isHeatMetric(searchParams.get('heat'))
    ? (searchParams.get('heat') as HeatMetric)
    : 'agent';
  const customFrom = searchParams.get('from') ?? '';
  const customTo = searchParams.get('to') ?? '';
  const repositoryId = searchParams.get('repositoryId') ?? '';
  const taskClass = searchParams.get('taskClass') ?? '';
  const filterKey = `${preset}|${customFrom}|${customTo}|${repositoryId}|${taskClass}`;

  // Resolved on the CLIENT only, and null until it is. `Intl...timeZone` returns the server
  // container's zone (UTC) during SSR and the viewer's in the browser, so seeding state with it
  // renders two different values and React discards the whole tree on a hydration mismatch.
  // Null also gates the first fetch, so the window is requested once, in the right zone.
  const [timeZone, setTimeZone] = useState<string | null>(null);
  // The clock a relative preset ("last 30 days") is measured from, anchored ONCE on the client
  // for the same reason. Date.now() differs by milliseconds between the server render and
  // hydration, and it reaches the DOM through the drill-through href — which React compares
  // attribute by attribute. Anchoring it also keeps the window stable while the page is open,
  // so a re-render cannot quietly shift the range under a chart the user is reading.
  const [nowMs, setNowMs] = useState<number | null>(null);
  const prefsRef = useRef<UiPrefs>({});

  const [summary, setSummary] = useState<StatsSummary | null>(null);
  const [timeline, setTimeline] = useState<StatsTimeline | null>(null);
  const [reliability, setReliability] = useState<StatsReliability | null>(null);
  const [quality, setQuality] = useState<StatsQuality | null>(null);
  const [estimates, setEstimates] = useState<StatsEstimates | null>(null);
  const [plan, setPlan] = useState<StatsPlan | null>(null);
  const [taskTime, setTaskTime] = useState<StatsTaskTime | null>(null);
  const [steps, setSteps] = useState<StatsSteps | null>(null);
  const [repos, setRepos] = useState<Repository[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // The stored zone wins over the browser's once it arrives. Merged with local precedence and
  // written back whole, because putUiPrefs replaces the entire blob — the idiom the plan page
  // established.
  useEffect(() => {
    setNowMs(Date.now());
    const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    getUiPrefs()
      .then((p) => {
        prefsRef.current = { ...p, ...prefsRef.current };
        setTimeZone(p.statsTimeZone || browserZone);
      })
      .catch(() => {
        // A failed preference read is not a reason to show nothing.
        setTimeZone(browserZone);
      });
    // Inline rather than a named wrapper, matching how the repos and new-task pages fetch it.
    api
      .get<{ repositories: Repository[] }>('/repos')
      .then((r) => setRepos(r.repositories))
      .catch(() => {
        /* the repository filter is optional */
      });
  }, []);

  const persistTimeZone = useCallback((tz: string) => {
    const next = { ...prefsRef.current, statsTimeZone: tz };
    prefsRef.current = next;
    void putUiPrefs(next).catch(() => {
      /* a failed preference write must not break the page */
    });
  }, []);

  function setParam(key: string, value: string) {
    const params = new URLSearchParams(searchParams.toString());
    if (value) params.set(key, value);
    else params.delete(key);
    const qs = params.toString();
    router.replace(qs ? `/stats?${qs}` : '/stats', { scroll: false });
  }

  const range = useMemo(() => {
    if (nowMs === null) return null;
    if (preset === 'custom') {
      // An incomplete custom range falls back to 30 days rather than requesting something the
      // API will reject while the user is still typing the second date.
      return parseCustomRange(customFrom, customTo) ?? resolvePreset('30d', nowMs);
    }
    return resolvePreset(preset, nowMs);
    // `filterKey` deliberately drives this rather than the individual params.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterKey, nowMs]);

  const params: StatsQueryParams | null = useMemo(
    () =>
      timeZone === null || range === null
        ? null
        : {
            from: new Date(range.fromMs).toISOString(),
            to: new Date(range.toMs).toISOString(),
            tz: timeZone,
            ...(repositoryId ? { repositoryId } : {}),
            ...(taskClass ? { taskClass: taskClass as StatsTaskClass } : {}),
          },
    [range, timeZone, repositoryId, taskClass],
  );

  // Summary and timeline back the header and two tabs, so they always load. The other three
  // load only when their tab is opened — the point of one endpoint per tab.
  useEffect(() => {
    if (!params) return;
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const [s, t] = await Promise.all([getStatsSummary(params), getStatsTimeline(params)]);
        if (cancelled) return;
        setSummary(s);
        setTimeline(t);
        setError(null);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load statistics');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [params]);

  useEffect(() => {
    if (!params) return;
    let cancelled = false;
    if (tab === 'reliability' && !reliability) {
      getStatsReliability(params)
        .then((d) => !cancelled && setReliability(d))
        .catch(() => undefined);
    }
    if (tab === 'quality' && !quality) {
      getStatsQuality(params)
        .then((d) => !cancelled && setQuality(d))
        .catch(() => undefined);
    }
    if (tab === 'estimates' && !estimates) {
      getStatsEstimates(params)
        .then((d) => !cancelled && setEstimates(d))
        .catch(() => undefined);
    }
    if (tab === 'plan' && !plan) {
      getStatsPlan(params)
        .then((d) => !cancelled && setPlan(d))
        .catch(() => undefined);
    }
    if (tab === 'time' && !taskTime) {
      getStatsTaskTime(params)
        .then((d) => !cancelled && setTaskTime(d))
        .catch(() => undefined);
    }
    if (tab === 'steps' && !steps) {
      getStatsSteps(params)
        .then((d) => !cancelled && setSteps(d))
        .catch(() => undefined);
    }
    return () => {
      cancelled = true;
    };
  }, [tab, params, reliability, quality, estimates, plan, taskTime, steps]);

  // A filter change invalidates the lazily-loaded tabs, or switching back would show the
  // previous window's numbers under the new filter's heading.
  useEffect(() => {
    setReliability(null);
    setQuality(null);
    setEstimates(null);
    setPlan(null);
    setTaskTime(null);
    setSteps(null);
  }, [params]);

  const cd = summary?.costDisplay ?? null;
  const money = (usd: number) => (cd ? formatCost(usd, cd) : `$${usd.toFixed(2)}`);

  /** Every drill-through carries the same window and class the chart was built from, so the
   *  task list shows exactly the rows behind the figure. */
  const drillHref = (extra: Record<string, string> = {}) => {
    // Before the client clock is anchored the window is unknown, so the link points at the
    // unfiltered list rather than at a window the server and client would disagree about.
    if (!range) return '/tasks';
    const p = new URLSearchParams({
      from: new Date(range.fromMs).toISOString(),
      to: new Date(range.toMs).toISOString(),
      // The listing's URL name, NOT the API's `includeChats`: the tasks page reads `showChats`
      // and translates it. Sending the API name looks right and silently drops plan chats from
      // the list, so the drill-through would show fewer rows than the figure it came from.
      showChats: '1',
      ...(repositoryId ? { repositoryId } : {}),
      ...(taskClass ? { taskClass } : {}),
      ...extra,
    });
    return `/tasks?${p.toString()}`;
  };

  /** A drill-through narrowed to the single local day a heat cell stands for.
   *
   *  Falls back to the window-wide link when the zone is not resolved yet or the key is
   *  malformed — a link to the right rows for a wider window is honest; one built from a
   *  fabricated day boundary is not. */
  const dayDrillHref = (bucket: string) => {
    const day = timeZone ? localDayRange(bucket, timeZone) : null;
    if (!day) return drillHref();
    return drillHref({
      from: new Date(day.fromMs).toISOString(),
      to: new Date(day.toMs).toISOString(),
    });
  };

  // Built from the resolved zone, so this never reads Intl during a server render either.
  const zones = useMemo(() => (timeZone ? [...new Set([timeZone, 'UTC'])] : ['UTC']), [timeZone]);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold text-neutral-50">Statistics</h1>
        <p className="text-sm text-neutral-400">
          Every figure is scoped to the window and filters below. Ratios built from too few
          observations show their sample count instead of a percentage.
        </p>
      </div>

      <Card className="flex flex-col gap-3 py-4">
        <div className="flex flex-wrap items-center gap-2">
          {RANGE_PRESETS.map((p) => {
            const active = p.id === preset;
            const redundant = presetIsRedundant(p.id, null, Date.now());
            return (
              <button
                key={p.id}
                type="button"
                title={p.title}
                onClick={() => setParam('preset', p.id)}
                className={`rounded-md px-3 py-1.5 text-sm transition-colors ${
                  active
                    ? 'bg-indigo-950/60 text-indigo-200'
                    : 'text-neutral-300 hover:bg-neutral-900 hover:text-neutral-100'
                } ${redundant ? 'opacity-60' : ''}`}
              >
                {p.label}
              </button>
            );
          })}
        </div>

        {preset === 'custom' && (
          <div className="flex flex-wrap items-center gap-2">
            <Input
              type="datetime-local"
              className="h-9 w-auto"
              value={customFrom || (range ? toDatetimeLocal(range.fromMs) : '')}
              onChange={(e) => setParam('from', e.target.value)}
            />
            <span className="text-sm text-neutral-500">to</span>
            <Input
              type="datetime-local"
              className="h-9 w-auto"
              value={customTo || (range ? toDatetimeLocal(range.toMs) : '')}
              onChange={(e) => setParam('to', e.target.value)}
            />
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <select
            name="repositoryId"
            aria-label="Repository"
            className={SELECT_CLASS}
            value={repositoryId}
            onChange={(e) => setParam('repositoryId', e.target.value)}
          >
            <option value="">All repositories</option>
            {repos.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
          <select
            name="taskClass"
            aria-label="Task class"
            className={SELECT_CLASS}
            value={taskClass}
            onChange={(e) => setParam('taskClass', e.target.value)}
          >
            {TASK_CLASS_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <select
            name="timeZone"
            aria-label="Time zone for day buckets"
            className={SELECT_CLASS}
            value={timeZone ?? 'UTC'}
            title="Day buckets are cut on this zone's calendar"
            onChange={(e) => {
              setTimeZone(e.target.value);
              persistTimeZone(e.target.value);
            }}
          >
            {zones.map((z) => (
              <option key={z} value={z}>
                {z}
              </option>
            ))}
          </select>
          <Link href={drillHref()} className="text-sm text-indigo-400 underline">
            Open these tasks
          </Link>
        </div>
      </Card>

      {error && (
        <div className="rounded-md border border-red-900 bg-red-950/40 px-3 py-2 text-sm text-red-300">
          {error}
        </div>
      )}

      <div className="flex flex-wrap gap-1 border-b border-neutral-800">
        {TABS.map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setParam('tab', t)}
            className={`-mb-px border-b-2 px-3 py-2 text-sm transition-colors ${
              t === tab
                ? 'border-indigo-500 text-indigo-200'
                : 'border-transparent text-neutral-400 hover:text-neutral-200'
            }`}
          >
            {TAB_LABELS[t]}
          </button>
        ))}
      </div>

      {loading && !summary && <div className="text-sm text-neutral-500">Loading...</div>}

      {summary && tab === 'money' && (
        <>
          <Card>
            <CardHeader>
              <CardTitle>Spend and savings</CardTitle>
              <CardDescription>
                Real spend is what was billed per token. The counterfactual is what the same work
                would have cost at list API rates — money saved by a flat plan, never money spent,
                and never added to the first figure.
              </CardDescription>
            </CardHeader>
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              <StatTile
                label="Spent"
                value={money(summary.spend.realUsd)}
                delta={summary.spend.realDelta}
                moreIsBetter={false}
                tone="text-emerald-300"
              />
              <StatTile
                label="Saved by plan"
                value={money(summary.spend.notionalUsd)}
                hint="at list API rates"
                delta={summary.spend.notionalDelta}
                tone="text-neutral-400"
              />
              <StatTile
                label="Unpriced"
                value={formatCount(summary.spend.unpricedInvocations)}
                hint="excluded from both figures"
                tone={summary.spend.unpricedInvocations > 0 ? 'text-amber-300' : 'text-neutral-400'}
              />
              <StatTile
                label="Tokens"
                value={formatTokens(summary.tokens.totalTokens)}
                hint={`${formatPercent(summary.tokens.cacheHitRatio)} cached`}
                tone="text-sky-300"
              />
            </div>
            <div className="mt-6">
              <SpendChart days={timeline?.days ?? []} costDisplay={summary.costDisplay} />
            </div>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Token mix</CardTitle>
              <CardDescription>
                What the tokens in this window actually were. Cache reads dominate on any install
                that reuses a prompt, and they are billed at a fraction of fresh input — so the
                single &quot;Tokens&quot; figure above says much less about cost than this split
                does. Normalised before the buckets are added: codex and gemini report input
                inclusive of the cached prefix, the rest exclusive. These shares are of all four
                buckets, so the cache-read share here is lower than the &quot;cached&quot; figure
                above, which is of the prompt side alone.
              </CardDescription>
            </CardHeader>
            <StackedShareBar
              segments={[
                {
                  key: 'cacheRead',
                  label: 'Cache read',
                  value: summary.tokens.cacheReadTokens,
                  color: TOKEN_COLORS.cacheRead,
                },
                {
                  key: 'freshInput',
                  label: 'Fresh input',
                  value: summary.tokens.freshInputTokens,
                  color: TOKEN_COLORS.freshInput,
                },
                {
                  key: 'cacheCreation',
                  label: 'Cache write',
                  value: summary.tokens.cacheCreationTokens,
                  color: TOKEN_COLORS.cacheCreation,
                },
                {
                  key: 'output',
                  label: 'Output',
                  value: summary.tokens.outputTokens,
                  color: TOKEN_COLORS.output,
                },
              ]}
              formatValue={formatTokens}
              emptyMessage="No tokens recorded in this window."
            />
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>By provider</CardTitle>
              <CardDescription>
                Token totals are normalised before providers are compared: codex and gemini report
                input inclusive of the cached prefix, the rest exclusive.
              </CardDescription>
            </CardHeader>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs uppercase tracking-wider text-neutral-500">
                    <th className="pb-2 font-medium">Provider</th>
                    <th className="pb-2 text-right font-medium">Runs</th>
                    <th className="pb-2 text-right font-medium">Spent</th>
                    <th className="pb-2 text-right font-medium">Saved</th>
                    <th className="pb-2 text-right font-medium">Unpriced</th>
                  </tr>
                </thead>
                <tbody>
                  {summary.spend.byProvider.map((p) => (
                    <tr key={p.provider} className="border-t border-neutral-800">
                      <td className="py-2 text-neutral-200">{p.provider}</td>
                      <td className="py-2 text-right font-mono text-neutral-300">
                        {formatCount(p.invocations)}
                      </td>
                      <td className="py-2 text-right font-mono text-emerald-300">
                        {money(p.costUsd)}
                      </td>
                      <td className="py-2 text-right font-mono text-neutral-400">
                        {money(p.notionalCostUsd)}
                      </td>
                      <td className="py-2 text-right font-mono text-amber-300">
                        {p.unpricedInvocations || ''}
                      </td>
                    </tr>
                  ))}
                  {summary.spend.byProvider.length === 0 && (
                    <tr className="border-t border-neutral-800">
                      <td colSpan={5} className="py-6 text-center text-neutral-500">
                        No invocations in this window.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      )}

      {summary && tab === 'time' && (
        <>
          <Card>
            <CardHeader>
              <CardTitle>Activity</CardTitle>
              <CardDescription>
                One square per day, cut on the calendar of the zone selected above. Shading is by
                quartile of the days on which anything ran, so a single long day cannot flatten the
                rest of the week against it. Hovering reports every metric, not just the shaded one.
              </CardDescription>
            </CardHeader>
            <ActivityHeatmap
              days={timeline?.days ?? []}
              metric={heatMetric}
              onMetricChange={(m) => setParam('heat', m === 'agent' ? '' : m)}
              money={money}
              dayHref={dayDrillHref}
            />
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Effort and concurrency</CardTitle>
              <CardDescription>
                Agent-hours counts concurrent agents separately; busy span is the clock during which
                at least one ran. Effort is agent work plus your own focused time, and can only be
                attributed to the tasks that FINISHED in this window — it carries no timestamps of
                its own, so it cannot be charted per day.
              </CardDescription>
            </CardHeader>
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
              <StatTile
                label="Agent-hours"
                value={formatAgentHours(summary.time.agentMs)}
                delta={summary.time.agentDelta}
                tone="text-indigo-300"
              />
              <StatTile
                label="Busy span"
                value={formatDuration(summary.time.busyMs)}
                hint={`${formatCount(summary.time.islands)} runs`}
              />
              <StatTile
                label="Concurrency"
                value={formatConcurrency(summary.time.concurrency)}
                tone="text-indigo-300"
              />
              <StatTile label="Duty cycle" value={formatPercent(summary.time.dutyCycle)} />
              <StatTile
                label="Work"
                value={formatDuration(summary.time.workMs)}
                tone="text-indigo-300"
              />
              <StatTile
                label="Waiting on you"
                value={formatDuration(summary.time.idleMs)}
                hint={`${formatDuration(summary.time.userActiveMs)} active`}
                tone="text-amber-300"
              />
            </div>
            <div className="mt-6">
              <ActivityChart days={timeline?.days ?? []} />
            </div>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Abandoned work</CardTitle>
              <CardDescription>Tasks that ended failed or cancelled.</CardDescription>
            </CardHeader>
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              <StatTile
                label="Abandoned"
                value={formatCount(summary.tasks.startedAbandoned)}
                hint={`of ${formatCount(summary.tasks.started)} started`}
                tone="text-amber-300"
              />
              <StatTile
                label="Share"
                value={formatSampledRatio(summary.tasks.abandonedRatio)}
                underSampledNote={isUnderSampled(summary.tasks.abandonedRatio) ? 'too few' : null}
                tone="text-amber-300"
              />
              <StatTile
                label="Agent-hours lost"
                value={formatAgentHours(summary.time.abandonedAgentMs)}
                tone="text-amber-300"
              />
              <StatTile
                label="Value lost"
                value={money(summary.spend.abandonedNotionalUsd + summary.spend.abandonedRealUsd)}
                tone="text-amber-300"
              />
            </div>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Per task</CardTitle>
              <CardDescription>
                Where this window&apos;s agent time went, ranked by agent-hours. Agent-hours add up
                to the tile above exactly; busy spans do not, and are not meant to — two tasks
                running the same minute each own that minute, while the window owns it once. A task
                is listed when an agent ran for it in this window; deterministic step work carries
                no CLI invocation and is outside the span.
              </CardDescription>
            </CardHeader>
            {!taskTime ? (
              <div className="text-sm text-neutral-500">Loading...</div>
            ) : taskTime.taskCount === 0 ? (
              <p className="text-sm text-neutral-500">No agent ran for any task in this window.</p>
            ) : (
              <>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-xs uppercase tracking-wider text-neutral-500">
                        <th className="pb-2 font-medium">Task</th>
                        <th className="pb-2 font-medium">Repository</th>
                        <th className="pb-2 font-medium">Class</th>
                        <th className="pb-2 font-medium">Status</th>
                        <th className="pb-2 text-right font-medium">Runs</th>
                        <th className="pb-2 text-right font-medium">Agent-hours</th>
                        <th className="pb-2 text-right font-medium">Busy span</th>
                        <th className="pb-2 text-right font-medium">Concurrency</th>
                        <th className="pb-2 text-right font-medium">Calendar span</th>
                      </tr>
                    </thead>
                    <tbody>
                      {taskTime.rows.map((r) => (
                        <tr key={r.taskId} className="border-t border-neutral-800">
                          <td className="py-2">
                            <Link
                              href={`/tasks/${r.taskId}`}
                              title={r.title ?? r.taskId}
                              className="block max-w-[22rem] truncate text-neutral-200 hover:text-indigo-300"
                            >
                              {r.title ?? r.taskId}
                            </Link>
                          </td>
                          <td className="py-2 text-neutral-400">{r.repositoryName ?? '—'}</td>
                          <td className="py-2 text-neutral-400">
                            {r.taskClass === null
                              ? '—'
                              : (TASK_CLASS_LABELS.get(r.taskClass) ?? r.taskClass)}
                          </td>
                          <td
                            className={`py-2 ${
                              ABANDONED_TASK_STATUSES.has(r.status ?? '')
                                ? 'text-amber-400'
                                : 'text-neutral-400'
                            }`}
                          >
                            {r.status === null ? '—' : r.status.replace(/_/g, ' ')}
                          </td>
                          <td className="py-2 text-right font-mono text-neutral-400">
                            {formatCount(r.invocations)}
                          </td>
                          <td className="py-2 text-right font-mono text-indigo-300">
                            {formatAgentHours(r.agentMs)}
                            {/* The rows are already ranked by this column, so the bar is a scan
                                aid for the SHAPE of the ranking — where it falls off — not a
                                second ordering. Scaled against the top row, which is the first
                                one, so the eye has a fixed reference. */}
                            <InlineBar
                              value={r.agentMs}
                              max={taskTime.rows[0]?.agentMs ?? 0}
                              color={CHART_COLORS.agent}
                            />
                          </td>
                          <td className="py-2 text-right font-mono text-neutral-200">
                            {formatDuration(r.busyMs)}
                          </td>
                          <td className="py-2 text-right font-mono text-neutral-400">
                            {formatConcurrency(r.concurrency)}
                          </td>
                          <td className="py-2 text-right font-mono text-neutral-400">
                            {formatDuration(r.calendarMs)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {taskTime.truncated && (
                  <p className="mt-3 text-xs text-neutral-500">
                    Showing the {formatCount(taskTime.rows.length)} tasks with the most agent-hours,
                    of {formatCount(taskTime.taskCount)} — the rows shown do not add up to the
                    window total.
                  </p>
                )}
              </>
            )}
          </Card>
        </>
      )}

      {tab === 'steps' && (
        <>
          {!steps ? (
            <div className="text-sm text-neutral-500">Loading...</div>
          ) : (
            <>
              <Card>
                <CardHeader>
                  <CardTitle>Where the time goes</CardTitle>
                  <CardDescription>
                    Agent-hours and spend per step of the engine, over the same window and filters
                    as every other tab. Spend that a step&apos;s summary pass incurred is folded in
                    with the step&apos;s own, so these figures reconcile with the per-step badges on
                    a task page. Agent-hours are SUMMED here and never unioned — two steps running
                    the same minute each own that minute, so these do not describe elapsed time.
                  </CardDescription>
                </CardHeader>
                {steps.rows.length === 0 ? (
                  <p className="text-sm text-neutral-500">No steps ran in this window.</p>
                ) : (
                  <>
                    <RankedBars
                      rows={steps.rows.map((r) => ({
                        key: r.stepId,
                        value: r.agentMs,
                        hint: `· ${formatCount(r.invocations)} runs`,
                      }))}
                      formatValue={formatAgentHours}
                      color={CHART_COLORS.agent}
                      limit={12}
                      elisionNote={(n) => `+${n.toLocaleString()} more in the table below`}
                    />
                    <div className="mt-6 overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="text-left text-xs uppercase tracking-wider text-neutral-500">
                            <th className="pb-2 font-medium">Step</th>
                            <th className="pb-2 text-right font-medium">Runs</th>
                            <th className="pb-2 text-right font-medium">Tasks</th>
                            <th className="pb-2 text-right font-medium">Agent-hours</th>
                            <th className="pb-2 text-right font-medium">Spent</th>
                            <th className="pb-2 text-right font-medium">Saved</th>
                            <th className="pb-2 text-right font-medium">Unpriced</th>
                          </tr>
                        </thead>
                        <tbody>
                          {steps.rows.map((r) => (
                            <tr key={r.stepId} className="border-t border-neutral-800">
                              <td className="py-2 font-mono text-xs text-neutral-200">
                                {r.stepId}
                              </td>
                              <td className="py-2 text-right font-mono text-neutral-400">
                                {formatCount(r.invocations)}
                              </td>
                              <td className="py-2 text-right font-mono text-neutral-400">
                                {formatCount(r.taskCount)}
                              </td>
                              <td className="py-2 text-right font-mono text-indigo-300">
                                {formatAgentHours(r.agentMs)}
                              </td>
                              <td className="py-2 text-right font-mono text-emerald-300">
                                {money(r.realUsd)}
                              </td>
                              <td className="py-2 text-right font-mono text-neutral-400">
                                {money(r.notionalUsd)}
                              </td>
                              <td className="py-2 text-right font-mono text-amber-300">
                                {r.unpricedInvocations || ''}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    {steps.truncated && (
                      <p className="mt-3 text-xs text-neutral-500">
                        Showing the {formatCount(steps.rows.length)} steps with the most
                        agent-hours, of {formatCount(steps.stepCount)} — the rows shown do not add
                        up to the window total.
                      </p>
                    )}
                  </>
                )}
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>Models that answered</CardTitle>
                  <CardDescription>
                    Which model actually replied, parsed from each CLI&apos;s own output rather than
                    from what was configured — an endpoint can serve a different model with no
                    config change here. Not every CLI reports one: codex and amp name no model at
                    all, so their runs are counted as not recorded rather than as a model or as a
                    zero.
                  </CardDescription>
                </CardHeader>
                {steps.models.length === 0 ? (
                  <p className="text-sm text-neutral-500">No invocations in this window.</p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-left text-xs uppercase tracking-wider text-neutral-500">
                          <th className="pb-2 font-medium">Model</th>
                          <th className="pb-2 text-right font-medium">Runs</th>
                          <th className="pb-2 text-right font-medium">Agent-hours</th>
                          <th className="pb-2 text-right font-medium">Differed from asked</th>
                        </tr>
                      </thead>
                      <tbody>
                        {steps.models.map((m) => (
                          <tr
                            key={m.served ?? '(not recorded)'}
                            className="border-t border-neutral-800"
                          >
                            <td className="py-2 font-mono text-xs">
                              {m.served === null ? (
                                <span className="text-neutral-500">not recorded</span>
                              ) : (
                                <span className="text-neutral-200">{m.served}</span>
                              )}
                            </td>
                            <td className="py-2 text-right font-mono text-neutral-400">
                              {formatCount(m.invocations)}
                            </td>
                            <td className="py-2 text-right font-mono text-indigo-300">
                              {formatAgentHours(m.agentMs)}
                            </td>
                            <td
                              className={`py-2 text-right font-mono ${
                                m.differs > 0 ? 'text-amber-300' : 'text-neutral-600'
                              }`}
                            >
                              {m.differs || ''}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Card>
            </>
          )}
        </>
      )}

      {tab === 'plan' && (
        <Card>
          <CardHeader>
            <CardTitle>Plan progress and velocity</CardTitle>
            <CardDescription>
              Two different questions. <span className="text-neutral-300">Progress</span> is how
              much of the plan already exists — a <code className="text-xs">from_repo</code> plan
              starts partly complete because its nodes describe code that is already written.
              <span className="text-neutral-300"> Velocity</span> counts only nodes that
              transitioned to done inside this window, so a node created already done contributes to
              the first and not the second.
            </CardDescription>
          </CardHeader>
          {!plan ? (
            <div className="text-sm text-neutral-500">Loading...</div>
          ) : plan.totals.nodes === 0 ? (
            <p className="text-sm text-neutral-500">No plan nodes for this scope.</p>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
                <StatTile
                  label="Nodes"
                  value={formatCount(plan.totals.nodes)}
                  hint={`${formatCount(plan.totals.taskable)} taskable`}
                />
                <StatTile
                  label="Progress"
                  value={formatSampledRatio(plan.totals.progressRatio)}
                  hint={`${formatCount(plan.totals.settled)} settled`}
                  tone="text-emerald-300"
                />
                <StatTile
                  label="Remaining"
                  value={formatCount(plan.totals.remaining)}
                  tone="text-neutral-200"
                />
                <StatTile
                  label="Completed"
                  value={formatCount(plan.velocity.completedInWindow)}
                  hint="in this window"
                  tone="text-emerald-300"
                />
                <StatTile
                  label="Per week"
                  value={plan.velocity.perWeek.toFixed(1)}
                  tone="text-emerald-300"
                />
                <StatTile
                  label="Time left"
                  value={formatProjection(plan.velocity.projectedWeeksRemaining)}
                  hint="at this window's rate"
                />
              </div>

              {plan.coverage.doneUndated > 0 && (
                // Said out loud rather than folded into the velocity number: a zero here can
                // mean "nothing was finished" or "nothing was dated", and those are different.
                <p className="mt-4 text-[11px] text-amber-400">
                  {formatCount(plan.coverage.doneUndated)} of {formatCount(plan.coverage.doneTotal)}{' '}
                  done nodes carry no completion date — they were created already done (describing
                  existing code), greened before this was recorded, or restored from a committed
                  plan snapshot. They count toward progress and not toward velocity.
                </p>
              )}

              <div className="mt-6">
                <PlanVelocityChart days={plan.velocity.days} />
              </div>

              <div className="mt-6 overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs uppercase tracking-wider text-neutral-500">
                      <th className="pb-2 font-medium">Repository</th>
                      <th className="pb-2 text-right font-medium">Nodes</th>
                      <th className="pb-2 text-right font-medium">Taskable</th>
                      <th className="pb-2 text-right font-medium">Done</th>
                      <th className="pb-2 text-right font-medium">To do</th>
                      <th className="pb-2 text-right font-medium">Blocked</th>
                    </tr>
                  </thead>
                  <tbody>
                    {plan.repositories.map((r) => (
                      <tr key={r.repositoryId} className="border-t border-neutral-800">
                        <td className="py-2">
                          <Link
                            href={`/repos/${r.repositoryId}/plan`}
                            className="text-neutral-200 hover:text-indigo-300"
                          >
                            {r.name}
                          </Link>
                        </td>
                        <td className="py-2 text-right font-mono text-neutral-300">
                          {formatCount(r.total)}
                        </td>
                        <td className="py-2 text-right font-mono text-neutral-400">
                          {formatCount(r.taskable)}
                        </td>
                        <td className="py-2 text-right font-mono text-emerald-300">
                          {r.byStatus['done'] ?? 0}
                        </td>
                        <td className="py-2 text-right font-mono text-neutral-300">
                          {r.byStatus['todo'] ?? 0}
                        </td>
                        <td className="py-2 text-right font-mono text-amber-300">
                          {r.byStatus['blocked_human'] ?? 0}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </Card>
      )}

      {tab === 'reliability' && (
        <Card>
          <CardHeader>
            <CardTitle>Reliability</CardTitle>
            <CardDescription>
              Where time was wasted. Superseded runs are work that was re-rolled and thrown away; a
              killed run ended with no exit code at all. These two counts deliberately include rows
              the other tabs filter out, because those rows ARE the waste.
            </CardDescription>
          </CardHeader>
          {!reliability ? (
            <div className="text-sm text-neutral-500">Loading...</div>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
                <StatTile
                  label="Runs"
                  value={formatCount(reliability.invocations.total)}
                  hint="including superseded"
                />
                <StatTile
                  label="Superseded"
                  value={formatSampledRatio(reliability.invocations.supersededRatio)}
                  hint={`${formatCount(reliability.invocations.superseded)} runs`}
                  underSampledNote={
                    isUnderSampled(reliability.invocations.supersededRatio) ? 'too few' : null
                  }
                  tone="text-amber-300"
                />
                <StatTile
                  label="Killed"
                  value={formatCount(reliability.invocations.killed)}
                  hint="no exit code"
                  tone="text-amber-300"
                />
                <StatTile
                  label="Non-zero exit"
                  value={formatCount(reliability.invocations.nonZeroExit)}
                  tone="text-amber-300"
                />
                <StatTile
                  label="Near timeout"
                  value={formatCount(reliability.invocations.nearTimeout)}
                  hint={`of ${formatCount(reliability.invocations.withTimeout)} budgeted`}
                />
                <StatTile
                  label="Model mismatch"
                  value={formatCount(reliability.invocations.identityDiffers)}
                  hint={`of ${formatCount(reliability.invocations.identityKnown)} reported`}
                />
              </div>

              <div className="mt-6 grid gap-6 lg:grid-cols-2">
                <div>
                  <p className="mb-2 text-xs uppercase tracking-wider text-neutral-500">
                    Provider failures
                  </p>
                  {reliability.fatalClasses.length === 0 ? (
                    <p className="text-sm text-neutral-500">No provider failures recorded.</p>
                  ) : (
                    <table className="w-full text-sm">
                      <tbody>
                        {reliability.fatalClasses.map((f) => (
                          <tr
                            key={`${f.provider}:${f.fatalClass}`}
                            className="border-t border-neutral-800"
                          >
                            <td className="py-2 text-neutral-200">{f.provider}</td>
                            <td className="py-2 text-neutral-400">{f.fatalClass}</td>
                            <td className="py-2 text-right font-mono text-amber-300">{f.count}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
                <div>
                  <p className="mb-2 text-xs uppercase tracking-wider text-neutral-500">
                    Most-failed steps
                  </p>
                  <RankedBars
                    rows={reliability.steps.topFailing.map((s) => ({
                      key: s.stepId,
                      value: s.count,
                    }))}
                    color={CHART_COLORS.idle}
                    emptyMessage="No step failures in this window."
                  />
                </div>
              </div>

              <div className="mt-6 flex flex-wrap gap-x-6 gap-y-2 text-xs text-neutral-500">
                <span>Steps: {formatCount(reliability.steps.total)}</span>
                <span>Failed: {formatCount(reliability.steps.failed)}</span>
                <span>Degraded output: {formatCount(reliability.steps.degraded)}</span>
                {Object.entries(reliability.events).map(([k, v]) => (
                  <span key={k}>
                    {k}: {formatCount(v)}
                  </span>
                ))}
              </div>
            </>
          )}
        </Card>
      )}

      {tab === 'quality' && (
        <Card>
          <CardHeader>
            <CardTitle>Review findings</CardTitle>
            <CardDescription>{quality?.caveat ?? 'What the reviewers raised.'}</CardDescription>
          </CardHeader>
          {!quality ? (
            <div className="text-sm text-neutral-500">Loading...</div>
          ) : quality.totals.findings === 0 ? (
            <p className="text-sm text-neutral-500">
              No review findings were recorded in this window.
            </p>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                <StatTile label="Findings" value={formatCount(quality.totals.findings)} />
                <StatTile
                  label="Blocking"
                  value={formatCount(quality.totals.blocking)}
                  tone="text-amber-300"
                />
                <StatTile
                  label="Recurring"
                  value={formatSampledRatio(quality.totals.recurringRatio)}
                  hint={`${formatCount(quality.totals.recurring)} findings`}
                  underSampledNote={
                    isUnderSampled(quality.totals.recurringRatio) ? 'too few' : null
                  }
                />
                <StatTile
                  label="Tasks affected"
                  value={formatCount(quality.totals.tasksWithFindings)}
                />
              </div>

              <div className="mt-6 grid gap-6 lg:grid-cols-3">
                <div>
                  <p className="mb-2 text-xs uppercase tracking-wider text-neutral-500">
                    By severity
                  </p>
                  <RankedBars
                    rows={[...quality.bySeverity]
                      .sort((a, b) => (SEVERITY_RANK[a.key] ?? 99) - (SEVERITY_RANK[b.key] ?? 99))
                      .map((r) => ({ key: r.key, value: r.count }))}
                    order="given"
                    color={(row) => SEVERITY_COLOR[row.key] ?? CHART_COLORS.notional}
                    emptyMessage="No findings in this window."
                  />
                </div>
                {(
                  [
                    ['By disposition', quality.byDisposition],
                    ['By dimension', quality.byDimension],
                  ] as const
                ).map(([title, rows]) => (
                  <div key={title}>
                    <p className="mb-2 text-xs uppercase tracking-wider text-neutral-500">
                      {title}
                    </p>
                    <RankedBars
                      rows={rows.map((r) => ({ key: r.key, value: r.count }))}
                      color={CHART_COLORS.work}
                      emptyMessage="No findings in this window."
                    />
                  </div>
                ))}
              </div>

              <div className="mt-6">
                <p className="mb-2 text-xs uppercase tracking-wider text-neutral-500">
                  By reviewer — a high refuted share is reviewer noise, not defects found
                </p>
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs uppercase tracking-wider text-neutral-500">
                      <th className="pb-2 font-medium">Reviewer</th>
                      <th className="pb-2 text-right font-medium">Raised</th>
                      <th className="pb-2 text-right font-medium">Blocking</th>
                      <th className="pb-2 text-right font-medium">Refuted</th>
                    </tr>
                  </thead>
                  <tbody>
                    {quality.byReviewer.map((r) => (
                      <tr key={r.reviewerId} className="border-t border-neutral-800">
                        <td className="py-2 font-mono text-xs text-neutral-200">{r.reviewerId}</td>
                        <td className="py-2 text-right font-mono text-neutral-300">{r.count}</td>
                        <td className="py-2 text-right font-mono text-amber-300">{r.blocking}</td>
                        <td className="py-2 text-right font-mono text-neutral-400">
                          {formatSampledRatio(r.refutedRatio)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </Card>
      )}

      {tab === 'estimates' && (
        <Card>
          <CardHeader>
            <CardTitle>Estimate accuracy</CardTitle>
            <CardDescription>
              The AI&apos;s own estimate against measured effort, for tasks that completed in this
              window. Uses the same aggregator as the per-repository estimates page.
            </CardDescription>
          </CardHeader>
          {!estimates ? (
            <div className="text-sm text-neutral-500">Loading...</div>
          ) : estimates.summary.taskCount === 0 ? (
            <p className="text-sm text-neutral-500">
              No completed task in this window carries an AI estimate.
            </p>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                <StatTile label="Tasks" value={formatCount(estimates.summary.taskCount)} />
                <StatTile
                  label="MAPE"
                  value={`${estimates.summary.mapePct.toFixed(0)}%`}
                  hint="mean absolute error"
                  underSampledNote={estimates.summary.taskCount < 5 ? 'too few' : null}
                />
                <StatTile
                  label="Bias"
                  value={
                    estimates.summary.medianBiasFactor == null
                      ? '—'
                      : `${estimates.summary.medianBiasFactor.toFixed(2)}×`
                  }
                  hint="median actual / estimate"
                />
                <StatTile
                  label="Under / over"
                  value={`${estimates.summary.underestimateCount} / ${estimates.summary.overestimateCount}`}
                />
              </div>
              <div className="mt-6 overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs uppercase tracking-wider text-neutral-500">
                      <th className="pb-2 font-medium">Task</th>
                      <th className="pb-2 text-right font-medium">AI</th>
                      <th className="pb-2 text-right font-medium">Yours</th>
                      <th className="pb-2 text-right font-medium">Actual</th>
                      <th className="pb-2 text-right font-medium">Error</th>
                    </tr>
                  </thead>
                  <tbody>
                    {estimates.rows.map((r) => (
                      <tr key={r.taskId} className="border-t border-neutral-800">
                        <td className="py-2">
                          <Link
                            href={`/tasks/${r.taskId}`}
                            className="text-neutral-200 hover:text-indigo-300"
                          >
                            {r.title}
                          </Link>
                        </td>
                        <td className="py-2 text-right font-mono text-neutral-400">
                          {r.aiEstimatedHours.toFixed(2)}h
                        </td>
                        <td className="py-2 text-right font-mono text-neutral-400">
                          {r.confirmedHours == null ? '—' : `${r.confirmedHours.toFixed(2)}h`}
                        </td>
                        <td className="py-2 text-right font-mono text-neutral-200">
                          {r.actualHours.toFixed(2)}h
                        </td>
                        <td
                          className={`py-2 text-right font-mono ${
                            r.absErrorPct > 50 ? 'text-amber-400' : 'text-neutral-400'
                          }`}
                        >
                          {r.signedErrorPct > 0 ? '+' : ''}
                          {r.signedErrorPct.toFixed(0)}%
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </Card>
      )}
    </div>
  );
}
