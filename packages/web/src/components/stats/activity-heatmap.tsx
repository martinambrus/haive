import Link from 'next/link';
import { cn } from '@/lib/cn';
import { HEAT_EMPTY, HEAT_RAMP } from './palette';
import {
  calendarMonths,
  heatStep,
  heatThresholds,
  heatValue,
  HEAT_METRICS,
  WEEKDAY_LABELS,
  type HeatMetric,
} from '@/lib/stats/heat-scale';
import { formatAgentHours, formatBucketLabel, formatCount } from '@/lib/stats/format-stats';
import type { StatsTimelineDay } from '@/lib/api-client';

/**
 * Calendar heatmap of the window, one block per month.
 *
 * Plain divs, so this is imported statically. The three recharts charts are behind
 * `next/dynamic` only because recharts is a ~7 MB package with a d3/redux tree; there is
 * nothing here worth deferring, and lazy-loading it would just make the tab flash.
 *
 * It renders from `/stats/timeline`, which the page already fetches for every tab, and reads
 * four per-day fields the API has always computed and nothing has ever displayed.
 */

const CELL = 'h-3.5 w-3.5 rounded-sm';

function cellColor(step: 0 | 1 | 2 | 3 | 4): string {
  return step === 0 ? HEAT_EMPTY : HEAT_RAMP[step - 1]!;
}

