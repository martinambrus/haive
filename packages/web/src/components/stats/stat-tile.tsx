import { cn } from '@/lib/cn';
import { deltaToneClass, formatDeltaPercent } from '@/lib/stats/format-stats';
import type { StatsDelta } from '@/lib/api-client';

export interface StatTileProps {
  label: string;
  value: string;
  /** Secondary line under the value — a unit, a breakdown, a caveat. */
  hint?: string;
  /** Period-over-period change. Rendered beside the label, not the value, so it never
   *  competes with the figure itself. */
  delta?: StatsDelta | null;
  /** Whether growth in this figure is welcome. Stated by the caller because direction alone
   *  cannot say: more tasks completed is good, more money spent is not. */
  moreIsBetter?: boolean;
  /** Tailwind colour class for the value. Defaults to the neutral figure colour. */
  tone?: string;
  /** Shown in place of the delta when the figure is built from too few observations. */
  underSampledNote?: string | null;
  className?: string;
}

/**
 * One KPI figure.
 *
 * Modelled on the eight-line `Stat` the estimation-accuracy page already renders inline, plus
 * the two things that page does not have and a dashboard needs: a period-over-period delta,
 * because a number with no baseline is not an insight; and a sample-count note, because on a
 * young install most derived figures are noise and a percentage from three rows must not read
 * like one from three hundred.
 */
export function StatTile({
  label,
  value,
  hint,
  delta,
  moreIsBetter = true,
  tone = 'text-neutral-100',
  underSampledNote,
  className,
}: StatTileProps) {
  return (
    <div className={cn('flex flex-col gap-0.5', className)}>
      <div className="flex items-baseline gap-2">
        <p className="text-[10px] uppercase tracking-wider text-neutral-500">{label}</p>
        {underSampledNote ? (
          <span className="text-[10px] text-amber-400" title="Too few observations to trend">
            {underSampledNote}
          </span>
        ) : delta ? (
          <span
            className={cn('font-mono text-[10px]', deltaToneClass(delta, moreIsBetter))}
            title="Change vs the previous period of equal length"
          >
            {formatDeltaPercent(delta)}
          </span>
        ) : null}
      </div>
      <p className={cn('font-mono text-xl font-semibold', tone)}>{value}</p>
      {hint ? <p className="text-[11px] text-neutral-600">{hint}</p> : null}
    </div>
  );
}
