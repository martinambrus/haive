/**
 * Read the published per-token rate off an Ollama model page.
 *
 * Pure and network-free, like the rest of this directory: the worker fetches and
 * stores (`cli-versions/ollama-model-prices.ts`), this owns the parse so the
 * contract is testable against saved fixtures rather than the live site.
 *
 * WHY a scraper at all. Ollama Cloud is plan-included up to a limit and metered
 * beyond it, and it publishes NO price document: `ollama.com/pricing` states plans
 * (Free / Pro / Max / Team) and difficulty grades but not one per-token rate, and
 * there is no pricing API. The only place a rate is stated is the individual model
 * page, and only for some models -- MEASURED 2026-08-23, 1 of 8 configured cloud
 * models had one. So the rates that exist are scraped, and the ones that do not
 * exist stay unpriced.
 *
 * Absence is a RESULT, not a failure. Most pages have no cost block; that means
 * plan-included and must resolve `source: 'none'` WITHOUT logging an error, or every
 * refresh tick cries wolf about the normal case.
 *
 * Failure is loud and writes NOTHING. A page that HAS a cost block this cannot read
 * is an error, never a 0 -- storing 0 is how "unknown" turns into "free", which is
 * the whole bug this feed exists to undo.
 */

import type { ModelPriceRates } from './model-pricing.js';

/** Model pages live one per BASE model; the tag is not part of the URL.
 *  `kimi-k3:cloud` and `qwen3-coder:480b-cloud` are documented at
 *  `/library/kimi-k3` and `/library/qwen3-coder`. */
export const OLLAMA_MODEL_PAGE_BASE = 'https://ollama.com/library/';

/** Strip the tag: everything from the first `:`. Null for an empty id. */
export function ollamaModelPageSlug(model: string): string | null {
  const base = model.trim().split(':')[0]?.trim().toLowerCase() ?? '';
  return base === '' ? null : base;
}

export function ollamaModelPageUrl(model: string): string | null {
  const slug = ollamaModelPageSlug(model);
  return slug === null ? null : `${OLLAMA_MODEL_PAGE_BASE}${slug}`;
}

export type OllamaPageParse =
  { kind: 'priced'; rates: ModelPriceRates } | { kind: 'none' } | { kind: 'error'; reason: string };

/** VOLATILE. Everything here reads ollama.com's rendered HTML -- presentation, not a
 *  contract, and it will reword. Kept in ONE constant so a reword is a one-line fix,
 *  and every path that stops matching FAILS LOUD (an error, no write) rather than
 *  silently degrading to a 0 or to "no rate published".
 *
 *  MEASURED 2026-08-23 against `ollama.com/library/kimi-k3`, whose block renders as
 *    <span>Cost</span> <span>/1M tokens</span>
 *    <div>$3.00</div><div>input</div>
 *    <div>$0.30</div><div>cached</div>
 *    <div>$15.00</div><div>output</div>
 *  Server-rendered: no JS and no API call needed. */
const OLLAMA_PAGE_MARKUP = {
  /** The block heading. Its presence alone proves nothing -- "cost" also occurs in
   *  prose -- so a block is only accepted once a `$` amount is found beside it. */
  costHeading: /\bcost\b/i,
  /** The only unit this parser knows how to convert from. Anything else is an error:
   *  silently reading "/1K tokens" as "/1M tokens" understates by 1000x. */
  unit: /^\/\s*1M\s+tokens$/i,
  /** Which bucket each published label feeds. */
  labels: {
    input: 'inputRate',
    output: 'outputRate',
    cached: 'cacheReadRate',
    'cached input': 'cacheReadRate',
  } as Readonly<Record<string, keyof ModelPriceRates>>,
} as const;

/** How many visible tokens past the heading the block's own values may lie. Bounded
 *  so an unrelated "cost" in prose cannot vacuum up a price from elsewhere. */
const BLOCK_TOKEN_SPAN = 24;

/** Placeholder for a stripped tag. A control character, so it cannot collide with
 *  page text. */
const TAG_SEP = '\u0001';

/** Flatten HTML to the visible token sequence, one entry per element's text.
 *
 *  Tags become separators rather than being matched, which is what makes the pairing
 *  step depend on ADJACENCY rather than on element names or nesting depth -- both are
 *  pure styling and change without notice. */
