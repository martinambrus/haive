import { describe, it, expect } from 'vitest';
import { secretSweepStep } from '../src/step-engine/steps/onboarding/07_7-secret-sweep.js';
import type { LlmBuildArgs } from '../src/step-engine/step-definition.js';

// Three runs of this sweep over byte-identical repos disagreed twice, and both
// disagreements trace to the prompt rather than to the model:
//   endpoint shared-secret:  found / MISSED / found
//   account passwords:       HIGH  / MEDIUM / HIGH
// The first class was never enumerated, and the severity table said "scoped to
// development" without saying whether that means the credential's reach or the
// directory it sits in — while the paragraph above it already ruled on exactly that.
const prompt = (): string =>
  secretSweepStep.llm!.buildPrompt({
    detected: { repoPath: '/repo', scannable: true },
    formValues: {},
  } as unknown as LlmBuildArgs);

describe('secret sweep prompt', () => {
  it('counts a shared secret that is not credential-shaped', () => {
    const p = prompt();
    expect(p).toMatch(/A SHARED SECRET counts even when it does not look like a credential/);
    expect(p).toMatch(/URL path segment guarding an unauthenticated endpoint/);
    expect(p).toMatch(/Judge by what the string GUARDS/);
  });

  // The rubric must not contradict the inversion note that precedes it.
  it('defines development-scoped by reach, not by directory', () => {
    const p = prompt();
    expect(p).toMatch(/"Scoped to development" is about REACH/);
    expect(p).toMatch(/not development-scoped because it lives under a tests folder/);
    expect(p).toMatch(/- medium: a committed secret whose REACH is a local\/dev-only service/);
  });

  it('keeps the inversion that puts tests and fixtures in scope', () => {
    expect(prompt()).toMatch(/live at the provider whatever directory/);
  });

  // Unchanged, and load-bearing: the report is stored, so it must never carry the value.
  it('still forbids quoting the secret', () => {
    expect(prompt()).toMatch(/NEVER put the secret itself in your output/);
  });

  it('still welcomes an empty result rather than padding', () => {
    expect(prompt()).toMatch(/Finding nothing is a normal and welcome result/);
  });
});
