import { describe, expect, it } from 'vitest';
import type { OpenRouterModelEntry } from './api-client';
import {
  isUnknownModel,
  optionLabel,
  pricePerMillion,
  visibleModelOptions,
} from './openrouter-model-options';

function model(over: Partial<OpenRouterModelEntry> & { id: string }): OpenRouterModelEntry {
  return {
    name: over.id,
    contextLength: 200_000,
    promptPrice: 0.000003,
    completionPrice: 0.000015,
    supportsReasoning: true,
    supportsTools: true,
    supportsImages: true,
    ...over,
  };
}

const CATALOG = [
  model({ id: 'anthropic/claude-opus-5', name: 'Anthropic: Claude Opus 5' }),
  model({ id: 'openai/gpt-5.6', name: 'OpenAI: GPT-5.6' }),
  model({ id: 'ibm-granite/granite-4.1-8b', name: 'IBM: Granite', supportsTools: false }),
];

describe('pricePerMillion', () => {
  it('renders per-million dollars from a per-token price', () => {
    expect(pricePerMillion(0.000003)).toBe('$3.00');
    expect(pricePerMillion(0.00001)).toBe('$10.00');
  });

  it('keeps three decimals for sub-dollar models', () => {
    expect(pricePerMillion(0.00000015)).toBe('$0.150');
  });

  it('renders a null price as unknown, NOT as 0', () => {
    // A displayed 0 reads as "free", which is the one wrong answer that costs money.
    expect(pricePerMillion(null)).toBe('?');
  });

  it('renders a genuine zero as free', () => {
    expect(pricePerMillion(0)).toBe('free');
  });
});

describe('optionLabel', () => {
  it('shows slug, context window and both prices', () => {
    expect(optionLabel(CATALOG[0]!)).toBe(
      'anthropic/claude-opus-5  (200k ctx, $3.00/$15.00 per M)',
    );
  });

  it('flags a model with no tool support as unusable', () => {
    expect(optionLabel(CATALOG[2]!)).toContain('[no tool support - unusable]');
  });

  it('tolerates a missing context length', () => {
    expect(optionLabel(model({ id: 'v/x', contextLength: null }))).toContain('(? ctx');
  });
});

describe('visibleModelOptions', () => {
  it('returns everything when the filter is empty', () => {
    expect(visibleModelOptions(CATALOG, '', '').map((m) => m.id)).toEqual([
      'anthropic/claude-opus-5',
      'openai/gpt-5.6',
      'ibm-granite/granite-4.1-8b',
    ]);
  });

  it('filters on the slug and on the display name', () => {
    expect(visibleModelOptions(CATALOG, 'gpt', '').map((m) => m.id)).toEqual(['openai/gpt-5.6']);
    expect(visibleModelOptions(CATALOG, 'anthropic:', '').map((m) => m.id)).toEqual([
      'anthropic/claude-opus-5',
    ]);
  });

  it('KEEPS the saved model even when the filter excludes it', () => {
    // Otherwise typing in the filter box drops the current value out of the select,
    // the select falls back to another option, and saving silently rewrites the
    // provider's model.
    const out = visibleModelOptions(CATALOG, 'gpt', 'anthropic/claude-opus-5');
    expect(out.map((m) => m.id)).toEqual(['anthropic/claude-opus-5', 'openai/gpt-5.6']);
  });

  it('does not duplicate the saved model when the filter already matches it', () => {
    const out = visibleModelOptions(CATALOG, 'opus', 'anthropic/claude-opus-5');
    expect(out.map((m) => m.id)).toEqual(['anthropic/claude-opus-5']);
  });

  it('does not invent an option for a value absent from the catalog', () => {
    // The component renders that case as its own explicit "kept as saved" option.
    expect(visibleModelOptions(CATALOG, 'gpt', 'vendor/gone').map((m) => m.id)).toEqual([
      'openai/gpt-5.6',
    ]);
  });

  it('does not mutate the catalog it was given', () => {
    const before = CATALOG.map((m) => m.id);
    visibleModelOptions(CATALOG, '', 'anthropic/claude-opus-5');
    expect(CATALOG.map((m) => m.id)).toEqual(before);
  });
});

describe('isUnknownModel', () => {
  it('is false for an empty value and for a catalog member', () => {
    expect(isUnknownModel(CATALOG, '')).toBe(false);
    expect(isUnknownModel(CATALOG, 'openai/gpt-5.6')).toBe(false);
  });

  it('is true for a model the catalog no longer lists', () => {
    expect(isUnknownModel(CATALOG, 'vendor/retired')).toBe(true);
  });
});