function visibleTokens(html: string): string[] {
  return html
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]*>/g, TAG_SEP)
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .split(TAG_SEP)
    .map((t) => t.replace(/\s+/g, ' ').trim())
    .filter((t) => t !== '');
}

/** `$3.00` -> 3, `$1,234 input` -> 1234 plus the label that shared its element. */
function parseDollars(token: string): { amount: number; trailing: string } | null {
  const m = /^\$\s*([0-9][0-9,]*(?:\.[0-9]+)?)\s*(.*)$/.exec(token);
  if (!m) return null;
  const amount = Number(m[1]!.replace(/,/g, ''));
  if (!Number.isFinite(amount) || amount < 0) return null;
  return { amount, trailing: m[2]!.trim() };
}

const NO_RATES: ModelPriceRates = {
  inputRate: null,
  outputRate: null,
  cacheReadRate: null,
  cacheWriteRate: null,
  cacheWrite1hRate: null,
};

/** Parse one model page.
 *
 *  Rates come back USD per SINGLE token (the published figure divided by 1e6), which
 *  is what `cli_model_prices.rates` stores and what `computeInvocationCost` reads. */
export function parseOllamaModelPage(html: string): OllamaPageParse {
  const tokens = visibleTokens(html);

  // Locate the block: a "Cost" heading with at least one `$` amount close after it.
  // Requiring the amount is what stops the word "cost" in prose being read as a broken
  // price block and reported as an error on every tick.
  let start = -1;
  for (let i = 0; i < tokens.length; i++) {
    if (!OLLAMA_PAGE_MARKUP.costHeading.test(tokens[i]!)) continue;
    if (!tokens.slice(i, i + BLOCK_TOKEN_SPAN).some((t) => /\$\s*[0-9]/.test(t))) continue;
    start = i;
    break;
  }
  if (start === -1) return { kind: 'none' };

  const block = tokens.slice(start, start + BLOCK_TOKEN_SPAN);

  // The unit decides the scale. Absent or unrecognised is an error, never a guess.
  const unit = block.find((t) => t.startsWith('/'));
  if (unit === undefined) return { kind: 'error', reason: 'cost block has no rate unit' };
  if (!OLLAMA_PAGE_MARKUP.unit.test(unit)) {
    return { kind: 'error', reason: `unsupported rate unit ${JSON.stringify(unit)}` };
  }

  // Pair each amount with the label that FOLLOWS it, never with a fixed position. Not
  // theoretical: an automated read of this exact page during diagnosis returned input
  // $0.30 / cached $3.00 -- the two swapped -- because it read them in order.
  const rates: ModelPriceRates = { ...NO_RATES };
  let amounts = 0;
  for (let i = 0; i < block.length; i++) {
    const money = parseDollars(block[i]!);
    if (money === null) continue;
    amounts++;
    const label = (money.trailing !== '' ? money.trailing : (block[i + 1] ?? '')).toLowerCase();
    const bucket = OLLAMA_PAGE_MARKUP.labels[label];
    // An unknown label is a bucket this parser does not price, not a broken parse: the
    // rate stays null, and an invocation using that bucket records `source: 'none'`
    // through unpricedBuckets rather than a short total.
    if (bucket === undefined) continue;
    rates[bucket] = money.amount / 1_000_000;
  }

  if (rates.inputRate === null || rates.outputRate === null) {
    return {
      kind: 'error',
      reason: `cost block found (${amounts} amounts) but input/output could not be paired with a label`,
    };
  }
  // Cached input is cheaper than fresh input at every vendor, so a violation means the
  // pairing is wrong, not that Ollama charges more for a cache hit.
  if (rates.cacheReadRate !== null && rates.cacheReadRate > rates.inputRate) {
    return { kind: 'error', reason: 'cached rate exceeds input rate; pairing is wrong' };
  }
  // A published all-zero cost block states nothing, and storing it would recreate the
  // exact bug this feed replaces: a 0 is a PRICE, not "unknown".
  if (rates.inputRate === 0 && rates.outputRate === 0) {
    return { kind: 'error', reason: 'cost block prices input and output at 0' };
  }
  return { kind: 'priced', rates };
}
