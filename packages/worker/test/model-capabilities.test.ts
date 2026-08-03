import { describe, expect, it } from 'vitest';
import {
  claudeFamilyOutputTokenEnv,
  MODEL_CAPABILITY_BOUNDARY_MARKER,
  nextModelLimits,
  resolveModelLimits,
  visionDisallowedTools,
  withModelCapabilityBoundary,
  type ModelLimits,
  type ProviderCapabilityView,
} from '../src/cli-adapters/model-capabilities.js';
import { MODEL_CAPABILITY_HEADLINES } from '../src/queues/cli-exec/failure-class.js';

const NOW = new Date('2026-08-03T10:00:00.000Z');

// The headlined messages interpretCliFailure writes — the only input the learn path reads.
const NO_VISION = `${MODEL_CAPABILITY_HEADLINES.no_image_support} — hint.`;
const OUTPUT_CAP = `${MODEL_CAPABILITY_HEADLINES.output_cap_reached} — hint.`;
const CEILING_REJECTED = `${MODEL_CAPABILITY_HEADLINES.max_tokens_too_large} — hint.`;

const view = (over: Partial<ProviderCapabilityView> = {}): ProviderCapabilityView => ({
  name: 'ollama',
  model: 'deepseek-v4-flash:cloud',
  modelLimits: null,
  ...over,
});

const learned = (over: Partial<ModelLimits> = {}): ModelLimits => ({
  model: 'deepseek-v4-flash:cloud',
  learnedAt: NOW.toISOString(),
  ...over,
});

describe('resolveModelLimits (model-keyed invalidation)', () => {
  it('returns the limits when they were learned for the current model', () => {
    expect(resolveModelLimits(view({ modelLimits: learned({ vision: false }) }))?.vision).toBe(
      false,
    );
  });

  it('ignores limits learned for a DIFFERENT model', () => {
    // The whole invalidation strategy: repointing a provider at another model must not
    // carry the old model's blindness onto it.
    expect(
      resolveModelLimits(view({ model: 'glm-5.2:cloud', modelLimits: learned({ vision: false }) })),
    ).toBeNull();
  });

  it('treats a provider with no model as the empty key', () => {
    const limits = learned({ model: '', vision: false });
    expect(resolveModelLimits(view({ model: null, modelLimits: limits }))?.vision).toBe(false);
    expect(
      resolveModelLimits(view({ model: null, modelLimits: learned({ vision: false }) })),
    ).toBeNull();
  });
});

describe('claudeFamilyOutputTokenEnv', () => {
  it('emits nothing for zai/ollama until something is learned', () => {
    expect(claudeFamilyOutputTokenEnv(view())).toEqual({});
    expect(claudeFamilyOutputTokenEnv(view({ name: 'zai', model: 'glm-4.6' }))).toEqual({});
  });

  it("preserves claude-code's pre-existing 128000 default", () => {
    expect(claudeFamilyOutputTokenEnv(view({ name: 'claude-code', model: null }))).toEqual({
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: '128000',
    });
  });

  it('prefers a learned ceiling over the adapter default', () => {
    const provider = view({
      name: 'claude-code',
      model: null,
      modelLimits: learned({ model: '', maxOutputTokens: 131072 }),
    });
    expect(claudeFamilyOutputTokenEnv(provider)).toEqual({
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: '131072',
    });
  });
});

describe('no-vision remedies', () => {
  it('are inert until the model is known to reject images', () => {
    expect(visionDisallowedTools(view())).toEqual([]);
    expect(withModelCapabilityBoundary('do the work', view())).toBe('do the work');
  });

  it('deny the screenshot tool and prepend the boundary once', () => {
    const provider = view({ modelLimits: learned({ vision: false }) });
    expect(visionDisallowedTools(provider)).toEqual(['mcp__chrome-devtools__take_screenshot']);
    const once = withModelCapabilityBoundary('do the work', provider);
    expect(once).toContain(MODEL_CAPABILITY_BOUNDARY_MARKER);
    expect(once).toContain('do the work');
    // Idempotent: the retry path re-adapts an already-adapted prompt.
    expect(withModelCapabilityBoundary(once, provider)).toBe(once);
  });
});

