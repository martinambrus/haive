import { afterEach, expect, it, vi } from 'vitest';
import { TEST_PROMPT_ROLE, withTestPromptRole } from './support/prompt-role.js';
import type { TypeDraftDetect } from '../src/step-engine/steps/type-draft/_type-draft.js';

const detected: TypeDraftDetect = {
  steps: [],
  personas: [],
  takenSlugs: [],
  transcript: [],
  pendingQuestion: null,
  currentDraft: null,
  repairPending: null,
};

afterEach(() => {
  vi.doUnmock('@haive/shared/step-outputs');
  vi.resetModules();
});

it.each([false, true])(
  'derives creator provider guidance from the registry (eligible: %s)',
  async (eligible) => {
    vi.doMock('@haive/shared/step-outputs', async (original) => {
      const actual = await original<typeof import('@haive/shared/step-outputs')>();
      return eligible ? withTestPromptRole(actual) : actual;
    });
    const { buildDraftPrompt } = await import('../src/step-engine/steps/type-draft/_type-draft.js');
    const prompt = buildDraftPrompt(detected);
    const guidance = prompt
      .split('\n')
      .find((line) => /Providable roles:|No registered role/.test(line));
    expect(guidance).toBe(
      eligible
        ? `    Providable roles: ${TEST_PROMPT_ROLE}.`
        : '    No registered role is providable by a prompt step.',
    );
    expect(prompt).not.toMatch(/\bPR\d/);
  },
);
