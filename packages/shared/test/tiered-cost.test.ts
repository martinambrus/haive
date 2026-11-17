import { describe, expect, it } from 'vitest';
import {
  computeInvocationCost,
  type ModelPriceRates,
  type PricedTokens,
} from '../src/cli-providers/model-pricing.js';
import type { RequestUsage, RequestUsageCapture } from '../src/cli-providers/request-usage.js';

const base = {
  inputRate: 1e-7,
  outputRate: 5e-7,
  cacheReadRate: 1e-8,
  cacheWriteRate: 1.25e-7,
  cacheWrite1hRate: 2e-7,
};
const rates: ModelPriceRates = {
  ...base,
  tiers: [
    {
      aboveTokens: 100_000,
      inclusive: false,
      inputRate: 5e-7,
      outputRate: 2.5e-6,
      cacheReadRate: 5e-8,
      cacheWriteRate: 6.25e-7,
      cacheWrite1hRate: 1e-6,
    },
  ],
};
const request = (
  id: string,
  inputTokens: number,
  outputTokens: number | null = 10,
): RequestUsage => ({
  requestId: id,
  turnId: null,
  model: 'model',
  inputTokens,
  outputTokens,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  cacheCreation5mTokens: 0,
  cacheCreation1hTokens: 0,
});
const capture = (requests: RequestUsage[], inclusive = false): RequestUsageCapture => ({
  requests,
  coverage: 'complete',
  inputConvention: inclusive ? 'inclusive' : 'exclusive',
  requestCount: requests.length,
  modelCoverage: 'single',
  reasons: [],
});
function compute(
  requests: RequestUsage[],
  output = requests.reduce((n, r) => n + (r.outputTokens ?? 0), 0),
  price = rates,
  inclusive = false,
) {
  const usage = requests.reduce(
    (s, r) => ({
      inputTokens: s.inputTokens + r.inputTokens,
      outputTokens: output,
      cacheReadTokens: (s.cacheReadTokens ?? 0) + r.cacheReadTokens,
      cacheCreationTokens: (s.cacheCreationTokens ?? 0) + r.cacheCreationTokens,
    }),
    { inputTokens: 0, outputTokens: output, cacheReadTokens: 0, cacheCreationTokens: 0 },
  );
  return computeInvocationCost(usage, price, {
    requestUsage: capture(requests, inclusive),
    modelKey: 'model',
    inputIncludesCache: inclusive,
  });
}

