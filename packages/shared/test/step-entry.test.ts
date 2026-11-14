import { describe, expect, it } from 'vitest';
import * as step from '@haive/shared/step';

describe('public step entry', () => {
  it('exports only the seven runtime constructors', () => {
    expect(Object.keys(step).sort()).toEqual([
      'AdvisedStepError',
      'MiningRetryError',
      'MiningWaveError',
      'PromptBudgetExceededError',
      'ReopenStepFormError',
      'RetryableParseError',
      'TaskCancelledError',
    ]);
  });

  it('preserves the control signals and their payloads', () => {
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
    });
    expect(new step.ReopenStepFormError('Next batch', { notice: true }).notice).toBe(true);
  });
});
