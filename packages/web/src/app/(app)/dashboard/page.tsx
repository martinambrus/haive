'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import dynamic from 'next/dynamic';
import {
  api,
  getStatsSummary,
  getStatsTimeline,
  type StatsSummary,
  type StatsTimeline,
  type Task,
} from '@/lib/api-client';
import { Button, Card, CardDescription, CardHeader, CardTitle } from '@/components/ui';
import { StatTile } from '@/components/stats/stat-tile';
import { ActivityHeatmap } from '@/components/stats/activity-heatmap';
import { usePageTitle } from '@/lib/use-page-title';
import { formatDuration } from '@/lib/format-duration';
import { formatCost } from '@/lib/format-cost';
import { formatTokens } from '@/lib/format-tokens';
import { rememberTaskOrigin } from '@/lib/task-origin';
import {
  formatAgentHours,
  formatConcurrency,
  formatCount,
  formatPercent,
  formatSampledRatio,
  isUnderSampled,
} from '@/lib/stats/format-stats';
import { localDayRange, type HeatMetric } from '@/lib/stats/heat-scale';

// recharts is a ~7 MB package with a redux/d3 transitive tree. Nothing about it belongs in
// the server render or the initial client bundle, so both charts load on demand. First use of
// next/dynamic in this package — see the note in components/stats/charts.tsx.
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

/** Statuses the listing's `active` token covers — what is running right now. */
const ACTIVE_TOKEN = 'active';

