import { describe, expect, it } from 'vitest';
import {
  ollamaModelPageSlug,
  ollamaModelPageUrl,
  parseOllamaModelPage,
} from '../src/cli-providers/ollama-pricing.js';

/** The cost block as it renders on ollama.com/library/kimi-k3, MEASURED 2026-08-23.
 *  Class soup kept in deliberately: the parser must depend on adjacency, not on the
 *  element names or the styling. */
const PRICED_PAGE = `
<main>
  <h1>kimi-k3</h1>
  <p>A large reasoning model.</p>
  <section class="rounded-lg border p-4">
    <span class="text-sm text-neutral-500">Cost</span>
    <span class="text-xs text-neutral-400">/1M tokens</span>
    <div class="grid grid-cols-3">
      <div class="text-lg tabular-nums">$3.00</div><div class="text-xs">input</div>
      <div class="text-lg tabular-nums">$0.30</div><div class="text-xs">cached</div>
      <div class="text-lg tabular-nums">$15.00</div><div class="text-xs">output</div>
    </div>
  </section>
</main>`;

/** The COMMON case: 7 of the 8 configured cloud models publish no rate at all. The
 *  word "cost" appears in prose, which must not be mistaken for a broken block. */
const UNPRICED_PAGE = `
<main>
  <h1>minimax-m3</h1>
  <p>Included in your plan. See the pricing page for what usage costs against your
     plan limit.</p>
  <section><span>Context</span><div>256K</div></section>
</main>`;

/** The same three rates, published in a different order. Ollama owns the order and
 *  can change it; the pairing must not care. */
const REORDERED_PAGE = `
<main>
  <section>
    <span>Cost</span><span>/1M tokens</span>
    <div><div>$15.00</div><div>output</div></div>
    <div><div>$0.30</div><div>cached</div></div>
    <div><div>$3.00</div><div>input</div></div>
  </section>
</main>`;

describe('ollamaModelPageSlug', () => {
  it('strips the tag, which is not part of the page URL', () => {
    expect(ollamaModelPageSlug('kimi-k3:cloud')).toBe('kimi-k3');
    // The `<size>-cloud` form is the common one and lives on the base model's page too.
    expect(ollamaModelPageSlug('qwen3-coder:480b-cloud')).toBe('qwen3-coder');
    expect(ollamaModelPageSlug('gpt-oss:120b-cloud')).toBe('gpt-oss');
    expect(ollamaModelPageSlug('deepseek-v3.1:671b-cloud')).toBe('deepseek-v3.1');
    expect(ollamaModelPageSlug('  Kimi-K3  ')).toBe('kimi-k3');
    expect(ollamaModelPageSlug('')).toBeNull();
  });

  it('builds the library URL, and is idempotent on an already-stripped id', () => {
    expect(ollamaModelPageUrl('kimi-k3:cloud')).toBe('https://ollama.com/library/kimi-k3');
    expect(ollamaModelPageUrl('kimi-k3')).toBe('https://ollama.com/library/kimi-k3');
  });
});

