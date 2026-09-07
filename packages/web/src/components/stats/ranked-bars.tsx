import { cn } from '@/lib/cn';

/**
 * A ranked list with a bar per row: rank, label, value, and a track sized against the LARGEST
 * row rather than against the total.
 *
 * Against the total is the other obvious choice and it is the wrong one here — these lists are
 * "which of these is biggest", not "how is a whole divided" (that is `StackedShareBar`), and a
 * share denominator flattens every row once the list is long.
 *
 * ONE hue for the whole list. The lists are magnitude comparisons, so colour carries no
 * identity and a per-row hue would invent one; where a row's colour does mean something
 * (severity) the caller passes a function keyed on the ROW, never on its position. Colouring by
 * rank — `COLORS[index % COLORS.length]`, the obvious shortcut — is the specific thing to avoid:
 * it repaints every surviving row whenever a filter changes the set.
 */

export interface RankedRow {
  key: string;
  /** Defaults to `key`. */
  label?: string;
  value: number;
  /** Rendered after the value, e.g. a share or a secondary count. */
  hint?: string;
}

export function RankedBars({
  rows,
  formatValue = (n) => n.toLocaleString(),
  color = '#818cf8',
  order = 'value',
  limit = 12,
  emptyMessage = 'Nothing recorded in this window.',
  className,
}: {
  rows: RankedRow[];
  formatValue?: (value: number) => string;
  /** A single hue, or one keyed on the row for a scale that means something. */
  color?: string | ((row: RankedRow) => string);
  /** `given` keeps the caller's order — for a scale (severity) whose sequence is the point. */
  order?: 'value' | 'given';
  limit?: number;
  emptyMessage?: string;
  className?: string;
}) {
  if (rows.length === 0) {
    return <p className={cn('text-sm text-neutral-500', className)}>{emptyMessage}</p>;
  }

  const ordered = order === 'value' ? [...rows].sort((a, b) => b.value - a.value) : rows;
  // The rank number is only meaningful when the list IS ranked by value. On a scale kept in its
  // own order it actively lies: severity renders high/medium/low, and numbering that 1/2/3 reads
  // as "high is the biggest" when high was 4 against medium's 35.
  const showRank = order === 'value';
  const shown = ordered.slice(0, limit);
  const hidden = ordered.length - shown.length;
  // Against the largest row, and never zero — an all-zero list renders empty tracks rather
  // than dividing by nothing.
  const max = Math.max(...ordered.map((r) => r.value), 1);

  return (
    <div className={cn('flex flex-col', className)}>
      {shown.map((row, i) => (
        <div key={row.key} className="flex items-center gap-3 rounded-md py-1.5">
          {showRank && (
            <span className="w-4 shrink-0 text-right font-mono text-[10px] text-neutral-600">
              {i + 1}
            </span>
          )}
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline justify-between gap-2">
              <span className="truncate text-xs text-neutral-300">{row.label ?? row.key}</span>
              <span className="shrink-0 font-mono text-xs tabular-nums text-neutral-200">
                {formatValue(row.value)}
                {row.hint ? <span className="ml-1 text-neutral-500">{row.hint}</span> : null}
              </span>
            </div>
            <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-neutral-800">
              <div
                className="h-full rounded-full"
                style={{
                  width: `${(row.value / max) * 100}%`,
                  backgroundColor: typeof color === 'string' ? color : color(row),
                }}
              />
            </div>
          </div>
        </div>
      ))}
      {/* The cap is stated, never silent. A truncated ranking presented as a complete one is
          the same failure the review scope's COVERAGE notice exists to prevent. */}
      {hidden > 0 && (
        <p className="pt-1 text-[11px] text-neutral-500">
          +{hidden.toLocaleString()} more not shown
        </p>
      )}
    </div>
  );
}

/** The same bar as a table cell, for a column that already carries its own number. */
export function InlineBar({
  value,
  max,
  color = '#818cf8',
}: {
  value: number;
  max: number;
  color?: string;
}) {
  return (
    <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-neutral-800">
      <div
        className="h-full rounded-full"
        style={{ width: `${(value / Math.max(max, 1)) * 100}%`, backgroundColor: color }}
      />
    </div>
  );
}