describe('nextModelLimits: no_image_support', () => {
  it('learns the flag once, then has nothing new to learn', () => {
    const first = nextModelLimits(view(), NO_VISION, NOW);
    expect(first).toMatchObject({ model: 'deepseek-v4-flash:cloud', vision: false });
    expect(nextModelLimits(view({ modelLimits: first! }), NO_VISION, NOW)).toBeNull();
  });

  it('drops a stale learn for another model instead of merging into it', () => {
    const stale = learned({ model: 'glm-5.2:cloud', maxOutputTokens: 131072 });
    const next = nextModelLimits(view({ modelLimits: stale }), NO_VISION, NOW);
    expect(next).toEqual({
      model: 'deepseek-v4-flash:cloud',
      learnedAt: NOW.toISOString(),
      vision: false,
    });
    expect(next).not.toHaveProperty('maxOutputTokens');
  });
});

describe('nextModelLimits: output-token ladder', () => {
  it('climbs 65536 -> 131072 -> exhausted', () => {
    const first = nextModelLimits(view(), OUTPUT_CAP, NOW);
    expect(first?.maxOutputTokens).toBe(65536);

    const second = nextModelLimits(view({ modelLimits: first! }), OUTPUT_CAP, NOW);
    expect(second?.maxOutputTokens).toBe(131072);

    const third = nextModelLimits(view({ modelLimits: second! }), OUTPUT_CAP, NOW);
    expect(third?.maxOutputTokensExhausted).toBe(true);

    // Terminal: no further learns once the ladder is spent.
    expect(nextModelLimits(view({ modelLimits: third! }), OUTPUT_CAP, NOW)).toBeNull();
  });

  it('never downgrades an adapter that already declares a higher default', () => {
    // claude-code sits at 128000, so the first rung it can earn is 131072, not 65536.
    const next = nextModelLimits(view({ name: 'claude-code', model: null }), OUTPUT_CAP, NOW);
    expect(next?.maxOutputTokens).toBe(131072);
  });

  it('preserves an existing vision learn while climbing', () => {
    const blind = learned({ vision: false });
    const next = nextModelLimits(view({ modelLimits: blind }), OUTPUT_CAP, NOW);
    expect(next).toMatchObject({ vision: false, maxOutputTokens: 65536 });
  });
});

describe('nextModelLimits: rejected-ceiling rollback', () => {
  it('steps back one rung and stops raising', () => {
    const atTop = learned({ maxOutputTokens: 131072 });
    const rolled = nextModelLimits(view({ modelLimits: atTop }), CEILING_REJECTED, NOW);
    expect(rolled).toMatchObject({ maxOutputTokens: 65536, maxOutputTokensExhausted: true });
  });

  it('drops our ceiling entirely when the FIRST rung was rejected', () => {
    const atBottom = learned({ maxOutputTokens: 65536 });
    const rolled = nextModelLimits(view({ modelLimits: atBottom }), CEILING_REJECTED, NOW);
    expect(rolled).not.toHaveProperty('maxOutputTokens');
    expect(rolled?.maxOutputTokensExhausted).toBe(true);
  });

  it('leaves a user-set ceiling alone but stops raising', () => {
    // Nothing learned: the rejected value came from the provider's own envVars.
    const rolled = nextModelLimits(view(), CEILING_REJECTED, NOW);
    expect(rolled).not.toHaveProperty('maxOutputTokens');
    expect(rolled?.maxOutputTokensExhausted).toBe(true);
    // Already recorded — nothing new to learn on a repeat.
    expect(nextModelLimits(view({ modelLimits: rolled! }), CEILING_REJECTED, NOW)).toBeNull();
  });
});

describe('nextModelLimits: non-capability messages', () => {
  it.each([null, '', 'cli invocation failed: TypeError', 'CLI authentication failed — ...'])(
    'learns nothing from %s',
    (msg) => {
      expect(nextModelLimits(view(), msg, NOW)).toBeNull();
    },
  );
});
