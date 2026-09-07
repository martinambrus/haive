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

/**
 * Sequential ramp for the activity heatmap. Deep to pale as magnitude RISES, because the page
 * is dark: on this surface lightness is prominence, so the busiest day has to be the brightest
 * square. (The usual "more is darker" phrasing describes a light-mode ramp and would render
 * the busiest day as the one closest to the background.)
 *
 * Indigo because that is already the hue for agent time (`agent`/`work` above), and the
 * heatmap's default metric is agent-hours — a heat cell and the ActivityChart line beside it
 * describe the same quantity and must not teach two colours for it.
 *
 * The steps are MEASURED, not picked: validated against the page surface (#0a0a0a) for
 * monotone lightness, an adjacent lightness gap >= 0.06, and a dark end that still reads as a
 * mark (2.51:1, over the 2:1 floor). The obvious Tailwind run indigo-900/800/600/400/300
 * FAILS both of the first two gates — 900 and 800 are 0.04 apart in L, and 800 sits at 1.73:1
 * against this surface, i.e. a "busy day" that renders as background.
 */
export const HEAT_RAMP = [
  '#4338ca', // indigo-700
  '#6366f1', // indigo-500
  '#a5b4fc', // indigo-300
  '#e0e7ff', // indigo-100
] as const;

/** A day inside the window on which nothing ran. Distinct from the surface (so the grid reads
 *  as a grid) and from the ramp's dark end (so "no work" never reads as "a little work"); days
 *  OUTSIDE the window render nothing at all rather than taking this colour. */
export const HEAT_EMPTY = '#171717'; // neutral-900

/**
 * The four token buckets, as a categorical set.
 *
 * Colour is bound to the BUCKET and never to its size, so a filter that reorders the segments
 * repaints nothing.
 *
 * Deliberately NOT the `tokens`/`cached`/`fresh` entries above. Those were chosen for the task
 * page's total-time card, where each figure has its own text label doing the identifying;
 * validated as adjacent fills in one bar they FAIL outright — sky-300 vs cyan-300 measure a
 * colour-vision-deficient ΔE of 4.6 and, worse, a normal-vision ΔE of 5.6, which is
 * indistinguishable to everyone. This set measures 10.1 CVD / 28.8 normal on its worst
 * adjacent pair, with every slot over 3:1 against the surface. The task page keeps its own
 * classes: different job, different constraint.
 */
export const TOKEN_COLORS = {
  /** cache read — sky-600, the largest bucket by far (73.4% of all tokens, measured) */
  cacheRead: '#0284c7',
  /** fresh input — orange-600 */
  freshInput: '#ea580c',
  /** cache write — emerald-600 */
  cacheCreation: '#059669',
  /** output — violet-500. 1.7% of the total, which is why this is a bar and not a pie. */
  output: '#8b5cf6',
} as const;
