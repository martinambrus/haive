import { cn } from '@/lib/cn';

/**
 * A part-to-whole bar: one track, one segment per component, widths proportional to value.
 *
 * A bar rather than a donut, and that is a measurement rather than a preference. The token mix
 * this renders is extremely skewed — MEASURED across 2,845 invocations, cache reads are 73.4%
 * of all tokens and output is 1.7%, which as a pie is a six-degree slice sitting next to an
 * arc three-quarters of the way round. Slice angles are the weakest encoding there is for
 * comparing values that far apart, and a bar also extends to one row per provider for free.
 */

export interface ShareSegment {
  key: string;
  label: string;
  value: number;
  /** Bound to the SEGMENT, never to its rank, so re-sorting or filtering repaints nothing. */
  color: string;
}

export function StackedShareBar({
  segments,
  formatValue,
  emptyMessage = 'Nothing recorded in this window.',
  className,
}: {
  segments: ShareSegment[];
  formatValue: (value: number) => string;
  emptyMessage?: string;
  className?: string;
}) {
  const shown = segments.filter((s) => Number.isFinite(s.value) && s.value > 0);
  const total = shown.reduce((n, s) => n + s.value, 0);

  if (total <= 0) {
    return <div className={cn('text-sm text-neutral-500', className)}>{emptyMessage}</div>;
  }

  const share = (value: number) => (value / total) * 100;

  return (
    <div className={cn('flex flex-col gap-2', className)}>
      {/* Proportional flex-grow rather than percentage widths: the 2px separators are then
          taken out of the track instead of overflowing it. The gap IS the separator — a border
          would add a line of its own between two fills. */}
      <div className="flex h-2.5 w-full gap-[2px]">
        {shown.map((s) => (
          <div
            key={s.key}
            className="first:rounded-l-full last:rounded-r-full"
            style={{ flexGrow: s.value, flexBasis: 0, backgroundColor: s.color }}
            title={`${s.label}: ${formatValue(s.value)} (${share(s.value).toFixed(1)}%)`}
          />
        ))}
      </div>
      {/* Every segment is named here rather than inside the fill. A 1.7% segment cannot hold a
          legible label, and a label clipped by its own segment is worse than one below it. */}
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {shown.map((s) => (
          <div key={s.key} className="flex items-baseline gap-1.5 text-[11px]">
            <span
              aria-hidden
              className="inline-block h-2 w-2 shrink-0 translate-y-[1px] rounded-[2px]"
              style={{ backgroundColor: s.color }}
            />
            <span className="text-neutral-400">{s.label}</span>
            <span className="font-mono text-neutral-200">{formatValue(s.value)}</span>
            <span className="font-mono text-neutral-500">{share(s.value).toFixed(1)}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}
