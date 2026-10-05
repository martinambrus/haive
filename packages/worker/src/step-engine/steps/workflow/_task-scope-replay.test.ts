import { afterEach, describe, expect, it, vi } from 'vitest';
import { phase0b5SpecQualityStep } from './05-phase-0b5-spec-quality.js';
import { resolveSpecWarningsStep } from './05a-resolve-spec-warnings.js';
import { sprintPlanningStep } from './06b-sprint-planning.js';
import { phase2ImplementStep } from './07-phase-2-implement.js';
import { phase4ValidateStep } from './07b-phase-4-validate.js';
import { codeReviewStep } from './08c-code-review.js';
import { hydrateTaskBrief } from './_spec-artifact.js';
import type { StepContext } from '../../step-definition.js';

const REQUEST = 'Install admin_toolbar only. Preserve existing permissions.';
function context() {
  const findFirst = vi.fn(async () => ({ title: 'Install one module', description: REQUEST }));
  return {
    ctx: { db: { query: { tasks: { findFirst } } }, taskId: 'task' } as unknown as StepContext,
    findFirst,
  };
}
function parkedDetect() {
  return {
    spec: 'Install admin_toolbar and remove permissions',
    specSummary: '',
    sandboxWorkspacePath: '/haive/workdir',
    sandboxWorktreePath: '/haive/workdir',
    implementationFiles: { files: ['src/a.ts'], total: 1, truncated: false },
    dependencyPolicy: { drupal: false, drupalRoots: [], ownedPaths: [] },
    findings: [],
    gateFeedback: '',
    planOrdering: '',
    debtBlock: '',
    honoredBlock: '',
    fixContext: null,
    round: 0,
    browserTesting: false,
    level: 'none',
  };
}
afterEach(() => vi.unstubAllEnvs());

describe('task scope on replay before dispatch', () => {
  it.each([
    ['spec quality', phase0b5SpecQualityStep],
    ['spec correction', resolveSpecWarningsStep],
    ['sprint planning', sprintPlanningStep],
    ['implementation', phase2ImplementStep],
    ['validation', phase4ValidateStep],
  ] as const)('reloads the original brief for parked %s payloads', async (_name, step) => {
    const { ctx, findFirst } = context();
    const detected = parkedDetect();
    await step.llm!.prepare!({ ctx, detected, formValues: {} } as never);
    const prompt = step.llm!.buildPrompt({ detected, formValues: {} } as never);
    expect(findFirst).toHaveBeenCalledOnce();
    expect(prompt).toContain(REQUEST);
    expect(prompt).toContain('TASK AND OWNERSHIP BOUNDARY');
    expect(prompt).not.toContain('(not recorded');
  });

  it('rehydrates both validator and fixer prompts from the same old payload', async () => {
    const { ctx } = context();
    const detected = parkedDetect();
    await phase4ValidateStep.llm!.prepare!({ ctx, detected, formValues: {} } as never);
    for (const iteration of [1, 2]) {
      const prompt = phase4ValidateStep.loop!.buildIterationPrompt!({
        detected,
        iteration,
        previousIterations: [],
        formValues: {},
      });
      expect(prompt).toContain(REQUEST);
    }
  });

  it('reloads the original brief for every first-wave code reviewer', async () => {
    vi.stubEnv('HAIVE_TEST_BYPASS_LLM', '0');
    const { ctx, findFirst } = context();
    const agents = await codeReviewStep.agentMining!.selectAgents({
      ctx,
      detected: { ...parkedDetect(), level: 'enterprise' },
      formValues: {},
      llmOutput: null,
    });
    expect(findFirst).toHaveBeenCalledOnce();
    expect(agents).toHaveLength(5);
    for (const agent of agents) expect(agent.prompt).toContain(REQUEST);
  });

  it('keeps an already recorded brief without another lookup', async () => {
    const { ctx, findFirst } = context();
    const detected = { taskBrief: REQUEST };
    await hydrateTaskBrief(ctx, detected);
    expect(findFirst).not.toHaveBeenCalled();
    expect(detected.taskBrief).toBe(REQUEST);
  });

  it('does not dispatch a placeholder when the original task cannot be read', async () => {
    const { ctx, findFirst } = context();
    findFirst.mockRejectedValueOnce(new Error('database unavailable'));
    await expect(
      phase2ImplementStep.llm!.prepare!({ ctx, detected: parkedDetect(), formValues: {} } as never),
    ).rejects.toThrow('database unavailable');
  });
});
