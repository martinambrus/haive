import { describe, it, expect } from 'vitest';
import { planBuildStep } from './01-plan-build.js';
import { onboardingPlanBuildStep } from '../onboarding/10_8-plan-build.js';
import type { AgentMiningSelectArgs } from '../../step-definition.js';

const detected = {
  mode: 'from_repo',
  repositoryId: 'r',
  existingNodeCount: 0,
  hasRoot: false,
  kbFiles: [],
  brief: '',
  repoName: 'repo',
} as const;

describe('onboarding plan build is opt-in', () => {
  it('asks whether to build, defaulting to skip, and points at the Plan view', () => {
    const form = onboardingPlanBuildStep.form!({} as never, detected as never)!;
    const field = form.fields.find((f) => f.id === 'buildPlan');
    expect(field).toMatchObject({ type: 'radio', default: 'skip' });
    expect(form.description).toContain('tokens');
    expect(form.description).toContain('Build from the knowledge base');
  });

  it('dispatches no agent and applies nothing when skipped', async () => {
    const args = {
      ctx: {} as never,
      detected,
      formValues: { buildPlan: 'skip' },
      llmOutput: null,
    } as unknown as AgentMiningSelectArgs;
    expect(await onboardingPlanBuildStep.agentMining!.selectAgents(args)).toEqual([]);
    const out = await onboardingPlanBuildStep.apply(
      {} as never,
      {
        detected,
        formValues: { buildPlan: 'skip' },
      } as never,
    );
    expect(out).toMatchObject({ stopped: 'declined', nodeCount: 0, mirrorFiles: [] });
  });

  it('leaves the standalone plan_build form as the depth form', () => {
    const form = planBuildStep.form!({} as never, detected as never)!;
    expect(form.fields.map((f) => f.id)).toEqual(['depthBudget', 'breadthCap']);
  });
});
