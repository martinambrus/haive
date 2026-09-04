import { describe, expect, it } from 'vitest';
import { logger } from '@haive/shared';
import type { AgentMiningResult, StepContext } from '../../step-definition.js';
import { personasForDimensions, phase0aDiscoveryStep } from './03-phase-0a-discovery.js';
import type { AgentPersona } from './_agent-loader.js';
import { ALL_REVIEW_DIMENSION_IDS } from '@haive/shared/review';

const ctx = { logger: logger.child({ test: '03-discovery' }) } as unknown as StepContext;
const detected = {
  taskTitle: 'Improve dashboard filters',
  taskDescription: 'Add filtering controls to the dashboard.',
  feature: 'dashboard',
  kbSnippets: [{ id: 'architecture', title: 'Architecture', preview: 'Overview' }],
  personas: [],
};

function failed(errorMessage: string): AgentMiningResult {
  return {
    agentId: 'config-manager',
    agentTitle: 'Config Manager',
    status: 'failed',
    output: null,
    rawOutput: null,
    errorMessage,
  };
}

describe('phase0aDiscoveryStep terminal retry policy', () => {
  it('retries a dropped mid-response connection but not a persistent provider failure', () => {
    const retry = phase0aDiscoveryStep.agentMining?.retry;
    const retryOnFailure = retry?.retryOnInvocationFailure;

    expect(retry?.maxAttempts).toBe(3);
    expect(retryOnFailure).toBeDefined();
    expect(
      retryOnFailure!(
        failed('API Error: Connection closed mid-response. The response above may be incomplete.'),
      ),
    ).toBe(true);
    expect(
      retryOnFailure!(
        failed('Provider rate limit or quota exhausted — retry after the reset window.'),
      ),
    ).toBe(false);
  });

  it('keeps successful sibling mining when a terminal exhausts its retry budget', async () => {
    const output = await phase0aDiscoveryStep.apply(ctx, {
      detected,
      formValues: {},
      llmOutput: { selected: ['config-manager', 'frontend-specialist'] },
      agentMiningResults: [
        failed('API Error: Connection closed mid-response. The response above may be incomplete.'),
        {
          agentId: 'frontend-specialist',
          agentTitle: 'Frontend Specialist',
          status: 'done',
          output: { summary: 'Use the existing filter state.', relevantKbIds: ['architecture'] },
          rawOutput: null,
          errorMessage: null,
        },
      ],
      isFinalMiningAttempt: true,
    });

    expect(output.source).toBe('agents');
    expect(output.relevantKbIds).toEqual(['architecture']);
    expect(output.agentMinings).toHaveLength(2);
    expect(output.agentMinings[0]?.status).toBe('failed');
  });

  it('uses the deterministic stub after every miner has exhausted its retry budget', async () => {
    const output = await phase0aDiscoveryStep.apply(ctx, {
      detected,
      formValues: {},
      llmOutput: { selected: ['config-manager'] },
      agentMiningResults: [
        failed('API Error: Connection closed mid-response. The response above may be incomplete.'),
      ],
      isFinalMiningAttempt: true,
    });

    expect(output.source).toBe('stub');
    expect(output.relevantKbIds).toEqual(['architecture']);
    expect(output.agentMinings[0]?.status).toBe('failed');
  });
});

describe('03 discovery persona filtering by review dimension', () => {
  const persona = (id: string): AgentPersona =>
    ({
      id,
      title: id,
      description: '',
      field: null,
      color: null,
      allowedTools: [],
      body: '',
      sourcePath: `/x/${id}.md`,
    }) as AgentPersona;
  const all = [
    persona('knowledge-miner'),
    persona('accessibility-specialist'),
    persona('security-auditor'),
    persona('code-tracer'),
  ];

  it('offers every persona when no dimension is scoped out', () => {
    expect(personasForDimensions(all, [...ALL_REVIEW_DIMENSION_IDS]).map((p) => p.id)).toEqual(
      all.map((p) => p.id),
    );
  });

  it('drops a miner whose only dimension this repository does not review', () => {
    const kept = ALL_REVIEW_DIMENSION_IDS.filter((id) => id !== 'accessibility');
    const ids = personasForDimensions(all, [...kept]).map((p) => p.id);
    expect(ids).not.toContain('accessibility-specialist');
    // Everything else survives — this filter is narrow by design.
    expect(ids).toEqual(['knowledge-miner', 'security-auditor', 'code-tracer']);
  });

  it('leaves personas with no single owning dimension alone', () => {
    // 'testing' is an agent field, 'testability' is a dimension; they are different
    // vocabularies that only look alike, so nothing may key on the resemblance.
    const ids = personasForDimensions(all, ['security']).map((p) => p.id);
    expect(ids).toContain('knowledge-miner');
    expect(ids).toContain('code-tracer');
    expect(ids).toContain('security-auditor');
    expect(ids).not.toContain('accessibility-specialist');
  });
});