describe('tier-aware per-request arithmetic', () => {
  it.each([
    [100_000, null],
    [100_001, 100_000],
  ])('uses the Haiku strict boundary at %i', (tokens, threshold) => {
    const cost = compute([request('a', tokens)]);
    expect(cost.tier).toMatchObject({
      state: 'exact',
      split: [{ aboveTokens: threshold, requests: 1 }],
    });
    expect(cost.costUsd).toBeCloseTo(
      tokens * (threshold ? 5e-7 : 1e-7) + 10 * (threshold ? 2.5e-6 : 5e-7),
    );
  });
  it.each([true, false])('honours xAI inclusive=%s at 200,000', (inclusive) => {
    const p = { ...rates, tiers: [{ ...rates.tiers![0]!, aboveTokens: 200_000, inclusive }] };
    expect(compute([request('a', 200_000)], 10, p).tier?.split[0]?.aboveTokens).toBe(
      inclusive ? 200_000 : null,
    );
  });
  it('counts both cache buckets toward an exclusive prompt and prices both TTLs independently', () => {
    const r = {
      ...request('a', 1),
      cacheReadTokens: 99_990,
      cacheCreationTokens: 10,
      cacheCreation5mTokens: 4,
      cacheCreation1hTokens: 6,
    };
    const cost = compute([r]);
    expect(cost.costUsd).toBeCloseTo(5e-7 + 99_990 * 5e-8 + 4 * 6.25e-7 + 6e-6 + 10 * 2.5e-6);
    expect(cost.tier?.split[0]?.aboveTokens).toBe(100_000);
  });
  it('prices a Codex mixed-tier run exactly, subtracting inclusive caches once', () => {
    const a = { ...request('a', 100_000, 11), cacheReadTokens: 90_000 };
    const b = { ...request('b', 100_001, 29), cacheReadTokens: 80_000 };
    const cost = compute([a, b], 40, rates, true);
    expect(cost.tier?.state).toBe('exact');
    expect(cost.tier?.split).toHaveLength(2);
    expect(cost.costUsd).toBeCloseTo(
      10_000e-7 + 90_000e-8 + 11 * 5e-7 + 20_001 * 5e-7 + 80_000 * 5e-8 + 29 * 2.5e-6,
    );
  });
  it('keeps Claude mixed-tier input exact and bounds only unallocated output', () => {
    const cost = compute([request('a', 100_000, null), request('b', 100_001, null)], 40);
    expect(cost.tier?.state).toBe('unknown');
    expect(cost.costUsd).toBe(0);
    const input = 100_000e-7 + 100_001 * 5e-7;
    expect(cost.tier?.lowUsd).toBeCloseTo(input + 40 * 5e-7);
    expect(cost.tier?.highUsd).toBeCloseTo(input + 40 * 2.5e-6);
    expect(cost.perBucket.input).toBeCloseTo(input);
  });
  it('assigns Claude aggregate output exactly when every request is in one tier', () => {
    const cost = compute([request('a', 100_001, null), request('b', 100_010, null)], 40);
    expect(cost.tier?.state).toBe('exact');
    expect(cost.tier?.split[0]).toMatchObject({ requests: 2, outputTokens: 40 });
    expect(cost.costUsd).toBeCloseTo(200_011 * 5e-7 + 40 * 2.5e-6);
  });
  it('withholds bounds for missing rates, TTLs, coverage, model identity and contradictory totals', () => {
    const a = {
      ...request('a', 100_000, null),
      cacheCreationTokens: 2,
      cacheCreation5mTokens: 0,
      cacheCreation1hTokens: 2,
    };
    const p = { ...rates, tiers: [{ ...rates.tiers![0]!, cacheWrite1hRate: null }] };
    expect(compute([a], 40, p)).toMatchObject({
      unpricedBuckets: ['cacheWrite'],
      tier: { state: 'exact' },
    });
    expect(compute([a, request('b', 1, null)], 40, p).tier).not.toHaveProperty('lowUsd');
    expect(compute([{ ...a, cacheCreation1hTokens: null }], 40).tier).not.toHaveProperty('lowUsd');
    const usage = { inputTokens: 1, outputTokens: 1 };
    const good = capture([request('a', 1, 1)]);
    for (const requestUsage of [
      undefined,
      { ...good, coverage: 'incomplete' as const, reasons: ['result-count'] },
      { ...good, modelCoverage: 'mixed' as const },
      { ...good, requests: [request('a', 2, 1)] },
      { ...good, requests: [{ ...request('a', 1, 1), model: 'another' }] },
    ]) {
      const cost = computeInvocationCost(usage, rates, { requestUsage, modelKey: 'model' });
      expect(cost.tier).toEqual({ state: 'unknown', split: [] });
    }
  });
  it('does not use a steered or recovered aggregate as proof even below the first threshold', () => {
    for (const reason of ['result-count', 'recovered-completion', 'malformed-stream']) {
      const cost = computeInvocationCost({ inputTokens: 10, outputTokens: 1 }, rates, {
        modelKey: 'model',
        requestUsage: {
          ...capture([request('a', 10, 1)]),
          coverage: 'incomplete',
          reasons: [reason],
          wholeRun: { usage: request('proof', 10, 1), requestCount: 1 },
        },
      });
      expect(cost.tier).toEqual({ state: 'unknown', split: [] });
    }
  });
  it('never gives same-model ledger excess an observed request tier or invents its unknown usage', () => {
    const r = request('a', 1, 1);
    for (const extra of [
      { ...r, outputTokens: null },
      { ...r, cacheCreationTokens: 1, cacheCreation5mTokens: null, cacheCreation1hTokens: null },
    ]) {
      const cost = computeInvocationCost({ inputTokens: 1, outputTokens: 1 }, rates, {
        modelKey: 'model',
        requestUsage: { ...capture([r]), unobservedSameModel: [extra] },
      });
      expect(cost.tier).toEqual({ state: 'unknown', split: [] });
    }
    const cost = computeInvocationCost({ inputTokens: 1, outputTokens: 1 }, rates, {
      modelKey: 'model',
      requestUsage: {
        ...capture([r]),
        unobservedSameModel: [{ ...r, inputTokens: 0, outputTokens: 20 }],
      },
    });
    expect(cost.tier?.state).toBe('unknown');
    expect(cost.tier?.lowUsd).toBeCloseTo(1e-7 + 21 * 5e-7);
    expect(cost.tier?.highUsd).toBeCloseTo(1e-7 + 5e-7 + 20 * 2.5e-6);
  });
});

