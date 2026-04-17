import { describe, expect, it } from 'vitest';
import {
  buildAgentSpecFromLlm,
  type LlmCustomAgentBody,
} from '../src/step-engine/steps/onboarding/06_5-agent-discovery.js';

describe('buildAgentSpecFromLlm', () => {
  it('returns undefined for missing body', () => {
    expect(buildAgentSpecFromLlm('x', 'X', 'hint', undefined)).toBeUndefined();
  });

  it('falls back to defaults when fields are absent', () => {
    const spec = buildAgentSpecFromLlm(
      'graphql-resolver-dev',
      'GraphQL resolver',
      'writes resolvers',
      {},
    );
    expect(spec).toBeDefined();
    expect(spec!.id).toBe('graphql-resolver-dev');
    expect(spec!.title).toBe('GraphQL resolver');
    expect(spec!.description).toBe('writes resolvers');
    expect(spec!.color).toBe('purple');
    expect(spec!.field).toBe('custom');
    expect(spec!.tools).toEqual(['Read', 'Edit', 'Write', 'Grep', 'Glob', 'Bash']);
    expect(spec!.coreMission).toContain('GraphQL resolver');
    expect(spec!.responsibilities).toHaveLength(1);
    expect(spec!.whenInvoked).toHaveLength(1);
    expect(spec!.executionSteps).toHaveLength(1);
    expect(spec!.qualityCriteria).toHaveLength(1);
    expect(spec!.antiPatterns).toHaveLength(1);
  });

  it('title-cases the id when neither title nor label provided', () => {
    const spec = buildAgentSpecFromLlm('webhook_handler', '', '', {});
    expect(spec!.title).toBe('Webhook Handler');
  });

  it('accepts valid colors and rejects invalid ones', () => {
    const good = buildAgentSpecFromLlm('x', 'X', 'h', { color: 'green' });
    expect(good!.color).toBe('green');
    const bad = buildAgentSpecFromLlm('x', 'X', 'h', {
      color: 'rainbow' as unknown as LlmCustomAgentBody['color'],
    });
    expect(bad!.color).toBe('purple');
  });

  it('keeps a non-empty tools list and drops empties', () => {
    const spec = buildAgentSpecFromLlm('x', 'X', 'h', {
      tools: ['Read', '', 'Write', 42 as unknown as string],
    });
    expect(spec!.tools).toEqual(['Read', 'Write']);
  });

  it('ignores non-array tools field', () => {
    const spec = buildAgentSpecFromLlm('x', 'X', 'h', {
      tools: 'Read,Write' as unknown as string[],
    });
    expect(spec!.tools).toEqual(['Read', 'Edit', 'Write', 'Grep', 'Glob', 'Bash']);
  });

  it('filters execution steps missing title or body', () => {
    const spec = buildAgentSpecFromLlm('x', 'X', 'h', {
      executionSteps: [
        { title: 'Plan', body: 'Think before writing' },
        { title: '', body: 'orphan' },
        { title: 'orphan', body: '' },
        { title: 'Execute', body: 'Write code' },
      ],
    });
    expect(spec!.executionSteps).toEqual([
      { title: 'Plan', body: 'Think before writing' },
      { title: 'Execute', body: 'Write code' },
    ]);
  });

  it('uses fallback execution step when all entries invalid', () => {
    const spec = buildAgentSpecFromLlm('x', 'X', 'h', {
      executionSteps: [{ title: '', body: '' }],
    });
    expect(spec!.executionSteps).toHaveLength(1);
    expect(spec!.executionSteps[0]!.title).toBe('Execute the role');
  });

  it('trims text fields', () => {
    const spec = buildAgentSpecFromLlm('x', 'X', 'h', {
      title: '  Graph  ',
      field: '  graph  ',
      coreMission: '  mission  ',
      outputFormat: '  ```\nschema\n```  ',
    });
    expect(spec!.title).toBe('Graph');
    expect(spec!.field).toBe('graph');
    expect(spec!.coreMission).toBe('mission');
    expect(spec!.outputFormat).toBe('```\nschema\n```');
  });
});
