import { TERSENESS_LEVELS } from '@haive/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// vi.mock's factory is hoisted above the imports, so the spy has to be created
// in a hoisted block too — a plain top-level const is not initialized yet.
const { get } = vi.hoisted(() => ({ get: vi.fn() }));

vi.mock('@haive/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@haive/shared')>();
  return { ...actual, configService: { ...actual.configService, get } };
});

const { augmentPromptWithTerseness } = await import('../src/step-engine/terseness-context.js');

const PROMPT = 'Do the thing.';

describe('augmentPromptWithTerseness', () => {
  beforeEach(() => get.mockReset());

  it('injects nothing at level off', async () => {
    get.mockResolvedValue('off');
    expect(await augmentPromptWithTerseness(PROMPT)).toBe(PROMPT);
  });

  it('appends a response-style directive at every other level', async () => {
    for (const level of TERSENESS_LEVELS.filter((l) => l !== 'off')) {
      get.mockResolvedValue(level);
      const out = await augmentPromptWithTerseness(PROMPT);
      expect(out.startsWith(PROMPT)).toBe(true);
      expect(out).toContain('## Response style');
    }
  });

  it('resolves every declared level to a defined directive', async () => {
    // Guards the next level added to TERSENESS_LEVELS: without a DIRECTIVES entry
    // it would silently render "undefined" into the prompt.
    for (const level of TERSENESS_LEVELS) {
      get.mockResolvedValue(level);
      expect(await augmentPromptWithTerseness(PROMPT)).not.toContain('undefined');
    }
  });

  it('falls back to full for an unset or unrecognised level', async () => {
    for (const raw of [null, undefined, '', 'medium']) {
      get.mockResolvedValue(raw);
      expect(await augmentPromptWithTerseness(PROMPT)).toContain('## Response style');
    }
  });
});
