import { describe, it, expect } from 'vitest';
import { parseConfigRecommendation, markRecommended } from './_gate1-recommendation.js';

describe('parseConfigRecommendation', () => {
  it('parses a fenced JSON recommendation', () => {
    const raw =
      'sure\n```json\n{"adversarialQaLevel":"enterprise","browserMode":"mcp","rationale":"auth"}\n```';
    expect(parseConfigRecommendation(raw)).toEqual({
      adversarialQaLevel: 'enterprise',
      browserMode: 'mcp',
    });
  });

  it('accepts an already-parsed object (bypass stub shape)', () => {
    expect(
      parseConfigRecommendation({ adversarialQaLevel: 'standard', browserMode: 'mcp' }),
    ).toEqual({ adversarialQaLevel: 'standard', browserMode: 'mcp' });
  });

  it('returns {} for null / garbage / missing fields', () => {
    expect(parseConfigRecommendation(null)).toEqual({});
    expect(parseConfigRecommendation('no json here')).toEqual({});
    expect(parseConfigRecommendation({ other: 1 })).toEqual({});
  });
});

describe('markRecommended', () => {
  const opts = [
    { value: 'none', label: 'None' },
    { value: 'standard', label: 'Standard' },
  ];

  it('tags the recommended option and uses it as the default', () => {
    const r = markRecommended(opts, 'standard', 'none');
    expect(r.default).toBe('standard');
    expect(r.options.find((o) => o.value === 'standard')!.label).toBe('Standard (recommended)');
    expect(r.options.find((o) => o.value === 'none')!.label).toBe('None');
  });

  it('ignores a recommendation that is not an available option (e.g. mcp without DDEV)', () => {
    const r = markRecommended(opts, 'mcp', 'none');
    expect(r.default).toBe('none');
    expect(r.options).toEqual(opts);
  });

  it('falls back to the static default when there is no recommendation', () => {
    const r = markRecommended(opts, undefined, 'none');
    expect(r.default).toBe('none');
    expect(r.options.some((o) => o.label.includes('(recommended)'))).toBe(false);
  });
});
