import {
  canonicalModelKey,
  type BasePriceRates,
  type CostBucket,
  type CostComputation,
  type CostComputationOptions,
  type InvocationTier,
  type ModelPriceRates,
  type PricedTokens,
} from './model-pricing.js';
import type { RequestUsage, UnobservedSameModelUsage } from './request-usage.js';

type Buckets = Record<CostBucket, number>;
type BucketRates = Record<CostBucket, number | null>;
const zero = (): Buckets => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
const count = (n: unknown): n is number =>
  typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
const sum = (b: Buckets) => b.input + b.output + b.cacheRead + b.cacheWrite;

/** Every token in a request uses its prompt's rate, including output and cache writes.
 * Unknown splits carry partial observed split data, never a summable cost. Bounds are
 * conservative envelopes, not inferred requests or an allocation used for billing. */
export function computeTieredCost(
  usage: PricedTokens,
  rates: ModelPriceRates,
  opts: CostComputationOptions,
): CostComputation {
  const tier: InvocationTier = { state: 'unknown', split: [] };
  const unpriced = new Set<CostBucket>();
  const result = (perBucket = zero()): CostComputation => ({
    costUsd: tier.state === 'exact' && !unpriced.size ? sum(perBucket) : 0,
    perBucket,
    unpricedBuckets: [...unpriced],
    tier,
  });
  const capture = opts.requestUsage;
  const convention = opts.inputIncludesCache ? 'inclusive' : 'exclusive';
  const model = canonicalModelKey(opts.modelKey);
  const raw = {
    ...usage,
    cacheReadTokens: usage.cacheReadTokens ?? 0,
    cacheCreationTokens: usage.cacheCreationTokens ?? 0,
  };
  if (
    ![raw.inputTokens, raw.outputTokens, raw.cacheReadTokens, raw.cacheCreationTokens].every(count)
  )
    return result();
  if (
    !capture ||
    capture.coverage !== 'complete' ||
    capture.reasons.length ||
    capture.inputConvention !== convention ||
    capture.modelCoverage !== 'single' ||
    !model
  )
    return result();
  const validPrompt = (
    r: Pick<RequestUsage, 'inputTokens' | 'cacheReadTokens' | 'cacheCreationTokens'>,
  ) =>
    [r.inputTokens, r.cacheReadTokens, r.cacheCreationTokens].every(count) &&
    (!opts.inputIncludesCache || r.inputTokens >= r.cacheReadTokens + r.cacheCreationTokens);
  if (!validPrompt(raw)) return result();
  const prompt = (
    r: Pick<RequestUsage, 'inputTokens' | 'cacheReadTokens' | 'cacheCreationTokens'>,
  ) => r.inputTokens + (opts.inputIncludesCache ? 0 : r.cacheReadTokens + r.cacheCreationTokens);
  const selected = (tokens: number) => {
    let aboveTokens: number | null = null;
    let price: BasePriceRates = rates;
    for (const t of rates.tiers ?? []) {
      if (t.inclusive ? tokens >= t.aboveTokens : tokens > t.aboveTokens) {
        aboveTokens = t.aboveTokens;
        price = t;
      }
    }
    return { aboveTokens, price };
  };
  const nativeBuckets = (
    r: Pick<
      RequestUsage,
      'inputTokens' | 'cacheReadTokens' | 'cacheCreationTokens' | 'outputTokens'
    >,
  ): Buckets => ({
    input:
      r.inputTokens - (opts.inputIncludesCache ? r.cacheReadTokens + r.cacheCreationTokens : 0),
    output: r.outputTokens ?? 0,
    cacheRead: r.cacheReadTokens,
    cacheWrite: r.cacheCreationTokens,
  });
  const rateBuckets = (p: BasePriceRates, hour = opts.cacheTtl === '1h'): BucketRates => ({
    input: p.inputRate,
    output: p.outputRate,
    cacheRead: p.cacheReadRate,
    cacheWrite: hour ? p.cacheWrite1hRate : p.cacheWriteRate,
  });
  const priced = (tokens: Buckets, price: BucketRates): Buckets => {
    const out = zero();
    for (const key of Object.keys(out) as CostBucket[]) {
      if (tokens[key] === 0) continue;
      const rate = price[key];
      if (rate === null || !Number.isFinite(rate) || rate < 0) unpriced.add(key);
      else out[key] = tokens[key] * rate;
    }
    return out;
  };
  const add = (a: Buckets, b: Buckets) => {
    for (const k of Object.keys(a) as CostBucket[]) a[k] += b[k];
  };
  const ttlKnown = (r: UnobservedSameModelUsage) =>
    r.cacheCreationTokens === 0 ||
    (count(r.cacheCreation5mTokens) &&
      count(r.cacheCreation1hTokens) &&
      r.cacheCreation5mTokens + r.cacheCreation1hTokens === r.cacheCreationTokens);
  const priceRequest = (r: UnobservedSameModelUsage, p: BasePriceRates) => {
    const b = nativeBuckets(r);
    b.cacheWrite = 0;
    const out = priced(b, rateBuckets(p));
    if (r.cacheCreationTokens > 0) {
      out.cacheWrite =
        priced({ ...zero(), cacheWrite: r.cacheCreation5mTokens! }, rateBuckets(p, false))
          .cacheWrite +
        priced({ ...zero(), cacheWrite: r.cacheCreation1hTokens! }, rateBuckets(p, true))
          .cacheWrite;
    }
    return out;
  };
  const excess = capture.unobservedSameModel ?? [];
  if (
    excess.some(
      (r) =>
        canonicalModelKey(r.model) !== model ||
        !validPrompt(r) ||
        !count(r.outputTokens) ||
        !ttlKnown(r),
    )
  )
    return result();
  const requests = capture.requests;
  if (requests !== null) {
    if (
      !requests.length ||
      capture.requestCount !== requests.length ||
      new Set(requests.map((r) => r.requestId)).size !== requests.length ||
      requests.some(
        (r) =>
          !r.requestId ||
          canonicalModelKey(r.model) !== model ||
          !validPrompt(r) ||
          (r.outputTokens !== null && !count(r.outputTokens)) ||
          !ttlKnown(r),
      )
    )
      return result();
    for (const key of ['inputTokens', 'cacheReadTokens', 'cacheCreationTokens'] as const) {
      if (requests.reduce((n, r) => n + r[key], 0) !== raw[key]) return result();
    }
    const knownOutput = requests.reduce((n, r) => n + (r.outputTokens ?? 0), 0);
    const unknownOutput = requests.filter((r) => r.outputTokens === null);
    if (
      knownOutput > raw.outputTokens ||
      (!unknownOutput.length && knownOutput !== raw.outputTokens)
    )
      return result();
    const total = zero();
    for (const r of requests) {
      const { aboveTokens, price } = selected(prompt(r));
      const cost = priceRequest(r, price);
      add(total, cost);
      let split = tier.split.find((s) => s.aboveTokens === aboveTokens);
      if (!split) {
        split = {
          aboveTokens,
          requests: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          costUsd: 0,
        };
        tier.split.push(split);
      }
      split.requests++;
      split.inputTokens += r.inputTokens;
      split.outputTokens += r.outputTokens ?? 0;
      split.cacheReadTokens += r.cacheReadTokens;
      split.cacheCreationTokens += r.cacheCreationTokens;
      split.costUsd += sum(cost);
    }
    tier.split.sort((a, b) => (a.aboveTokens ?? -1) - (b.aboveTokens ?? -1));
    const remaining = raw.outputTokens - knownOutput;
    const outputRates = unknownOutput.map((r) => selected(prompt(r)).price.outputRate);
    if (remaining > 0 && outputRates.some((r) => r === null)) unpriced.add('output');
    const oneTier = tier.split.length === 1;
    if (!excess.length && (!unknownOutput.length || oneTier)) {
      if (remaining > 0 && !unpriced.has('output')) total.output += remaining * outputRates[0]!;
      if (oneTier) {
        tier.split[0]!.outputTokens = raw.outputTokens;
        tier.split[0]!.costUsd = sum(total);
      }
      tier.state = 'exact';
      return result(total);
    }
    let low = sum(total),
      high = low;
    if (remaining > 0 && !unpriced.has('output')) {
      low += remaining * Math.min(...(outputRates as number[]));
      high += remaining * Math.max(...(outputRates as number[]));
    }
    // A same-model ledger excess is aggregate usage outside the observed request
    // inventory. Even its output can belong to any tier; never borrow a main tier.
    for (const r of excess) {
      const costs = [rates, ...(rates.tiers ?? [])].map((p) => priceRequest(r, p));
      for (const k of ['input', 'output', 'cacheRead'] as const) {
        low += Math.min(...costs.map((b) => b[k]));
        high += Math.max(...costs.map((b) => b[k]));
      }
      // Different unobserved requests may write different TTLs at different tiers.
      // Bound each TTL independently, even when their rate ordering differs.
      for (const [tokens, key] of [
        [r.cacheCreation5mTokens!, 'cacheWriteRate'],
        [r.cacheCreation1hTokens!, 'cacheWrite1hRate'],
      ] as const) {
        if (!tokens) continue;
        const values = [rates, ...(rates.tiers ?? [])].map((p) => p[key]);
        if (values.some((rate) => rate === null)) unpriced.add('cacheWrite');
        else {
          low += tokens * Math.min(...(values as number[]));
          high += tokens * Math.max(...(values as number[]));
        }
      }
    }
    if (!unpriced.size) {
      tier.lowUsd = low;
      tier.highUsd = high;
    }
    return result(total);
  }
  // Aggregate-only proof must come from a reconciled, complete channel, with its
  // model explicitly identified. One observed message in a partial stream is insufficient.
  if (
    excess.length ||
    canonicalModelKey(capture.aggregateModel) !== model ||
    !count(capture.requestCount) ||
    capture.requestCount < 1 ||
    raw.cacheCreationTokens > 0
  )
    return result();
  const totalPrompt = prompt(raw);
  const possible = [
    rates,
    ...(rates.tiers ?? []).filter((t) =>
      t.inclusive ? totalPrompt >= t.aboveTokens : totalPrompt > t.aboveTokens,
    ),
  ];
  if (capture.requestCount === 1 || possible.length === 1) {
    const { aboveTokens, price } = selected(totalPrompt);
    const cost = priced(nativeBuckets(raw), rateBuckets(price));
    tier.state = 'exact';
    tier.split = [
      {
        aboveTokens,
        requests: capture.requestCount,
        inputTokens: raw.inputTokens,
        outputTokens: raw.outputTokens,
        cacheReadTokens: raw.cacheReadTokens,
        cacheCreationTokens: raw.cacheCreationTokens,
        costUsd: sum(cost),
      },
    ];
    return result(cost);
  }
  const tokens = nativeBuckets(raw);
  const low = zero(),
    high = zero();
  for (const k of Object.keys(tokens) as CostBucket[]) {
    if (!tokens[k]) continue;
    const values = possible.map((p) => rateBuckets(p)[k]);
    if (values.some((r) => r === null || !Number.isFinite(r) || r < 0)) unpriced.add(k);
    else {
      low[k] = tokens[k] * Math.min(...(values as number[]));
      high[k] = tokens[k] * Math.max(...(values as number[]));
    }
  }
  if (!unpriced.size) {
    tier.lowUsd = sum(low);
    tier.highUsd = sum(high);
  }
  return result();
}
