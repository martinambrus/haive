import { describe, expect, it } from 'vitest';
import { appBootStep } from '../src/step-engine/steps/workflow/01a-app-boot.js';

describe('appBootStep preForm retry gate', () => {
  const gate = appBootStep.llm!.shouldRetryPreForm!;

  it('retries when the agent output has no usable run recipe (non-empty)', () => {
    expect(gate('cannot determine a run command, no json here')).toBe(true);
  });

  it('does not retry on empty output', () => {
    expect(gate('')).toBe(false);
    expect(gate(null)).toBe(false);
  });

  it('does not retry when a valid recipe parsed', () => {
    expect(gate('```json\n{"runCommand":"npm run dev","port":3000}\n```')).toBe(false);
  });
});
