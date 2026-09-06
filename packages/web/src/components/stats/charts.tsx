'use client';

import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { CHART_CHROME, CHART_COLORS } from './palette';
import { formatBucketLabel } from '@/lib/stats/format-stats';
import { formatCost, type CostDisplay } from '@/lib/format-cost';
import type { StatsTimelineDay } from '@/lib/api-client';

/**
 * Dashboard charts.
 *
 * Imported through `next/dynamic` with `ssr: false` — recharts is a ~7 MB package with a
 * redux/d3 transitive tree, and there is no reason for any of it to reach the server render or
 * the initial client bundle. This is the package's first use of `next/dynamic`; the existing
 * lazy-load precedent (`mermaid-loader.ts`) is a memoised bare `import()`, which suits an
 * imperative library but not a React component tree.
 *
 * Colours come from `palette.ts`, which is pinned to the semantic colours the task detail page
 * established. Real spend and the subscription counterfactual are deliberately in different
 * hue families: one is money spent, the other is money NOT spent, and a shared hue invites
 * adding them together.
 */

const tooltipStyle = {
  backgroundColor: CHART_CHROME.tooltipBg,
  border: `1px solid ${CHART_CHROME.tooltipBorder}`,
  borderRadius: 6,
  fontSize: 12,
} as const;

const axisProps = {
  stroke: CHART_CHROME.axis,
  tick: { fill: CHART_CHROME.axis, fontSize: 11 },
  tickLine: false,
  axisLine: false,
} as const;

function EmptyChart({ message }: { message: string }) {
  return (
    <div className="flex h-[220px] items-center justify-center text-sm text-neutral-500">
      {message}
    </div>
  );
}

/** Did anything at all happen in this window? A chart of thirty zeroes is worse than a
 *  sentence saying nothing ran — it looks like a rendering failure. */
function isAllZero(days: StatsTimelineDay[], pick: (d: StatsTimelineDay) => number): boolean {
  return days.every((d) => pick(d) === 0);
}

export function SpendChart({
  days,
  costDisplay,
}: {
  days: StatsTimelineDay[];
  costDisplay: CostDisplay;
}) {
  if (days.length === 0 || isAllZero(days, (d) => d.realUsd + d.notionalUsd)) {
    return <EmptyChart message="No spend recorded in this window." />;
  }
  return (
    <ResponsiveContainer width="100%" height={220}>
      <BarChart data={days} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        <CartesianGrid stroke={CHART_CHROME.grid} vertical={false} />
        <XAxis dataKey="bucket" tickFormatter={formatBucketLabel} minTickGap={24} {...axisProps} />
        <YAxis
          width={56}
          tickFormatter={(v: number) => formatCost(v, costDisplay)}
          {...axisProps}
        />
        <Tooltip
          contentStyle={tooltipStyle}
          // recharts types these callbacks against ReactNode / ValueType | undefined rather
          // than the concrete types the chart actually supplies, so both are coerced here.
          labelFormatter={(label) => formatBucketLabel(String(label ?? ''))}
          formatter={(value, name) => [
            formatCost(Number(value) || 0, costDisplay),
            String(name ?? ''),
          ]}
          cursor={{ fill: '#ffffff08' }}
        />
        <Legend wrapperStyle={{ fontSize: 11, color: CHART_CHROME.axis }} />
        <Bar dataKey="realUsd" name="Spent" stackId="spend" fill={CHART_COLORS.cost} />
        <Bar
          dataKey="notionalUsd"
          name="Saved by plan"
          stackId="spend"
          fill={CHART_COLORS.notional}
        />
      </BarChart>
    </ResponsiveContainer>
  );
}

export function ActivityChart({ days }: { days: StatsTimelineDay[] }) {
  if (days.length === 0 || isAllZero(days, (d) => d.agentMs + d.busyMs)) {
    return <EmptyChart message="No agent activity in this window." />;
  }
  // Hours, computed here rather than in the tooltip so the axis and the series agree.
  const data = days.map((d) => ({
    bucket: d.bucket,
    agentHours: d.agentMs / 3_600_000,
    busyHours: d.busyMs / 3_600_000,
  }));
  return (
    <ResponsiveContainer width="100%" height={220}>
      <AreaChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        <CartesianGrid stroke={CHART_CHROME.grid} vertical={false} />
        <XAxis dataKey="bucket" tickFormatter={formatBucketLabel} minTickGap={24} {...axisProps} />
        <YAxis width={40} tickFormatter={(v: number) => `${v.toFixed(0)}h`} {...axisProps} />
        <Tooltip
          contentStyle={tooltipStyle}
          labelFormatter={(label) => formatBucketLabel(String(label ?? ''))}
          formatter={(value, name) => [`${(Number(value) || 0).toFixed(2)} h`, String(name ?? '')]}
          cursor={{ stroke: CHART_CHROME.axis }}
        />
        <Legend wrapperStyle={{ fontSize: 11, color: CHART_CHROME.axis }} />
        {/* Busy span sits UNDER agent-hours: it is the clock the agent-hours were spent
            inside, so the gap between the two IS the concurrency. */}
        <Area
          type="monotone"
          dataKey="busyHours"
          name="Busy span (elapsed)"
          stroke={CHART_COLORS.busy}
          fill={CHART_COLORS.busy}
          fillOpacity={0.15}
          strokeWidth={2}
        />
        <Area
          type="monotone"
          dataKey="agentHours"
          name="Agent-hours (compute)"
          stroke={CHART_COLORS.agent}
          fill={CHART_COLORS.agent}
          fillOpacity={0.08}
          strokeWidth={2}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}
