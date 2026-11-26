import { describe, expect, it } from 'vitest';
import * as sdk from '@haive/shared/step';
import * as worker from '../src/step-engine/step-definition.js';

const constructors = [
  'TaskCancelledError',
  'AdvisedStepError',
  'RetryableParseError',
  'MiningRetryError',
  'MiningWaveError',
  'ReopenStepFormError',
  'PromptBudgetExceededError',
  'StepPrepareParkError',
  'StepPrepareDeferredError',
  'StepPrepareFormError',
] as const;

describe('step SDK compatibility', () => {
  it.each(constructors)('keeps the worker %s constructor identical to the public one', (name) => {
    expect(sdk[name]).toBeTypeOf('function');
    expect(worker[name]).toBe(sdk[name]);
  });
});