export default function DashboardPage() {
  usePageTitle('Dashboard');

  const [summary, setSummary] = useState<StatsSummary | null>(null);
  const [timeline, setTimeline] = useState<StatsTimeline | null>(null);
  const [active, setActive] = useState<Task[] | null>(null);
  // Kept from the fetch effect so the heatmap can turn a day back into an instant range for
  // its drill-through. Null until the client resolves it, for the same reason the effect
  // resolves it there rather than during render.
  const [timeZone, setTimeZone] = useState<string | null>(null);
  const [heatMetric, setHeatMetric] = useState<HeatMetric>('agent');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // The viewer's own zone, so day buckets line up with their calendar rather than UTC.
      // MEASURED on this install: that moves 5-10% of rows between adjacent days.
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
      setTimeZone(tz);
      try {
        const [s, t] = await Promise.all([getStatsSummary({ tz }), getStatsTimeline({ tz })]);
        if (cancelled) return;
        setSummary(s);
        setTimeline(t);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load statistics');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // The now-strip reuses the task listing rather than duplicating its status vocabulary.
  // Its own fetch: a failure here must not blank the statistics.
  useEffect(() => {
    let cancelled = false;
    api
      .get<{ tasks: Task[] }>(`/tasks?status=${ACTIVE_TOKEN}&pageSize=5`)
      .then((res) => {
        if (!cancelled) setActive(res.tasks);
      })
      .catch(() => {
        if (!cancelled) setActive([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const cd = summary?.costDisplay ?? null;
  const money = (usd: number) => (cd ? formatCost(usd, cd) : `$${usd.toFixed(2)}`);

  /** A heat cell opens the tasks that ran on that day. `showChats` is the LISTING's parameter
   *  name, not the API's `includeChats` — sending the API name silently drops plan chats, so
   *  the list would show fewer rows than the square that was clicked. */
  const dayHref = (bucket: string) => {
    const day = timeZone ? localDayRange(bucket, timeZone) : null;
    if (!day) return '/tasks';
    const p = new URLSearchParams({
      from: new Date(day.fromMs).toISOString(),
      to: new Date(day.toMs).toISOString(),
      showChats: '1',
    });
    return `/tasks?${p.toString()}`;
  };

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold text-neutral-50">Dashboard</h1>
        <p className="text-sm text-neutral-400">
          The last 30 days. Every figure compares against the 30 days before it.{' '}
          <Link href="/stats" className="text-indigo-400 underline">
            Filter and explore
          </Link>
          .
        </p>
      </div>

      {error && (
        <div className="rounded-md border border-red-900 bg-red-950/40 px-3 py-2 text-sm text-red-300">
          {error}
        </div>
      )}

      {/* What is running right now. A dashboard with no now-state is a report. */}
      <Card>
        <CardHeader>
          <CardTitle>Running now</CardTitle>
          <CardDescription>
            {active === null
              ? 'Checking...'
              : active.length === 0
                ? 'Nothing is running.'
                : `${active.length} task${active.length === 1 ? '' : 's'} in flight.`}
          </CardDescription>
        </CardHeader>
        {active && active.length > 0 && (
          <ul className="flex flex-col gap-1">
            {active.map((t) => (
              <li key={t.id} className="flex items-center gap-2 text-sm">
                <span className="inline-block h-2 w-2 shrink-0 animate-pulse rounded-full bg-indigo-400" />
                <Link
                  href={`/tasks/${t.id}`}
                  onClick={() =>
                    rememberTaskOrigin(t.id, { href: '/dashboard', label: 'Dashboard' })
                  }
                  className="truncate text-neutral-200 hover:text-indigo-300"
                >
                  {t.title}
                </Link>
                <span className="shrink-0 text-xs text-neutral-500">{t.status}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {loading && <div className="text-sm text-neutral-500">Loading...</div>}

      {summary && (
        <>
          {/* The only pair on this page that sits side by side: WHEN the work happened next
              to WHAT it cost, which are the two questions a dashboard opens with. Everything
              below stays full width. */}
          <div className="grid gap-6 lg:grid-cols-2">
            {/* flex-col + a growing heatmap, NOT h-full: grid stretch gives the card a used
                height while its computed height stays auto, so a percentage child does not
                resolve against it and spills out of the card instead. */}
            <Card className="flex flex-col">
              <CardHeader>
                <CardTitle>Activity</CardTitle>
                <CardDescription>
                  One square per day in your own time zone, shaded by quartile of the days on which
                  anything ran — so one long day cannot flatten the rest of the month against it.
                  Hovering reports every metric; clicking opens that day&apos;s tasks.
                </CardDescription>
              </CardHeader>
              <ActivityHeatmap
                days={timeline?.days ?? []}
                metric={heatMetric}
                onMetricChange={setHeatMetric}
                money={money}
                dayHref={dayHref}
                className="flex-1"
              />
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Spend and savings</CardTitle>
                <CardDescription>
                  What ran in this window cost{' '}
                  <span className="text-emerald-300">{money(summary.spend.realUsd)}</span> in
                  metered billing. On a flat plan the per-token dollars are notional, so the second
                  figure is what the same work would have cost at list API rates — money saved,
                  never money spent.
                  {summary.spend.unpricedInvocations > 0 && (
                    <>
                      {' '}
                      <span className="text-amber-400">
                        {formatCount(summary.spend.unpricedInvocations)} invocation
                        {summary.spend.unpricedInvocations === 1 ? '' : 's'} could not be priced
                      </span>{' '}
                      and are excluded from both.
                    </>
                  )}
                </CardDescription>
              </CardHeader>
              <div className="grid grid-cols-2 gap-4">
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
                  label="Tokens"
                  value={formatTokens(summary.tokens.totalTokens)}
                  hint={`${formatPercent(summary.tokens.cacheHitRatio)} of the prompt side from cache`}
                  tone="text-sky-300"
                />
                <StatTile
                  label="Invocations"
                  value={formatCount(summary.spend.invocations)}
                  hint={`${summary.spend.byProvider.length} provider${summary.spend.byProvider.length === 1 ? '' : 's'}`}
                />
              </div>
              <div className="mt-6">
                <SpendChart days={timeline?.days ?? []} costDisplay={summary.costDisplay} />
              </div>
            </Card>
          </div>

          <Card>
            <CardHeader>
              <CardTitle>Effort and throughput</CardTitle>
              <CardDescription>
                <span className="text-indigo-300">Agent-hours</span> is compute consumed and counts
                concurrent agents separately; <span className="text-neutral-300">busy span</span> is
                the clock during which at least one agent was running. The gap between them is your
                concurrency. Effort is agent work plus your own focused time, measured over the
                tasks that finished in this window.
              </CardDescription>
            </CardHeader>
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4 lg:grid-cols-6">
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
                tone="text-neutral-200"
              />
              <StatTile
                label="Concurrency"
                value={formatConcurrency(summary.time.concurrency)}
                hint="agents at once, mean"
                tone="text-indigo-300"
              />
              <StatTile
                label="Duty cycle"
                value={formatPercent(summary.time.dutyCycle)}
                hint="of elapsed time working"
                tone="text-neutral-200"
              />
              <StatTile
                label="Effort"
                value={formatDuration(summary.time.effortMs)}
                hint={`${formatDuration(summary.time.userActiveMs)} yours`}
                delta={summary.time.effortDelta}
                tone="text-rose-300"
              />
              <StatTile
                label="Completed"
                value={formatCount(summary.tasks.completed)}
                hint={`${formatCount(summary.tasks.started)} started`}
                delta={summary.tasks.completedDelta}
                tone="text-emerald-300"
              />
            </div>
            <div className="mt-6">
              <ActivityChart days={timeline?.days ?? []} />
            </div>
          </Card>

          {/* Abandoned work. Currently invisible everywhere else in the product, and large:
              on this install it is over half of all tasks. */}
          <Card>
            <CardHeader>
              <CardTitle>Abandoned work</CardTitle>
              <CardDescription>
                Tasks that ended failed or cancelled, and what they consumed before they did.
                Nothing else in the product reports this.
              </CardDescription>
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
                hint="of tasks started"
                underSampledNote={isUnderSampled(summary.tasks.abandonedRatio) ? 'too few' : null}
                tone="text-amber-300"
              />
              <StatTile
                label="Agent-hours lost"
                value={formatAgentHours(summary.time.abandonedAgentMs)}
                hint={
                  summary.time.agentMs > 0
                    ? `${formatPercent(summary.time.abandonedAgentMs / summary.time.agentMs)} of all compute`
                    : undefined
                }
                tone="text-amber-300"
              />
              <StatTile
                label="Value lost"
                value={money(summary.spend.abandonedNotionalUsd + summary.spend.abandonedRealUsd)}
                hint="spent plus notional"
                tone="text-amber-300"
              />
            </div>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>By task class</CardTitle>
              <CardDescription>
                Tasks started in this window. Work is implementation; Plan is the plan canvas; Setup
                is onboarding, upgrades and rollbacks; Run brings an app up.
              </CardDescription>
            </CardHeader>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs uppercase tracking-wider text-neutral-500">
                    <th className="pb-2 font-medium">Class</th>
                    <th className="pb-2 text-right font-medium">Started</th>
                    <th className="pb-2 text-right font-medium">Completed</th>
                    <th className="pb-2 text-right font-medium">Abandoned</th>
                  </tr>
                </thead>
                <tbody>
                  {summary.tasks.byClass
                    .filter((c) => c.started > 0)
                    .map((c) => (
                      <tr key={c.taskClass} className="border-t border-neutral-800">
                        <td className="py-2 capitalize text-neutral-200">{c.taskClass}</td>
                        <td className="py-2 text-right font-mono text-neutral-300">{c.started}</td>
                        <td className="py-2 text-right font-mono text-emerald-300">
                          {c.completed}
                        </td>
                        <td className="py-2 text-right font-mono text-amber-300">{c.abandoned}</td>
                      </tr>
                    ))}
                  {summary.tasks.byClass.every((c) => c.started === 0) && (
                    <tr className="border-t border-neutral-800">
                      <td colSpan={4} className="py-6 text-center text-neutral-500">
                        No tasks started in this window.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </Card>

          <div className="flex gap-3">
            <Link href="/stats">
              <Button variant="secondary" size="sm">
                Advanced statistics
              </Button>
            </Link>
            <Link href="/tasks">
              <Button variant="secondary" size="sm">
                All tasks
              </Button>
            </Link>
          </div>
        </>
      )}
    </div>
  );
}
