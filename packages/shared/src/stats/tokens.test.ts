import { describe, expect, it } from 'vitest';
import { normalizeTokens, sumNormalizedTokens } from './tokens.js';

/** The two rows measured on the live install, verbatim. */
const CLAUDE = {
  provider: 'claude-code',
  inputTokens: 7_172,
  outputTokens: 8_638_590,
  cacheReadTokens: 172_352_411,
  cacheCreationTokens: 92_818_294,
};
const CODEX = {
  provider: 'codex',
  inputTokens: 88_345_977,
  outputTokens: 2_003_591,
  cacheReadTokens: 74_774_784,
  cacheCreationTokens: 0,
};

describe('normalizeTokens', () => {
  it('leaves an exclusive reporter alone', () => {
    // claude-code reports input WITHOUT the cache buckets, so fresh input is the raw figure.
    const n = normalizeTokens(CLAUDE);
    expect(n.freshInputTokens).toBe(7_172);
    expect(n.cacheHitRatio! * 100).toBeCloseTo(100.0, 1);
  });

  it('subtracts the cached prefix from an inclusive reporter', () => {
    // codex reports input INCLUSIVE of cache-read. This is the bug the module exists for:
    // 74,774,784 / 88,345,977 = 84.6% cached, not 45.8%.
    const n = normalizeTokens(CODEX);
    expect(n.freshInputTokens).toBe(88_345_977 - 74_774_784);
    expect(n.cacheHitRatio! * 100).toBeCloseTo(84.64, 2);

    const naive = CODEX.cacheReadTokens / (CODEX.inputTokens + CODEX.cacheReadTokens);
    expect(naive * 100).toBeCloseTo(45.84, 2);
    expect(n.cacheHitRatio).not.toBeCloseTo(naive, 3);
  });

  it('treats gemini as inclusive and every other provider as exclusive', () => {
    const row = { inputTokens: 100, outputTokens: 0, cacheReadTokens: 40, cacheCreationTokens: 0 };
    expect(normalizeTokens({ ...row, provider: 'gemini' }).freshInputTokens).toBe(60);
    expect(normalizeTokens({ ...row, provider: 'codex' }).freshInputTokens).toBe(60);
    for (const p of ['claude-code', 'zai', 'ollama', 'grok', 'openrouter', 'amp', 'muse']) {
      expect(normalizeTokens({ ...row, provider: p }).freshInputTokens).toBe(100);
    }
  });

  it('treats an unknown or missing provider as exclusive', () => {
    // The shape every provider but two uses. Guessing "inclusive" would invent cache hits
    // that were never reported; this direction only under-states the ratio.
    const row = { inputTokens: 100, outputTokens: 0, cacheReadTokens: 40, cacheCreationTokens: 0 };
    expect(normalizeTokens(row).freshInputTokens).toBe(100);
    expect(normalizeTokens({ ...row, provider: null }).freshInputTokens).toBe(100);
    expect(normalizeTokens({ ...row, provider: 'some-future-cli' }).freshInputTokens).toBe(100);
  });

  it('never reports negative fresh input', () => {
    // A partial usage record can report less input than cache-read; a negative here would
    // subtract from a cross-provider total.
    const n = normalizeTokens({
      provider: 'codex',
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 999,
      cacheCreationTokens: 0,
    });
    expect(n.freshInputTokens).toBe(0);
    expect(n.totalTokens).toBe(0 + 5 + 999 + 0);
  });

  it('reports no ratio rather than zero when there was no prompt side', () => {
    const n = normalizeTokens({
      provider: 'claude-code',
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });
    expect(n.cacheHitRatio).toBeNull();
    expect(n.cacheWriteShare).toBeNull();
    expect(n.totalTokens).toBe(0);
  });

  it('sees a re-written prefix that cacheHitRatio reports as a perfect hit', () => {
    // The whole reason cacheWriteShare exists. MEASURED on step 00-plan-sequence: 499 fan-out
    // agents, each averaging these figures. cacheHitRatio says 99.99% cached because cache
    // CREATION is not in its denominator — for a step writing 84k cache tokens per agent.
    const n = normalizeTokens({
      provider: 'claude-code',
      inputTokens: 2,
      outputTokens: 1_400,
      cacheReadTokens: 24_263,
      cacheCreationTokens: 84_305,
    });
    expect(n.cacheHitRatio! * 100).toBeCloseTo(99.99, 2);
    expect(n.cacheWriteShare! * 100).toBeCloseTo(77.65, 2);
  });

  it('reports a zero write share when nothing was re-written', () => {
    // Distinct from the null above: this cached traffic exists and was entirely reuse.
    const n = normalizeTokens({
      provider: 'claude-code',
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 900,
      cacheCreationTokens: 0,
    });
    expect(n.cacheWriteShare).toBe(0);
  });

  it('coerces missing, negative and non-finite counts to zero', () => {
    const n = normalizeTokens({
      provider: 'claude-code',
      inputTokens: Number.NaN,
      outputTokens: -5,
      cacheReadTokens: 100,
      cacheCreationTokens: Number.POSITIVE_INFINITY,
    });
    expect(n).toMatchObject({ freshInputTokens: 0, outputTokens: 0, cacheCreationTokens: 0 });
    expect(n.totalTokens).toBe(100);
  });
});

