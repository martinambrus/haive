/** Cost display: convert a canonical USD amount into the configured currency and
 *  format it.
 *
 *  Storage is always USD because that is what every vendor bills. The currency here is
 *  presentation only, applied at the rate the API resolved for the task's own date, so
 *  re-rendering a finished task later shows the same number.
 */

export interface CostDisplay {
  currency: string;
  /** USD per one unit of `currency`; 1 for USD. */
  usdPerUnit: number;
  rateDate: string | null;
  /** The rate is the nearest one on record rather than one effective on the task's
   *  date — true for tasks older than FX collection. Surfaced, never hidden. */
  approximate: boolean;
}

export const USD_DISPLAY: CostDisplay = {
  currency: 'USD',
  usdPerUnit: 1,
  rateDate: null,
  approximate: false,
};

/** Where a cost number came from, as the API reports it per provider. */
export type CostSource = 'reported' | 'computed' | 'manual' | 'none' | 'mixed' | 'legacy';

/** Convert a USD amount into the display currency. Falls back to the USD amount when
 *  the rate is unusable, rather than rendering NaN or a silently wrong figure. */
export function convertCost(costUsd: number, display: CostDisplay | null | undefined): number {
  const rate = display?.usdPerUnit;
  if (!rate || !Number.isFinite(rate) || rate <= 0) return costUsd;
  return costUsd / rate;
}

/** Format a USD amount in the display currency.
 *
 *  Small non-zero amounts keep four decimals instead of rounding to `$0.00`: a step
 *  that cost a third of a cent should not read as free, which is the same "0 means
 *  free" trap the rate parsing avoids. Uses Intl so each currency gets its own symbol
 *  and separators; an unknown currency code degrades to a plain number with the code
 *  appended rather than throwing. */
export function formatCost(
  costUsd: number,
  display: CostDisplay | null | undefined,
  opts: { maxFractionDigits?: number } = {},
): string {
  const value = convertCost(costUsd, display);
  const currency = display?.currency ?? 'USD';
  const digits = opts.maxFractionDigits ?? (value !== 0 && Math.abs(value) < 0.01 ? 4 : 2);
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency,
      minimumFractionDigits: Math.min(2, digits),
      maximumFractionDigits: digits,
    }).format(value);
  } catch {
    return `${value.toFixed(digits)} ${currency}`;
  }
}

/** One-line explanation of a cost number, for a tooltip. Says where the figure came
 *  from and what it was converted at, because "$7.18" alone cannot distinguish a
 *  vendor-reported total from one Haive computed. */
export function describeCostSource(
  source: CostSource,
  display: CostDisplay | null | undefined,
  unpricedInvocations = 0,
): string {
  const base = (() => {
    switch (source) {
      case 'reported':
        return 'Reported by the CLI itself';
      case 'computed':
        return 'Computed from synced per-model rates';
      case 'manual':
        return 'Computed from an admin-entered rate';
      case 'none':
        return 'No usable rate — not counted';
      case 'mixed':
        return 'Mixed sources across this task';
      case 'legacy':
        return 'Recorded before per-model pricing';
    }
  })();
  const parts = [base];
  if (unpricedInvocations > 0) {
    parts.push(`${unpricedInvocations} invocation(s) unpriced and excluded`);
  }
  if (display && display.currency !== 'USD') {
    parts.push(
      display.approximate
        ? `converted at the nearest known rate (${display.rateDate ?? 'unknown date'})`
        : `converted at the ${display.rateDate ?? 'current'} ECB rate`,
    );
  }
  return parts.join(' · ');
}
