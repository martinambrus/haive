import { describe, it, expect, afterEach } from 'vitest';
import { PLAN_AGENT_TIMEOUT_MS, planBuildStep } from './01-plan-build.js';
import type { AgentMiningSelectArgs } from '../../step-definition.js';
import { shouldRetryMiningTerminalFailure } from '../../mining-failure.js';

/**
 * The CI onboarding smoke wedged here once: it runs the full registered step
 * list under HAIVE_TEST_BYPASS_LLM, and a mining dispatch enqueued a real CLI
 * nobody served — the step parked waiting_cli forever and the smoke timed out.
 * This pins the guard 09_5 and the other mining onboarding steps already carry.
 */

const args = {
  ctx: {} as never,
  detected: { repositoryId: 'r', mode: 'from_repo' },
  formValues: {},
  llmOutput: null,
} as unknown as AgentMiningSelectArgs;

describe('plan-build selectAgents under smoke bypass', () => {
  const orig = process.env.HAIVE_TEST_BYPASS_LLM;
  afterEach(() => {
    if (orig === undefined) delete process.env.HAIVE_TEST_BYPASS_LLM;
    else process.env.HAIVE_TEST_BYPASS_LLM = orig;
  });

  it('dispatches nothing under HAIVE_TEST_BYPASS_LLM=1', async () => {
    process.env.HAIVE_TEST_BYPASS_LLM = '1';
    const spec = planBuildStep.agentMining!;
    // No db/ctx touch may even happen before the guard: the smoke's ctx is bare.
    expect(await spec.selectAgents(args)).toEqual([]);
  });

  it('opts into per-terminal transient failure retries', () => {
    expect(planBuildStep.agentMining?.timeoutMs).toBe(PLAN_AGENT_TIMEOUT_MS);
    expect(PLAN_AGENT_TIMEOUT_MS).toBe(60 * 60 * 1000);
    expect(planBuildStep.agentMining?.retry).toEqual({
      maxAttempts: 2,
      retryOnInvocationFailure: shouldRetryMiningTerminalFailure,
    });
  });
});