// Independent oracle: no call to the pricer or its tier selector. Enumerated
// requests are fully allocated; a required null rate means that allocation is unpriced.
function reference(rs: RequestUsage[], p: ModelPriceRates, inclusive = false): number | null {
  let total = 0;
  for (const r of rs) {
    const prompt = r.inputTokens + (inclusive ? 0 : r.cacheReadTokens + r.cacheCreationTokens);
    let chosen = p;
    for (const t of p.tiers ?? [])
      if (prompt > t.aboveTokens || (t.inclusive && prompt === t.aboveTokens)) chosen = t;
    const pairs = [
      [
        r.inputTokens - (inclusive ? r.cacheReadTokens + r.cacheCreationTokens : 0),
        chosen.inputRate,
      ],
      [r.outputTokens!, chosen.outputRate],
      [r.cacheReadTokens, chosen.cacheReadRate],
      [r.cacheCreation5mTokens!, chosen.cacheWriteRate],
      [r.cacheCreation1hTokens!, chosen.cacheWrite1hRate],
    ];
    for (const [tokens, rate] of pairs) {
      if (!tokens) continue;
      if (rate === null) return null;
      total += tokens! * rate!;
    }
  }
  return total;
}
const smallRates = (missing: boolean): ModelPriceRates => ({
  inputRate: 2,
  outputRate: 5,
  cacheReadRate: 1,
  cacheWriteRate: 3,
  cacheWrite1hRate: 4,
  tiers: [
    {
      aboveTokens: 2,
      inclusive: true,
      inputRate: 5,
      outputRate: 2,
      cacheReadRate: 3,
      cacheWriteRate: 1,
      cacheWrite1hRate: 8,
    },
    {
      aboveTokens: 4,
      inclusive: false,
      inputRate: 1,
      outputRate: missing ? null : 6,
      cacheReadRate: 2,
      cacheWriteRate: 7,
      cacheWrite1hRate: missing ? null : 2,
    },
  ],
});
function assertEnvelope(bound: ReturnType<typeof compute>, feasible: (number | null)[]) {
  if (feasible.includes(null)) {
    expect(bound.tier).not.toHaveProperty('lowUsd');
    expect(bound.costUsd).toBe(0);
    expect(bound.unpricedBuckets.length > 0 || bound.tier?.state === 'unknown').toBe(true);
  } else if (bound.tier?.state === 'exact') {
    for (const cost of feasible) expect(bound.costUsd).toBeCloseTo(cost!);
  } else {
    expect(bound.tier?.lowUsd).toEqual(expect.any(Number));
    expect(bound.tier?.highUsd).toEqual(expect.any(Number));
    for (const cost of feasible) {
      expect(cost!).toBeGreaterThanOrEqual(bound.tier!.lowUsd! - 1e-10);
      expect(cost!).toBeLessThanOrEqual(bound.tier!.highUsd! + 1e-10);
    }
  }
}
it('contains every output allocation with base tiers, both TTLs and conditionally reached null rates', () => {
  const seen = new Set<number | null>();
  let nullUnreached = 0,
    partiallyPriced = 0;
  for (const missing of [false, true])
    for (let input = 0; input <= 7; input++)
      for (let caches = 0; caches <= 2; caches++)
        for (let output = 0; output <= 4; output++) {
          const p = smallRates(missing);
          const rs = [
            request('a', input, null),
            { ...request('b', 0, null), cacheReadTokens: caches },
            {
              ...request('c', 1, null),
              cacheCreationTokens: caches,
              cacheCreation5mTokens: caches > 0 ? 1 : 0,
              cacheCreation1hTokens: Math.max(0, caches - 1),
            },
          ];
          for (const r of rs) {
            const prompt = r.inputTokens + r.cacheReadTokens + r.cacheCreationTokens;
            seen.add(prompt > 4 ? 4 : prompt >= 2 ? 2 : null);
          }
          const feasible: (number | null)[] = [];
          for (let a = 0; a <= output; a++)
            for (let b = 0; b <= output - a; b++)
              feasible.push(
                reference(
                  rs.map((r, i) => ({ ...r, outputTokens: [a, b, output - a - b][i]! })),
                  p,
                ),
              );
          const bound = compute(rs, output, p);
          assertEnvelope(bound, feasible);
          if (missing && !feasible.includes(null)) nullUnreached++;
          if (feasible.includes(null) && feasible.some((n) => n !== null)) partiallyPriced++;
        }
  expect(seen).toEqual(new Set([null, 2, 4]));
  expect(nullUnreached).toBeGreaterThan(0);
  expect(partiallyPriced).toBeGreaterThan(0);
});
it('bounds all aggregate input/cache/output allocations using an independent oracle, including reachable null tiers', () => {
  let pricedWithNullTier = 0,
    partiallyPriced = 0;
  for (const missing of [false, true])
    for (let input = 0; input <= 6; input++)
      for (let output = 0; output <= 3; output++)
        for (let cached = 0; cached <= Math.min(input, 2); cached++) {
          const p = smallRates(missing);
          const feasible: (number | null)[] = [];
          for (let a = 0; a <= input; a++)
            for (let read = 0; read <= cached; read++) {
              if (read > a || cached - read > input - a) continue;
              for (let out = 0; out <= output; out++)
                feasible.push(
                  reference(
                    [
                      { ...request('a', a, out), cacheReadTokens: read },
                      { ...request('b', input - a, output - out), cacheReadTokens: cached - read },
                    ],
                    p,
                    true,
                  ),
                );
            }
          const bound = computeInvocationCost(
            { inputTokens: input, cacheReadTokens: cached, outputTokens: output },
            p,
            {
              modelKey: 'model',
              inputIncludesCache: true,
              requestUsage: {
                ...capture([], true),
                requests: null,
                requestCount: 2,
                aggregateModel: 'model',
              },
            },
          );
          assertEnvelope(bound, feasible);
          if (missing && !feasible.includes(null)) pricedWithNullTier++;
          if (feasible.includes(null) && feasible.some((n) => n !== null)) partiallyPriced++;
        }
  expect(pricedWithNullTier).toBeGreaterThan(0);
  expect(partiallyPriced).toBeGreaterThan(0);
});

