import { describe, it, expect } from 'vitest';
import { humanizeRequirementsStep } from './03b2-humanize-requirements.js';
import { RetryableParseError } from '../../step-definition.js';
import type { StepContext, StepApplyArgs } from '../../step-definition.js';

// Source draft deliberately missing diacritics (Slovak) — the humanizer's job.
const detected = {
  taskTitle: 'Add logout',
  sourceRequirements: '# Poziadavky\n\nPouzivatelia sa potrebuju odhlasit.',
  sourceSummary: 'logout',
};

const stubCtx = { logger: { info: () => {}, warn: () => {} } } as unknown as StepContext;

function applyArgs(llmOutput: unknown, isFinalLlmAttempt: boolean): StepApplyArgs<typeof detected> {
  return {
    detected,
    formValues: {},
    llmOutput,
    iteration: 0,
    previousIterations: [],
    isFinalLlmAttempt,
  };
}

describe('03b2 humanize form', () => {
  it('auto-submits with no decision and previews the source doc', () => {
    const schema = humanizeRequirementsStep.form!(stubCtx, detected);
    expect(schema!.autoSubmit).toBe(true);
    expect(schema!.fields).toHaveLength(0);
    expect(schema!.infoSections?.[0]?.body ?? '').toContain('Pouzivatelia');
  });
});

describe('03b2 humanize prompt', () => {
  it('preserves language, fixes diacritics, and includes the source requirements', () => {
    const prompt = humanizeRequirementsStep.llm!.buildPrompt({ detected, formValues: {} });
    expect(prompt).toContain('never translate');
    expect(prompt).toContain('diacritic');
    expect(prompt).toContain('Pouzivatelia sa potrebuju odhlasit.');
  });
});

describe('03b2 humanize apply', () => {
  it('stores the humanized doc when the agent returns valid JSON', async () => {
    const raw =
      '```json\n{"requirements":"# Požiadavky\\n\\nPoužívatelia sa potrebujú odhlásiť.","summary":"odhlásenie"}\n```';
    const out = await humanizeRequirementsStep.apply(stubCtx, applyArgs(raw, true));
    expect(out.source).toBe('llm');
    expect(out.requirements).toContain('Požiadavky');
  });

  it('passes the original draft through on the final attempt when output is unusable', async () => {
    const out = await humanizeRequirementsStep.apply(stubCtx, applyArgs('not json', true));
    expect(out.source).toBe('passthrough');
    expect(out.requirements).toBe(detected.sourceRequirements);
  });

  it('retries (throws RetryableParseError) on an unparseable non-final attempt', async () => {
    await expect(
      humanizeRequirementsStep.apply(stubCtx, applyArgs('not json', false)),
    ).rejects.toBeInstanceOf(RetryableParseError);
  });
});
