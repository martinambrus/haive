import { describe, expect, it } from 'vitest';
import * as step from '@haive/shared/step';

describe('public step entry', () => {
  it('exports only the eight runtime constructors', () => {
    expect(Object.keys(step).sort()).toEqual([
      'AdvisedStepError',
      'MiningRetryError',
      'MiningWaveError',
      'PromptBudgetExceededError',
      'ReopenStepFormError',
      'RetryableParseError',
      'StepPrepareParkError',
      'TaskCancelledError',
    ]);
  });

  it('preserves the control signals and their payloads', () => {
    expect(new step.StepPrepareParkError()).toMatchObject({
      name: 'StepPrepareParkError',
      message: "another advance owns this step's live invocation",
    });
    expect(new step.StepPrepareParkError('live ledger attempt').message).toBe(
      'live ledger attempt',
    );
    expect(new step.TaskCancelledError()).toMatchObject({
      name: 'TaskCancelledError',
      message: 'task cancelled',
    });
    expect(new step.AdvisedStepError('failed', 'diagnosis', 'advice')).toMatchObject({
      name: 'AdvisedStepError',
      message: 'failed',
      diagnosis: 'diagnosis',
      advice: 'advice',
    });
    expect(new step.RetryableParseError('invalid output')).toMatchObject({
      name: 'RetryableParseError',
      message: 'invalid output',
    });
    expect(new step.MiningRetryError(['reviewer'])).toMatchObject({
      name: 'MiningRetryError',
      agentIds: ['reviewer'],
      message: 'agent output unusable, re-roll: reviewer',
    });
    const dispatches = [{ agentId: 'reviewer', agentTitle: null, prompt: 'Review' }];
    expect(new step.MiningWaveError(dispatches)).toMatchObject({
      name: 'MiningWaveError',
      dispatches,
      message: 'second mining wave requested: 1 agent(s)',
    });
    expect(new step.ReopenStepFormError()).toMatchObject({
      name: 'ReopenStepFormError',
      message: 'step has another decision to present',
      notice: false,
      newAttempt: false,
    });
    expect(new step.ReopenStepFormError('Next batch', { notice: true }).notice).toBe(true);
  });

  it.each([
    { label: 'omitted', options: undefined, expected: false },
    { label: 'notice only', options: { notice: true }, expected: false },
    { label: 'explicit false', options: { newAttempt: false }, expected: false },
    { label: 'explicit true', options: { newAttempt: true }, expected: true },
  ])('reopen newAttempt is $expected for $label options', ({ options, expected }) => {
    expect(new step.ReopenStepFormError('Next batch', options)).toMatchObject({
      name: 'ReopenStepFormError',
      message: 'Next batch',
      newAttempt: expected,
      notice: options?.notice === true,
    });
  });
});