describe('parseOllamaModelPage', () => {
  it('reads the published block as USD per single token', () => {
    const out = parseOllamaModelPage(PRICED_PAGE);
    expect(out.kind).toBe('priced');
    if (out.kind !== 'priced') return;
    expect(out.rates.inputRate).toBeCloseTo(3e-6, 12);
    expect(out.rates.cacheReadRate).toBeCloseTo(3e-7, 12);
    expect(out.rates.outputRate).toBeCloseTo(1.5e-5, 12);
    // Ollama publishes no cache-WRITE rate; null must stay null, never become 0.
    expect(out.rates.cacheWriteRate).toBeNull();
    expect(out.rates.cacheWrite1hRate).toBeNull();
  });

  it('reports a page with no cost block as a RESULT, not an error', () => {
    // 7 of 8 models. If this were an error the refresh would cry wolf every tick.
    expect(parseOllamaModelPage(UNPRICED_PAGE)).toEqual({ kind: 'none' });
    expect(parseOllamaModelPage('<html><body>nothing here</body></html>')).toEqual({
      kind: 'none',
    });
  });

  it('pairs by LABEL, so a reordered block still reads correctly', () => {
    // Not theoretical: an automated read of the real page during diagnosis returned
    // input $0.30 / cached $3.00 -- the two swapped -- by reading them in order.
    const out = parseOllamaModelPage(REORDERED_PAGE);
    expect(out.kind).toBe('priced');
    if (out.kind !== 'priced') return;
    expect(out.rates.inputRate).toBeCloseTo(3e-6, 12);
    expect(out.rates.cacheReadRate).toBeCloseTo(3e-7, 12);
    expect(out.rates.outputRate).toBeCloseTo(1.5e-5, 12);
  });

  it('REJECTS a block where cached costs more than input', () => {
    // Cached is cheaper than fresh input at every vendor, so a violation means the
    // pairing is wrong rather than that Ollama charges more for a cache hit.
    const swapped = PRICED_PAGE.replace('>$3.00<', '>@@<')
      .replace('>$0.30<', '>$3.00<')
      .replace('>@@<', '>$0.30<');
    const out = parseOllamaModelPage(swapped);
    expect(out.kind).toBe('error');
    if (out.kind !== 'error') return;
    expect(out.reason).toContain('cached rate exceeds input rate');
  });

  it('REJECTS a unit it cannot convert from, rather than assuming the scale', () => {
    // Reading "/1K tokens" as "/1M tokens" understates by 1000x and looks plausible.
    const out = parseOllamaModelPage(PRICED_PAGE.replace('/1M tokens', '/1K tokens'));
    expect(out.kind).toBe('error');
    if (out.kind !== 'error') return;
    expect(out.reason).toContain('unsupported rate unit');
  });

  it('fails LOUD on a cost block whose amounts carry no label it knows', () => {
    // A page that HAS a block and cannot be read must write NOTHING. Writing 0 here is
    // the bug this feed replaces.
    const reworded = PRICED_PAGE.replace('>input<', '>prompt<').replace('>output<', '>completion<');
    const out = parseOllamaModelPage(reworded);
    expect(out.kind).toBe('error');
    if (out.kind !== 'error') return;
    expect(out.reason).toContain('could not be paired');
  });

  it('fails LOUD on a cost block with no unit at all', () => {
    const out = parseOllamaModelPage(
      PRICED_PAGE.replace('<span class="text-xs text-neutral-400">/1M tokens</span>', ''),
    );
    expect(out.kind).toBe('error');
    if (out.kind !== 'error') return;
    expect(out.reason).toContain('no rate unit');
  });

  it('REJECTS a block that prices input and output at 0', () => {
    // An all-zero published rate states nothing, and storing it would recreate the
    // exact failure this feed exists to undo: a 0 is a PRICE, not "unknown".
    const free = PRICED_PAGE.replace('>$3.00<', '>$0.00<')
      .replace('>$0.30<', '>$0.00<')
      .replace('>$15.00<', '>$0.00<');
    const out = parseOllamaModelPage(free);
    expect(out.kind).toBe('error');
  });

  it('ignores a bucket it does not price without failing the whole block', () => {
    // A new label is a rate we cannot apply, not a broken parse: it stays null and an
    // invocation using that bucket records `source: 'none'` via unpricedBuckets.
    const extra = PRICED_PAGE.replace(
      '<div class="text-lg tabular-nums">$15.00</div><div class="text-xs">output</div>',
      '<div>$15.00</div><div>output</div><div>$6.00</div><div>cache write</div>',
    );
    const out = parseOllamaModelPage(extra);
    expect(out.kind).toBe('priced');
    if (out.kind !== 'priced') return;
    expect(out.rates.outputRate).toBeCloseTo(1.5e-5, 12);
    expect(out.rates.cacheWriteRate).toBeNull();
  });
});
