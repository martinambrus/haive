import { describe, expect, it } from 'vitest';
import { enrichStepsWithCliUsage } from '../src/routes/tasks/_helpers.js';

describe('enrichStepsWithCliUsage', () => {
  it('flags steps that dispatch a CLI and clears deterministic ones', () => {
    const steps = [
      { stepId: '07-phase-2-implement' }, // llm
      { stepId: '08c-code-review' }, // agentMining
      { stepId: '06c-dag-execute' }, // dagExecute
      { stepId: '01-worktree-setup' }, // deterministic
      { stepId: '09_6-skill-verification' }, // deterministic (provider-sensitive)
    ];
    const out = enrichStepsWithCliUsage(steps);
    expect(out.map((s) => s.usesCli)).toEqual([true, true, true, false, false]);
  });

  it('preserves the original step fields', () => {
    const [out] = enrichStepsWithCliUsage([{ stepId: '09-qa', extra: 42 }]);
    expect(out).toEqual({ stepId: '09-qa', extra: 42, usesCli: true });
  });
});
