import { describe, it, expect } from 'vitest';
import { logger, STEP_MINING_SEATS } from '@haive/shared';
import {
  parseAdversaryOutput,
  adversaryIdsForLevel,
  adversarialQaStep,
} from './08d-adversarial-qa.js';
import { MiningRetryError } from '../../step-definition.js';
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
/** An adversary DISPATCHED and killed before it finished — budget, orphan, preemption. */
function failedMining(agentId: string, errorMessage: string): AgentMiningResult {
  return {
    agentId,
    agentTitle: agentId,
    status: 'failed',
    output: null,
    rawOutput: null,
    errorMessage,
  };
}
const TIMEOUT_ERR = 'CLI process exceeded its time budget (45m).';

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

  it('parses its own report, not the payload it fenced as proof', () => {
    // An adversary's PoC is often itself JSON. Anchoring on the first fence parsed the
    // payload as the report, silently dropping a confirmed critical exploit.
    const raw = [
      'Payload used:',
      '```json',
      '{"input":"1 OR 1=1"}',
      '```',
      '```json',
      '{"verdict":"FAIL","findings":[{"severity":"critical","category":"sqli","location":"q.php:5","poc":"1 OR 1=1"}]}',
      '```',
    ].join('\n');
    const f = parseAdversaryOutput(raw);
    expect(f).toHaveLength(1);
    expect(f![0]!.severity).toBe('critical');
  });

  it('returns null on garbled output', () => {
    expect(parseAdversaryOutput('no json')).toBeNull();
    expect(parseAdversaryOutput(null)).toBeNull();
    // an object naming neither a verdict nor findings is not a report
    expect(parseAdversaryOutput('```json\n{"input":"1 OR 1=1"}\n```')).toBeNull();
  });
});

function runQa(results: AgentMiningResult[], isFinalMiningAttempt?: boolean) {
  return adversarialQaStep.apply(fakeCtx, {
    detected: { level: 'poc' },
    agentMiningResults: results,
    isFinalMiningAttempt,
  } as unknown as Parameters<typeof adversarialQaStep.apply>[1]);
}

describe('adversarialQaStep.apply de-silence', () => {
  it('surfaces a qa-gap finding (not silent 0-findings) once the re-roll budget is spent', async () => {
    const out = await runQa(
      [mining('edge-case-breaker', 'I tried hard to break it but did not emit any json')],
      true,
    );
    expect(out.ran).toBe(true);
    expect(out.findings.length).toBeGreaterThan(0);
    expect(out.findings.some((f) => f.category === 'qa-gap')).toBe(true);
  });

  it('re-rolls only the unreadable adversary while it still has budget', async () => {
    const err = await runQa(
      [
        mining('edge-case-breaker', 'prose, no json'),
        mining('workflow-disruptor', '```json\n{"verdict":"PASS","findings":[]}\n```'),
      ],
      false,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MiningRetryError);
    expect((err as MiningRetryError).agentIds).toEqual(['edge-case-breaker']);
  });

  it('does not throw when every adversary is readable', async () => {
    const out = await runQa(
      [mining('edge-case-breaker', '```json\n{"verdict":"PASS"}\n```')],
      false,
    );
    expect(out.ran).toBe(true);
    expect(out.findings).toEqual([]);
    expect(out.qaIncomplete).toBe(false);
  });

  it('surfaces an adversary killed at its budget as a qa-gap, not a clean surface', async () => {
    const out = await runQa([failedMining('edge-case-breaker', TIMEOUT_ERR)], true);
    expect(out.qaIncomplete).toBe(true);
    expect(out.findings.some((f) => f.category === 'qa-gap')).toBe(true);
    // the cause travels with the gap — a budget kill wants a longer timeout
    expect(out.findings.some((f) => (f.impact ?? '').includes('time budget'))).toBe(true);
    // the adversary died, the code did not fail: no fix round
    expect(out.blocking).toBe(false);
  });

  it('still reports ran:true when the whole roster died', async () => {
    // ran:false makes gate 2 skip its entire adversarial row, so a roster that was
    // dispatched and wiped out rendered as "QA never ran" — indistinguishable from a
    // task that opted out of QA altogether.
    const out = await runQa(
      [
        failedMining('edge-case-breaker', TIMEOUT_ERR),
        failedMining('workflow-disruptor', TIMEOUT_ERR),
      ],
      true,
    );
    expect(out.ran).toBe(true);
    expect(out.qaIncomplete).toBe(true);
    expect(out.level).toBe('poc');
  });

  it('reports ran:false only when no adversary was dispatched', async () => {
    const out = await runQa([], true);
    expect(out.ran).toBe(false);
    expect(out.qaIncomplete).toBe(false);
  });

  it('re-rolls a killed adversary while it still has budget', async () => {
    const err = await runQa(
      [
        failedMining('edge-case-breaker', TIMEOUT_ERR),
        mining('workflow-disruptor', '```json\n{"verdict":"PASS","findings":[]}\n```'),
      ],
      false,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MiningRetryError);
    expect((err as MiningRetryError).agentIds).toEqual(['edge-case-breaker']);
  });
});

describe('08d mining seats', () => {
  it('seats every adversary by its own id', async () => {
    // The roster is a fixed catalog, so each adversary's id is already the stable seat.
    const agents = await adversarialQaStep.agentMining!.selectAgents({
      detected: {
        level: 'enterprise',
        spec: 's',
        implementationFiles: [],
        appUrl: null,
      },
    } as never);
    expect(agents.length).toBeGreaterThan(0);
    for (const a of agents) expect(a.roleKey, a.agentId).toBe(a.agentId);
  });

  it('registers exactly the seats the widest roster dispatches', async () => {
    // A seat the step emits but the registry omits is unconfigurable in the UI; one the
    // registry lists but no roster emits is a dead control.
    const agents = await adversarialQaStep.agentMining!.selectAgents({
      detected: {
        level: 'enterprise',
        spec: 's',
        implementationFiles: [],
        appUrl: null,
      },
    } as never);
    const registered = STEP_MINING_SEATS['08d-adversarial-qa']!.map((s) => s.id);
    expect(agents.map((a) => a.roleKey!).sort()).toEqual([...registered].sort());
  });

  it('keeps a narrower level a strict subset of the registry', async () => {
    // poc/standard dispatch fewer adversaries; every one must still be a registered seat.
    const registered = new Set(STEP_MINING_SEATS['08d-adversarial-qa']!.map((s) => s.id));
    for (const level of ['poc', 'standard'] as const) {
      const agents = await adversarialQaStep.agentMining!.selectAgents({
        detected: { level, spec: 's', implementationFiles: [], appUrl: null },
      } as never);
      for (const a of agents) expect(registered.has(a.roleKey!), a.roleKey).toBe(true);
    }
  });
});
