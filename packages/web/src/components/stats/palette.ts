/**
 * Chart colours.
 *
 * Recharts is given hex values because it cannot read Tailwind classes, which makes this the
 * one place where the app's palette is duplicated. It is therefore pinned to the SEMANTIC
 * colours the task detail page already established, not chosen afresh — a stats page that
 * coloured "work" differently from the Total-time card would quietly teach two vocabularies
 * for the same quantity.
 *
 * Values are the Tailwind palette entries the corresponding utility classes resolve to.
 */
export const CHART_COLORS = {
  /** work — indigo-400 (task page: text-indigo-400) */
  work: '#818cf8',
  /** idle — amber-400 */
  idle: '#fbbf24',
  /** user-active — emerald-400 */
  user: '#34d399',
  /** effort — rose-400 */
  effort: '#fb7185',
  /** real spend — emerald-300 */
  cost: '#6ee7b7',
  /** the subscription counterfactual. GREY on purpose and never the cost colour: it is money
   *  NOT spent, and showing it in the same hue invites adding the two together. */
  notional: '#a3a3a3',
  /** tokens — sky-300 */
  tokens: '#7dd3fc',
  /** cached tokens — cyan-300 */
  cached: '#67e8f9',
  /** fresh in+out — teal-300 */
  fresh: '#5eead4',
  /** agent-hours: compute consumed. Uses the work hue because that is what it measures. */
  agent: '#818cf8',
  /** busy span: elapsed clock. Neutral, so it reads as the baseline the agent bars sit on. */
  busy: '#a5b4fc',
} as const;

/** Chrome shared by every chart: grid, axis and tooltip against the neutral-950 page. */
export const CHART_CHROME = {
  grid: '#262626',
  axis: '#737373',
  tooltipBg: '#0a0a0a',
  tooltipBorder: '#404040',
  tooltipText: '#e5e5e5',
} as const;
