import { describe, it, expect } from 'vitest';
import { logger } from '@haive/shared';
import {
  parseAdversaryOutput,
  adversaryIdsForLevel,
  adversarialQaStep,
} from './08d-adversarial-qa.js';
import type { AgentMiningResult, StepContext } from '../../step-definition.js';

const fakeCtx = { logger: logger.child({ test: '08d-apply' }) } as unknown as StepContext;
function mining(agentId: string, rawOutput: string | null): AgentMiningResult {
  return {
    agentId,
    agentTitle: agentId,
    status: 'done',
    output: null,
    rawOutput,
    errorMessage: null,
  };
}

describe('adversaryIdsForLevel', () => {
  it('returns cumulative rosters of 2/4/6', () => {
    expect(adversaryIdsForLevel('poc')).toEqual(['edge-case-breaker', 'workflow-disruptor']);
    expect(adversaryIdsForLevel('standard')).toHaveLength(4);
    expect(adversaryIdsForLevel('enterprise')).toHaveLength(6);
    // cumulative: poc ⊂ standard ⊂ enterprise
    expect(adversaryIdsForLevel('standard').slice(0, 2)).toEqual(adversaryIdsForLevel('poc'));
    expect(adversaryIdsForLevel('enterprise').slice(0, 4)).toEqual(
      adversaryIdsForLevel('standard'),
    );
  });
});

describe('parseAdversaryOutput', () => {
  it('parses a fenced adversary report', () => {
    const raw =
      'attacked\n```json\n{"verdict":"FAIL","findings":[{"severity":"critical","category":"sqli","location":"q.php:5","poc":"1 OR 1=1","impact":"dump","fix":"param"}]}\n```';
    const f = parseAdversaryOutput(raw);
    expect(f).not.toBeNull();
    expect(f).toHaveLength(1);
    expect(f![0]!.severity).toBe('critical');
    expect(f![0]!.location).toBe('q.php:5');
  });

  it('accepts an already-parsed object and defaults findings', () => {
    expect(parseAdversaryOutput({ verdict: 'PASS' })).toEqual([]);
    expect(parseAdversaryOutput({ verdict: 'PASS', findings: [] })).toEqual([]);
  });

  it('returns null on garbled output', () => {
    expect(parseAdversaryOutput('no json')).toBeNull();
    expect(parseAdversaryOutput(null)).toBeNull();
  });
});

describe('adversarialQaStep.apply de-silence', () => {
  it('surfaces a qa-gap finding (not silent 0-findings) when an adversary ran but was unparseable', async () => {
    const out = await adversarialQaStep.apply(fakeCtx, {
      detected: { level: 'poc' },
      agentMiningResults: [
        mining('edge-case-breaker', 'I tried hard to break it but did not emit any json'),
      ],
    } as unknown as Parameters<typeof adversarialQaStep.apply>[1]);
    expect(out.ran).toBe(true);
    expect(out.findings.length).toBeGreaterThan(0);
    expect(out.findings.some((f) => f.category === 'qa-gap')).toBe(true);
  });
});