// Frozen arithmetic output captured before introducing the tier branch. Extra capture
// data must not alter the shape, key order, rounding or cache semantics of flat rates.
it('keeps untiered output byte-identical to the pre-change computation', () => {
  const usage: PricedTokens = {
    inputTokens: 1234,
    outputTokens: 23,
    cacheReadTokens: 400,
    cacheCreationTokens: 11,
  };
  const baseline =
    '{"costUsd":0.00010109999999999999,"perBucket":{"input":0.0000834,"output":0.0000115,"cacheRead":0.000004,"cacheWrite":0.0000022},"unpricedBuckets":[]}';
  // Use exact pre-change floating-point bytes, recorded separately with origin/main.
  const actual = computeInvocationCost(usage, base, {
    inputIncludesCache: true,
    cacheTtl: '1h',
    requestUsage: capture([request('a', 999)]),
  });
  expect(JSON.stringify(actual)).toBe(baseline);
});

it('bounds ledger excess with 5m and 1h writes allocated to different tiers', () => {
  const free = {
    inputRate: 0,
    outputRate: 0,
    cacheReadRate: 0,
    cacheWriteRate: 0,
    cacheWrite1hRate: 0,
  };
  const p = {
    ...free,
    tiers: [
      { ...free, aboveTokens: 2, inclusive: false, cacheWriteRate: 9, cacheWrite1hRate: 1 },
      { ...free, aboveTokens: 4, inclusive: false, cacheWriteRate: 1, cacheWrite1hRate: 9 },
    ],
  };
  const observed = request('main', 1, 0);
  const bound = computeInvocationCost({ inputTokens: 1, outputTokens: 0 }, p, {
    modelKey: 'model',
    requestUsage: {
      ...capture([observed]),
      unobservedSameModel: [
        {
          ...observed,
          inputTokens: 6,
          cacheCreationTokens: 6,
          cacheCreation5mTokens: 3,
          cacheCreation1hTokens: 3,
        },
      ],
    },
  });
  expect(bound.tier?.highUsd).toBe(54);
  for (let input = 0; input <= 6; input++)
    for (let five = 0; five <= 3; five++)
      for (let hour = 0; hour <= 3; hour++) {
        const rs = [
          {
            ...request('a', input, 0),
            cacheCreationTokens: five + hour,
            cacheCreation5mTokens: five,
            cacheCreation1hTokens: hour,
          },
          {
            ...request('b', 6 - input, 0),
            cacheCreationTokens: 6 - five - hour,
            cacheCreation5mTokens: 3 - five,
            cacheCreation1hTokens: 3 - hour,
          },
        ];
        const exact = compute(rs, 0, p);
        expect(exact.costUsd).toBeGreaterThanOrEqual(bound.tier!.lowUsd!);
        expect(exact.costUsd).toBeLessThanOrEqual(bound.tier!.highUsd!);
      }
});

