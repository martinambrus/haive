import { describe, expect, it } from 'vitest';
import { trimOpenRouterModels } from '../src/cli-providers/openrouter-models.js';

import google from './fixtures/pricing/openrouter-google.json' with { type: 'json' };

// Shape taken from a real GET https://openrouter.ai/api/v1/models response.
const REAL_ENTRY = {
  id: 'anthropic/claude-opus-5-fast',
  name: 'Claude Opus 5 (Fast)',
  context_length: 1000000,
  architecture: {
    modality: 'text+image+file->text',
    input_modalities: ['text', 'image', 'file'],
  },
  pricing: {
    prompt: '0.00001',
    completion: '0.00005',
    input_cache_read: '0.000001',
    input_cache_write: '0.0000125',
    input_cache_write_1h: '0.00002',
  },
  supported_parameters: ['include_reasoning', 'max_tokens', 'reasoning', 'tools'],
};

describe('trimOpenRouterModels', () => {
  it('maps a real catalog entry onto the cached shape', () => {
    expect(trimOpenRouterModels({ data: [REAL_ENTRY] })).toEqual([
      {
        id: 'anthropic/claude-opus-5-fast',
        name: 'Claude Opus 5 (Fast)',
        contextLength: 1000000,
        promptPrice: 0.00001,
        completionPrice: 0.00005,
        cacheReadPrice: 0.000001,
        cacheWritePrice: 0.0000125,
        cacheWrite1hPrice: 0.00002,
        supportsReasoning: true,
        supportsTools: true,
        supportsImages: true,
      },
    ]);
  });

  it('reads capabilities off supported_parameters and input_modalities', () => {
    const [entry] = trimOpenRouterModels({
      data: [
        {
          id: 'vendor/text-only',
          supported_parameters: ['max_tokens'],
          architecture: { input_modalities: ['text'] },
        },
      ],
    });
    expect(entry).toMatchObject({
      supportsReasoning: false,
      supportsTools: false,
      supportsImages: false,
    });
  });

  it('defaults an ABSENT capability to false rather than advertising it', () => {
    // supportsTools decides whether a model is offered at all, so an unknown
    // capability must fail closed.
    const [entry] = trimOpenRouterModels({ data: [{ id: 'vendor/bare' }] });
    expect(entry).toMatchObject({
      supportsReasoning: false,
      supportsTools: false,
      supportsImages: false,
      contextLength: null,
    });
  });

  it('returns null for an unparseable price instead of 0', () => {
    // A displayed 0 reads as "free", which is the one wrong answer that costs money.
    const [entry] = trimOpenRouterModels({
      data: [{ id: 'vendor/x', pricing: { prompt: 'not-a-number', completion: '' } }],
    });
    expect(entry!.promptPrice).toBeNull();
    expect(entry!.completionPrice).toBeNull();
    // An absent cache price is null too, never 0 — same reason.
    expect(entry!.cacheReadPrice).toBeNull();
    expect(entry!.cacheWritePrice).toBeNull();
    expect(entry!.cacheWrite1hPrice).toBeNull();
  });

  it('accepts a numeric price as well as the upstream string form', () => {
    const [entry] = trimOpenRouterModels({
      data: [{ id: 'vendor/x', pricing: { prompt: 0.5, completion: 1.25 } }],
    });
    expect(entry).toMatchObject({ promptPrice: 0.5, completionPrice: 1.25 });
  });

  it('falls back to the slug when no display name is given', () => {
    const [entry] = trimOpenRouterModels({ data: [{ id: 'vendor/x', name: '   ' }] });
    expect(entry!.name).toBe('vendor/x');
  });

  it('skips entries with no usable id', () => {
    const out = trimOpenRouterModels({
      data: [{ id: '  ' }, { name: 'no id at all' }, { id: 'vendor/keep' }],
    });
    expect(out.map((m) => m.id)).toEqual(['vendor/keep']);
  });

  it('sorts by id so the picker does not reshuffle between refreshes', () => {
    const out = trimOpenRouterModels({
      data: [{ id: 'z/last' }, { id: 'a/first' }, { id: 'm/middle' }],
    });
    expect(out.map((m) => m.id)).toEqual(['a/first', 'm/middle', 'z/last']);
  });

  it('degrades to an empty list on a malformed payload rather than throwing', () => {
    expect(trimOpenRouterModels(null)).toEqual([]);
    expect(trimOpenRouterModels({})).toEqual([]);
    expect(trimOpenRouterModels({ data: 'nope' })).toEqual([]);
  });

  it('keeps the rest of the catalog when one entry has a non-object pricing value', () => {
    const out = trimOpenRouterModels({
      data: [
        { id: 'vendor/broken', pricing: 'free' },
        { id: 'vendor/numeric', pricing: 7 },
        { id: 'vendor/ok', pricing: { prompt: '0.000001', completion: '0.000002' } },
      ],
    });
    expect(out.map((m) => m.id)).toEqual(['vendor/broken', 'vendor/numeric', 'vendor/ok']);
    expect(out[0]!.promptPrice).toBeNull();
    expect(out[0]!.tiers).toBeUndefined();
    expect(out[2]!.promptPrice).toBe(0.000001);
  });
});

it('materializes the live Gemini override with non-text price keys', () => {
  const [model] = trimOpenRouterModels(google);
  expect(model!.pricingState).toBeUndefined();
  expect(model!.tiers).toEqual([
    {
      aboveTokens: 200000,
      inclusive: false,
      inputRate: 0.0000025,
      outputRate: 0.000015,
      cacheReadRate: 0.00000025,
      cacheWriteRate: 0.000000375,
      cacheWrite1hRate: null,
    },
  ]);
});
it('ignores only known override price fields, never an unknown condition', () => {
  const parse = (extra: Record<string, unknown>) =>
    trimOpenRouterModels({
      data: [
        {
          id: 'x',
          pricing: { prompt: '1', overrides: [{ min_prompt_tokens: 100, prompt: '2', ...extra }] },
        },
      ],
    })[0]!;
  expect(
    parse({
      audio: '3',
      audio_output: '4',
      input_audio_cache: '5',
      image: '6',
      image_output: '7',
      web_search: '8',
      internal_reasoning: '9',
    }).tiers,
  ).toHaveLength(1);
  expect(parse({ region: '1' }).pricingReason).toBe('unsupported-condition');
  expect(parse({ unknown_price: '1' }).pricingReason).toBe('unsupported-condition');
});

it('marks negative OpenRouter base and tier rates as variable-price', () => {
  for (const pricing of [
    { prompt: '-1', completion: '-1' },
    { prompt: '1', completion: '2', overrides: [{ min_prompt_tokens: 100, prompt: '-1' }] },
  ]) {
    const [model] = trimOpenRouterModels({ data: [{ id: 'openrouter/auto', pricing }] });
    expect(model).toMatchObject({ pricingState: 'unsupported', pricingReason: 'variable-price' });
    expect(model!.promptPrice).not.toBe(-1);
  }
});

it('treats null overrides as absent while refusing malformed overrides', () => {
  const parse = (overrides: unknown) =>
    trimOpenRouterModels({ data: [{ id: 'x', pricing: { prompt: '1', overrides } }] })[0]!;
  expect(parse(null).pricingState).toBeUndefined();
  expect(parse({}).pricingReason).toBe('invalid-tier');
});