describe('sumNormalizedTokens', () => {
  it('normalises per provider BEFORE adding, not after', () => {
    // Summing raw fields first mixes two definitions of `input`, so the combined ratio would
    // be wrong even though each provider's own figures are right.
    const combined = sumNormalizedTokens([CLAUDE, CODEX]);
    expect(combined.freshInputTokens).toBe(7_172 + (88_345_977 - 74_774_784));
    expect(combined.cacheReadTokens).toBe(172_352_411 + 74_774_784);

    const wrong =
      combined.cacheReadTokens /
      (CLAUDE.inputTokens + CODEX.inputTokens + combined.cacheReadTokens);
    expect(combined.cacheHitRatio).not.toBeCloseTo(wrong, 3);
  });

  it('keeps the total equal to the sum of the parts', () => {
    const combined = sumNormalizedTokens([CLAUDE, CODEX]);
    const parts = [CLAUDE, CODEX].map(normalizeTokens);
    expect(combined.totalTokens).toBe(parts[0]!.totalTokens + parts[1]!.totalTokens);
  });

  it('reports no ratio for an empty set', () => {
    const combined = sumNormalizedTokens([]);
    expect(combined.totalTokens).toBe(0);
    expect(combined.cacheHitRatio).toBeNull();
    expect(combined.cacheWriteShare).toBeNull();
  });

  it('computes the write share off the summed buckets, not an average of shares', () => {
    // A per-row average would weight a tiny provider the same as a large one. CLAUDE carries
    // every cache-creation token here, so the combined share is its writes over the whole
    // cached side — well below its own 35.0%.
    const combined = sumNormalizedTokens([CLAUDE, CODEX]);
    const cachedSide = combined.cacheCreationTokens + combined.cacheReadTokens;
    expect(combined.cacheWriteShare).toBeCloseTo(combined.cacheCreationTokens / cachedSide, 12);
    expect(combined.cacheWriteShare!).toBeLessThan(normalizeTokens(CLAUDE).cacheWriteShare!);
  });
});

describe('unknown output tokens', () => {
  const base = {
    provider: 'claude-code',
    inputTokens: 10,
    cacheReadTokens: 20,
    cacheCreationTokens: 30,
  };

  it('keeps a null output null and counts the unknown runs', () => {
    const n = normalizeTokens({ ...base, outputTokens: null, outputUnknownRuns: 2 });
    expect(n.outputTokens).toBeNull();
    expect(n.outputUnknownRuns).toBe(2);
    expect(n.totalTokens).toBe(10 + 20 + 30);
  });

  it('counts no unknown runs when none were given', () => {
    expect(normalizeTokens({ ...base, outputTokens: 7 }).outputUnknownRuns).toBe(0);
  });

  it('sums the known rows and the unknown run counts', () => {
    const rows = [
      { ...base, outputTokens: null, outputUnknownRuns: 2 },
      { ...base, outputTokens: 500, outputUnknownRuns: 1 },
    ];
    const forward = sumNormalizedTokens(rows);
    expect(forward.outputTokens).toBe(500);
    expect(forward.outputUnknownRuns).toBe(3);
    expect(forward.totalTokens).toBe(2 * 60 + 500);
    expect(sumNormalizedTokens([...rows].reverse())).toEqual(forward);
  });

  it('is null only when every reporting row is unknown', () => {
    const n = sumNormalizedTokens([
      { ...base, outputTokens: null, outputUnknownRuns: 2 },
      { ...base, outputTokens: null, outputUnknownRuns: 1 },
    ]);
    expect(n.outputTokens).toBeNull();
    expect(n.outputUnknownRuns).toBe(3);
  });

  it('keeps an empty list and a known zero at zero', () => {
    const empty = sumNormalizedTokens([]);
    expect(empty.outputTokens).toBe(0);
    expect(empty.outputUnknownRuns).toBe(0);
    const zero = sumNormalizedTokens([{ ...base, outputTokens: 0, outputUnknownRuns: 0 }]);
    expect(zero.outputTokens).toBe(0);
    expect(zero.outputUnknownRuns).toBe(0);
  });
});
