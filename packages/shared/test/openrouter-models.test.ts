import { describe, expect, it } from 'vitest';
import { trimOpenRouterModels } from '../src/cli-providers/openrouter-models.js';

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
});
