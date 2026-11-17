import {
  canonicalModelKey,
  tierRatesFor,
  selectedPriceTier,
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
  if (capture?.parts !== undefined) {
    // Process totals are reconciliation data, never a new whole-run proof. Price
    // every leaf through the same rules, including its own refusal conditions.
    const parts = capture.parts;
    if (
      !parts.length ||
      parts.some((p) => p.tokenUsage === null) ||
      !(['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheCreationTokens'] as const).every(
        (key) => {
          const values = parts.map((p) => p.tokenUsage![key] ?? 0);
          const total = values.reduce((n, value) => n + value, 0);
          return values.every(count) && count(total) && total === raw[key];
        },
      )
    )
      return result();
    const total = zero();
    let exact = true;
    let bounded = true;
    let low = 0;
    let high = 0;
    for (const part of parts) {
      const cost = computeTieredCost(part.tokenUsage!, rates, {
        ...opts,
        requestUsage: part.usage,
      });
      const partExact = cost.tier?.state === 'exact' && !cost.unpricedBuckets.length;
      exact &&= partExact;
      for (const bucket of cost.unpricedBuckets) unpriced.add(bucket);
      for (const key of Object.keys(total) as CostBucket[]) total[key] += cost.perBucket[key];
      const partLow = partExact ? cost.costUsd : cost.tier?.lowUsd;
      const partHigh = partExact ? cost.costUsd : cost.tier?.highUsd;
      if (partLow === undefined || partHigh === undefined) bounded = false;
      else {
        low += partLow;
        high += partHigh;
      }
      for (const split of cost.tier?.split ?? []) {
        const existing = tier.split.find((s) => s.aboveTokens === split.aboveTokens);
        if (!existing) tier.split.push({ ...split });
        else {
          for (const key of [
            'requests',
            'inputTokens',
            'outputTokens',
            'cacheReadTokens',
            'cacheCreationTokens',
            'costUsd',
          ] as const)
            existing[key] += split[key];
        }
      }
    }
    tier.split.sort((a, b) => (a.aboveTokens ?? -1) - (b.aboveTokens ?? -1));
    if (exact) tier.state = 'exact';
    else if (bounded && !unpriced.size) {
      tier.lowUsd = low;
      tier.highUsd = high;
    }
    return result(total);
  }
  if (
    !capture ||
    ((capture.coverage !== 'complete' || capture.reasons.length > 0) && !capture.wholeRun) ||
    capture.reasons.some((r) =>
      ['result-count', 'recovered-completion', 'malformed-stream'].includes(r),
    ) ||
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
  const selected = (tokens: number) => ({
    aboveTokens: selectedPriceTier(rates, tokens)?.aboveTokens ?? null,
    price: tierRatesFor(rates, tokens),
  });
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
  const detailed = capture.coverage === 'complete' && capture.reasons.length === 0;
  const requests = detailed ? capture.requests : null;
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
    const outputTiers = new Set(unknownOutput.map((r) => selected(prompt(r)).aboveTokens));
    const fixedOutput = remaining === 0 || new Set(outputRates).size === 1;
    if (!excess.length && fixedOutput) {
      if (remaining > 0 && !unpriced.has('output')) total.output += remaining * outputRates[0]!;
      if (remaining > 0 && outputTiers.size === 1) {
        const split = tier.split.find((s) => s.aboveTokens === [...outputTiers][0])!;
        split.outputTokens += remaining;
        split.costUsd += remaining * (outputRates[0] ?? 0);
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
  // A structural whole-run proof can survive an unavailable per-request channel.
  // It cannot rescue a malformed, steered or recovered stream, nor ledger excess.
  const whole = capture.wholeRun;
  const aggregateModel = whole?.usage.model ?? capture.aggregateModel;
  const requestCount = whole ? whole.requestCount : capture.requestCount;
  const aggregateUsage: UnobservedSameModelUsage = whole?.usage ?? {
    ...raw,
    model: aggregateModel ?? null,
    cacheCreation5mTokens: raw.cacheCreationTokens === 0 ? 0 : null,
    cacheCreation1hTokens: raw.cacheCreationTokens === 0 ? 0 : null,
  };
  if (
    excess.length ||
    canonicalModelKey(aggregateModel) !== model ||
    (!whole && (!count(requestCount) || requestCount < 1)) ||
    (requestCount !== null && (!count(requestCount) || requestCount < 1)) ||
    !['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheCreationTokens'].every(
      (k) => aggregateUsage[k as keyof typeof raw] === raw[k as keyof typeof raw],
    )
  )
    return result();
  const totalPrompt = prompt(raw);
  const possible = [
    rates,
    ...(rates.tiers ?? []).filter((t) => selectedPriceTier({ ...rates, tiers: [t] }, totalPrompt)),
  ];
  // Only a base-only proof may fall back to the configured TTL, just like the
  // untiered path. Higher tiers and bounds still require the observed TTL split.
  const fallbackTtl = possible.length === 1 && !ttlKnown(aggregateUsage);
  if (!ttlKnown(aggregateUsage) && !fallbackTtl) return result();
  if (requestCount === 1 || possible.length === 1) {
    const { aboveTokens, price } = selected(totalPrompt);
    const cost = fallbackTtl
      ? priced(nativeBuckets(aggregateUsage), rateBuckets(price))
      : priceRequest(aggregateUsage, price);
    tier.state = 'exact';
    tier.split =
      requestCount === null
        ? []
        : [
            {
              aboveTokens,
              requests: requestCount,
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
    if (!tokens[k] || k === 'cacheWrite') continue;
    const values = possible.map((p) => rateBuckets(p)[k]);
    if (values.some((r) => r === null || !Number.isFinite(r) || r < 0)) unpriced.add(k);
    else {
      low[k] = tokens[k] * Math.min(...(values as number[]));
      high[k] = tokens[k] * Math.max(...(values as number[]));
    }
  }
  for (const [tokens, key] of [
    [aggregateUsage.cacheCreation5mTokens!, 'cacheWriteRate'],
    [aggregateUsage.cacheCreation1hTokens!, 'cacheWrite1hRate'],
  ] as const) {
    if (!tokens) continue;
    const values = possible.map((p) => p[key]);
    if (values.some((r) => r === null || !Number.isFinite(r) || r < 0)) unpriced.add('cacheWrite');
    else {
      low.cacheWrite += tokens * Math.min(...(values as number[]));
      high.cacheWrite += tokens * Math.max(...(values as number[]));
    }
  }
  if (!unpriced.size) {
    tier.lowUsd = sum(low);
    tier.highUsd = sum(high);
  }
  return result();
}
