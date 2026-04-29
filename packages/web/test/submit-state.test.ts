import { describe, expect, it } from 'vitest';
import { shouldClearSubmitting } from '../src/lib/submit-state.js';

const step = (
  stepId: string,
  status: 'pending' | 'running' | 'waiting_form' | 'waiting_cli' | 'done' | 'failed' | 'skipped',
) => ({
  stepId,
  status,
});

describe('shouldClearSubmitting', () => {
  it('returns false when nothing is submitting', () => {
    expect(shouldClearSubmitting(null, [])).toBe(false);
    expect(shouldClearSubmitting(null, [step('s1', 'waiting_form')])).toBe(false);
  });

  it('keeps state while the submitted step is still waiting_form', () => {
    expect(shouldClearSubmitting('s1', [step('s1', 'waiting_form')])).toBe(false);
  });

  it('clears when the step transitions to running', () => {
    expect(shouldClearSubmitting('s1', [step('s1', 'running')])).toBe(true);
  });

  it('clears when the step transitions to waiting_cli', () => {
    expect(shouldClearSubmitting('s1', [step('s1', 'waiting_cli')])).toBe(true);
  });

  it('clears when the step transitions to done', () => {
    expect(shouldClearSubmitting('s1', [step('s1', 'done')])).toBe(true);
  });

  it('clears on failure so the retry button can take over', () => {
    expect(shouldClearSubmitting('s1', [step('s1', 'failed')])).toBe(true);
  });

  it('clears when the submitted step is no longer in the list', () => {
    expect(shouldClearSubmitting('s1', [])).toBe(true);
    expect(shouldClearSubmitting('s1', [step('s2', 'waiting_form')])).toBe(true);
  });

  it('only checks the matching step, ignores other waiting_form steps', () => {
    const steps = [step('s1', 'done'), step('s2', 'waiting_form')];
    expect(shouldClearSubmitting('s1', steps)).toBe(true);
  });
});