export function ActivityHeatmap({
  days,
  metric,
  onMetricChange,
  money,
  dayHref,
  className,
}: {
  days: StatsTimelineDay[];
  metric: HeatMetric;
  onMetricChange: (metric: HeatMetric) => void;
  money: (usd: number) => string;
  dayHref: (bucket: string) => string;
  /** Lets a caller make this a growing flex child, so a card stretched taller than the grid
   *  puts the slack between the grid and the legend instead of below everything. */
  className?: string;
}) {
  const byDay = new Map(days.map((d) => [d.bucket, d]));
  const thresholds = heatThresholds(days.map((d) => heatValue(d, metric)));
  const months = calendarMonths(days.map((d) => d.bucket));

  return (
    <div className={cn('flex flex-col gap-4', className)}>
      <div className="flex flex-wrap items-center gap-2">
        {HEAT_METRICS.map((m) => (
          <button
            key={m.id}
            type="button"
            onClick={() => onMetricChange(m.id)}
            className={cn(
              'rounded-md px-2 py-1 text-xs transition-colors',
              m.id === metric
                ? 'bg-indigo-950/60 text-indigo-200'
                : 'text-neutral-300 hover:bg-neutral-900 hover:text-neutral-100',
            )}
            aria-pressed={m.id === metric}
          >
            {m.label}
          </button>
        ))}
      </div>

      {months.length === 0 ? (
        // A grid of empty squares reads as a rendering failure; a sentence does not.
        <div className="text-sm text-neutral-500">No activity recorded in this window.</div>
      ) : (
        /* The right strip is reserved so a tooltip cannot leave the card. Tooltips open
           rightwards from a cell, and padding on this container keeps every cell out of the
           last 176px — so the widest tooltip still lands inside it, by construction rather
           than by guessing where a block sits. MEASURED at 144px for the widest of these
           (a four-row tooltip carrying a formatted cost); the rest is headroom for a longer
           currency string. Blocks just wrap one column earlier, invisible at this cell size.

           flex-1 + content-start so a caller that stretches this panel (the dashboard pairs it
           with a taller card) puts the slack BELOW the month blocks and keeps the legend at the
           foot. Inert everywhere else: an auto-height column has no free space to hand out, so
           /stats renders exactly as it did. */
        <div className="flex flex-1 flex-wrap content-start gap-6 pr-44">
          {months.map((month) => (
            <div key={month.key} className="flex flex-col gap-1">
              <div className="text-[10px] font-medium uppercase tracking-wider text-neutral-500">
                {month.label}
              </div>
              <div className="flex gap-px">
                {WEEKDAY_LABELS.map((label, i) => (
                  <div
                    key={i}
                    aria-hidden
                    className="flex h-3.5 w-3.5 items-center justify-center text-[8px] text-neutral-600"
                  >
                    {label}
                  </div>
                ))}
              </div>
              {month.weeks.map((week, wi) => (
                <div key={wi} className="flex gap-px">
                  {week.map((cell, ci) => {
                    const day = cell.bucket ? byDay.get(cell.bucket) : undefined;
                    // A pad cell, or a day the window does not cover: a hole, not a quiet day.
                    if (!cell.bucket || !day) return <div key={ci} className={CELL} />;
                    const step = heatStep(heatValue(day, metric), thresholds);
                    return (
                      <div key={ci} className="group relative">
                        <Link
                          href={dayHref(cell.bucket)}
                          className={cn(
                            CELL,
                            'block transition-transform hover:scale-125 focus-visible:scale-125 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-indigo-400',
                          )}
                          style={{ backgroundColor: cellColor(step) }}
                          aria-label={`${cell.bucket}: ${formatAgentHours(day.agentMs)}, ${formatCount(day.invocations)} runs`}
                        />
                        <div
                          className={cn(
                            'pointer-events-none absolute bottom-full z-10 mb-1 hidden whitespace-nowrap rounded-md border border-neutral-700 bg-neutral-950 px-2 py-1.5 text-[11px] shadow-lg group-hover:block group-focus-within:block',
                            // Opens rightwards from the cell's left edge, always.
                            //
                            // A cell is 14px and the tooltip ~120px, so a centred one overhangs
                            // by ~53px on both sides and can leave a narrow viewport. Anchoring
                            // by month index or column index does NOT fix that, and the reason
                            // is worth keeping: the blocks are flex-wrapped, so neither index
                            // says where a block actually sits — MEASURED on a one-year window,
                            // 15 blocks wrap and the LAST one starts a new row at the card's
                            // left edge, where a right-anchored tooltip hung 105px outside it.
                            // Position cannot be inferred here without reading layout, so this
                            // picks the direction with the headroom instead: blocks fill
                            // left-to-right, leaving the right edge the only side that can run
                            // out, and only for the final block of a completely full row.
                            'left-0',
                          )}
                        >
                          <div className="mb-0.5 font-medium text-neutral-200">
                            {formatBucketLabel(cell.bucket)}
                          </div>
                          {/* Every metric, not just the selected one — the question a cell
                              prompts is usually about a different number than the one that
                              made it dark. */}
                          <TooltipRow label="Agent-hours" value={formatAgentHours(day.agentMs)} />
                          <TooltipRow label="Runs" value={formatCount(day.invocations)} />
                          <TooltipRow label="Tasks done" value={formatCount(day.tasksCompleted)} />
                          <TooltipRow label="Spend" value={money(day.realUsd + day.notionalUsd)} />
                        </div>
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-4 text-[10px] text-neutral-500">
        <div className="flex items-center gap-1.5">
          <span>Less</span>
          {HEAT_RAMP.map((c) => (
            <span key={c} className="h-3 w-3 rounded-sm" style={{ backgroundColor: c }} />
          ))}
          <span>More</span>
        </div>
        {/* Its own swatch, because "nothing ran" and "the quietest day that had work" are
            different claims and the ramp's pale end must not be read as either. */}
        <div className="flex items-center gap-1.5">
          <span className="h-3 w-3 rounded-sm" style={{ backgroundColor: HEAT_EMPTY }} />
          <span>No work</span>
        </div>
        <span>Shaded by quartile of the days that had work. Click a day to open its tasks.</span>
      </div>
    </div>
  );
}

function TooltipRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3">
      <span className="text-neutral-500">{label}</span>
      <span className="font-mono text-neutral-300">{value}</span>
    </div>
  );
}