it.each([
  [[request('a', 50000, 5), request('b', 100001, null)], 5],
  [[request('a', 50000, null), request('b', 100001, null)], 0],
  [[request('a', 50000, 5), request('b', 100001, null), request('c', 100002, null)], 12],
] as const)('takes the exact path when output allocation cannot change the cost', (rs, output) => {
  const cost = compute([...rs], output);
  const fixed = rs.reduce(
    (n, r) =>
      n +
      r.inputTokens * (r.inputTokens > 100000 ? 5e-7 : 1e-7) +
      (r.outputTokens ?? 0) * (r.inputTokens > 100000 ? 2.5e-6 : 5e-7),
    0,
  );
  const remaining = output - rs.reduce((n, r) => n + (r.outputTokens ?? 0), 0);
  expect(cost.tier?.state).toBe('exact');
  expect(cost.costUsd).toBeCloseTo(fixed + remaining * 2.5e-6);
  expect(cost.tier).not.toHaveProperty('lowUsd');
  expect(cost.tier!.split.reduce((n, s) => n + s.outputTokens, 0)).toBe(output);
});

it('prices fixed output rates across different tiers exactly without inventing an output allocation', () => {
  const p = { ...rates, tiers: [{ ...rates.tiers![0]!, outputRate: base.outputRate }] };
  const cost = compute([request('a', 50000, null), request('b', 100001, null)], 7, p);
  expect(cost.tier?.state).toBe('exact');
  expect(cost.costUsd).toBeCloseTo(50000e-7 + 100001 * 5e-7 + 7 * base.outputRate);
  expect(cost.tier!.split.map((s) => s.outputTokens)).toEqual([0, 0]);
});

it('prices whole-run cache writes by observed TTL and withholds bounds when a reachable TTL rate is null', () => {
  const whole = {
    ...request('proof', 1, 2),
    cacheReadTokens: 1,
    cacheCreationTokens: 2,
    cacheCreation5mTokens: 1,
    cacheCreation1hTokens: 1,
  };
  const run = (p: ModelPriceRates) =>
    computeInvocationCost(
      { inputTokens: 1, outputTokens: 2, cacheReadTokens: 1, cacheCreationTokens: 2 },
      p,
      {
        modelKey: 'model',
        requestUsage: {
          ...capture([], false),
          requests: null,
          coverage: 'incomplete',
          requestCount: null,
          reasons: ['prompt-mismatch'],
          wholeRun: { usage: whole, requestCount: null },
        },
      },
    );
  expect(run(rates).tier?.state).toBe('exact');
  expect(run(rates).costUsd).toBeCloseTo(1e-7 + 2 * 5e-7 + 1e-8 + 1.25e-7 + 2e-7, 14);
  const p = { ...rates, tiers: [{ ...rates.tiers![0]!, aboveTokens: 2, cacheWrite1hRate: null }] };
  const cost = run(p);
  expect(cost.tier?.state).toBe('unknown');
  expect(cost.unpricedBuckets).toContain('cacheWrite');
  expect(cost.tier).not.toHaveProperty('lowUsd');
});
