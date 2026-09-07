import { describe, expect, it } from 'vitest';
import { computeDegradedNote } from '../src/step-engine/step-runner.js';
import type { StepDefinition } from '../src/step-engine/step-definition.js';

// The amber "succeeded, with caveats" panel on a step card. Two producers now: this function
// INFERRING a degraded run from the model's own provenance, and a step STATING one.

const llmStep = { llm: {} } as unknown as StepDefinition;
const deterministicStep = {} as unknown as StepDefinition;

describe('computeDegradedNote — inferred from provenance', () => {
  it('flags a stub/salvage/fallback source once the model actually produced output', () => {
    for (const source of ['stub', 'salvage', 'fallback']) {
      expect(computeDegradedNote(llmStep, 'raw text', undefined, { source })).toContain(
        `source: ${source}`,
      );
    }
    expect(computeDegradedNote(llmStep, 'raw text', undefined, { degraded: true })).toContain(
      'deterministic fallback',
    );
  });

  it('stays silent for a healthy step, a skipped LLM, and a step with no LLM at all', () => {
    expect(computeDegradedNote(llmStep, 'raw text', undefined, { source: 'parsed' })).toBeNull();
    expect(computeDegradedNote(llmStep, '', undefined, { source: 'stub' })).toBeNull();
    expect(computeDegradedNote(deterministicStep, 'raw', undefined, { source: 'stub' })).toBeNull();
  });
});

describe('computeDegradedNote — stated by the step', () => {
  // 08b's "the test runner enumerated nothing" is about the RUNNER, not about any AI output, so
  // it must not have to satisfy the provenance preconditions above — including on a step whose
  // LLM was skipped, or one that has none.
  it('uses an explicit note verbatim, whatever the model did', () => {
    const note = 'The playwright runner could not enumerate any of the tests this step wrote.';
    expect(computeDegradedNote(llmStep, 'raw text', undefined, { degradedNote: note })).toBe(note);
    expect(computeDegradedNote(llmStep, '', undefined, { degradedNote: note })).toBe(note);
    expect(computeDegradedNote(deterministicStep, null, undefined, { degradedNote: note })).toBe(
      note,
    );
  });

  it('outranks the inferred text when a step sets both', () => {
    expect(
      computeDegradedNote(llmStep, 'raw text', undefined, {
        source: 'stub',
        degradedNote: 'the runner never started',
      }),
    ).toBe('the runner never started');
  });

  // The field is optional on every apply output, so absent and blank must both fall through to
  // the inference rather than rendering an empty amber panel.
  it('ignores an absent or blank note', () => {
    expect(computeDegradedNote(llmStep, 'raw text', undefined, { degradedNote: '   ' })).toBeNull();
    expect(computeDegradedNote(llmStep, 'raw text', undefined, {})).toBeNull();
    expect(computeDegradedNote(llmStep, 'raw text', undefined, null)).toBeNull();
  });
});
