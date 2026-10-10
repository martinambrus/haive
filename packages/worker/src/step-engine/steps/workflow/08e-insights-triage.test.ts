import { describe, it, expect } from 'vitest';
import { schema } from '@haive/database';
import {
  insightsTriageStep,
  loadInsightOutputs,
  parseInsights,
  readTriageOutcome,
} from './08e-insights-triage.js';
import type { StepContext } from '../../step-definition.js';

/** Answers by TABLE: the invocations' raw output, then the DAG issues' reviewer verdicts. */
function tableDb(outputs: { stepId: string; raw: string }[], verdicts: unknown[]) {
  let rows: unknown[] = [];
  const chain: Record<string, unknown> = {};
  Object.assign(chain, {
    from: (table: unknown) => {
      rows =
        table === schema.cliInvocations
          ? outputs
          : table === schema.taskDagIssues
            ? verdicts.map((reviewerVerdict) => ({ reviewerVerdict }))
            : [];
      return chain;
    },
    innerJoin: () => chain,
    where: () => chain,
    orderBy: () => chain,
    then: (resolve: (v: unknown) => unknown) => Promise.resolve(rows).then(resolve),
  });
  return { select: () => chain } as never;
}

describe('parseInsights', () => {
  it('parses INSIGHT lines after a ## INSIGHTS heading', () => {
    const raw =
      '```json\n{"summary":"x"}\n```\n\n## INSIGHTS\n- INSIGHT: Extract helper | src/a.ts:10 | dedupe the two loops\n- INSIGHT: Add index | db/schema.ts:5 | speeds the query\n';
    const ins = parseInsights([{ stepId: '07-phase-2-implement', raw }]);
    expect(ins).toHaveLength(2);
    expect(ins[0]!.title).toBe('Extract helper');
    expect(ins[0]!.location).toBe('src/a.ts:10');
    expect(ins[0]!.description).toBe('dedupe the two loops');
    expect(ins[0]!.sourceStep).toBe('07-phase-2-implement');
    expect(ins[0]!.id).toBe('i-1');
  });

  it('reads every ## INSIGHTS section of one output', () => {
    const raw =
      '## INSIGHTS\n- INSIGHT: One | a.ts:1 | x\n\n## INSIGHTS\n- INSIGHT: Two | b.ts:2 | y\n';
    expect(parseInsights([{ stepId: 's', raw }]).map((i) => i.title)).toEqual(['One', 'Two']);
  });

  it('dedupes by title+location across outputs and caps ids sequentially', () => {
    const raw = '## INSIGHTS\n- INSIGHT: Same | a.ts:1 | one\n';
    const ins = parseInsights([
      { stepId: 's1', raw },
      { stepId: 's2', raw },
    ]);
    expect(ins).toHaveLength(1);
  });

  it('handles a title-only insight (no location/description)', () => {
    const ins = parseInsights([{ stepId: 's', raw: '## INSIGHTS\n- INSIGHT: Tidy logging\n' }]);
    expect(ins).toHaveLength(1);
    expect(ins[0]!.title).toBe('Tidy logging');
    expect(ins[0]!.location).toBe('');
  });

  it('stops at the limit it is given, 30 by default', () => {
    const lines = Array.from({ length: 35 }, (_, n) => `- INSIGHT: Idea ${n} | f${n}.ts:1`);
    const raw = ['## INSIGHTS', ...lines].join('\n');
    expect(parseInsights([{ stepId: 's', raw }])).toHaveLength(30);
    expect(parseInsights([{ stepId: 's', raw }], Number.POSITIVE_INFINITY)).toHaveLength(35);
  });

  it('returns empty when there is no INSIGHTS section', () => {
    expect(parseInsights([{ stepId: 's', raw: 'just output, no insights' }])).toEqual([]);
    expect(parseInsights([{ stepId: 's', raw: '' }])).toEqual([]);
    expect(parseInsights([])).toEqual([]);
  });
});

describe('readTriageOutcome', () => {
  it('is implemented only when the agent listed a change', () => {
    expect(readTriageOutcome({ implemented: ['Extracted helper'], notes: 'n' })).toEqual({
      implemented: true,
      changes: ['Extracted helper'],
      notes: 'n',
    });
    expect(readTriageOutcome({ implemented: [], notes: 'nothing to do' })).toEqual({
      implemented: false,
      changes: [],
      notes: 'nothing to do',
    });
  });

  it('reads the fenced JSON reply the runner hands over as a string', () => {
    const raw = 'Done.\n\n```json\n{ "implemented": ["Extracted helper"], "notes": "" }\n```\n';
    expect(readTriageOutcome(raw)).toEqual({
      implemented: true,
      changes: ['Extracted helper'],
      notes: '',
    });
    expect(readTriageOutcome('no json here')).toEqual({
      implemented: false,
      changes: [],
      notes: '',
    });
  });

  it('takes the final reply over JSON the agent quoted before it', () => {
    const raw =
      'I updated:\n```json\n{ "name": "pkg", "version": "1.0.0" }\n```\n' +
      '```json\n{ "implemented": ["Bumped version"], "notes": "" }\n```\n';
    expect(readTriageOutcome(raw)).toMatchObject({
      implemented: true,
      changes: ['Bumped version'],
    });
  });

  it('is not implemented when the output is missing or malformed', () => {
    const none = { implemented: false, changes: [], notes: '' };
    expect(readTriageOutcome(null)).toEqual(none);
    expect(readTriageOutcome(undefined)).toEqual(none);
    expect(readTriageOutcome({ implemented: true })).toEqual(none);
    expect(readTriageOutcome({ implemented: ['', 3, '  '] })).toEqual(none);
  });
});

describe('insightsTriageStep.apply', () => {
  const insight = { id: 'i-1', sourceStep: 's', title: 'T', location: '', description: '' };
  const ctx = { logger: { info: () => {} } } as unknown as StepContext;
  const detected = { worktreePath: '', sandboxWorktreePath: '', spec: '', insights: [insight] };

  it('does not report a pick as implemented when the agent made no change', async () => {
    const out = await insightsTriageStep.apply(ctx, {
      detected,
      formValues: { selectedInsights: ['i-1'] },
      llmOutput: { implemented: [], notes: 'already done' },
      iteration: 0,
      previousIterations: [],
    });
    expect(out).toMatchObject({ selected: [insight], implemented: false, notes: 'already done' });
  });

  it('reports implemented with the changes the agent listed', async () => {
    const out = await insightsTriageStep.apply(ctx, {
      detected,
      formValues: { selectedInsights: ['i-1'] },
      llmOutput: { implemented: ['Did T'], notes: '' },
      iteration: 0,
      previousIterations: [],
    });
    expect(out).toMatchObject({ implemented: true, changes: ['Did T'] });
  });
});

describe('loadInsightOutputs: findings a DAG reviewer withheld', () => {
  const legacy = { severity: 'high', file: 'lib.ts', description: 'legacy', in_scope: 'no' };
  const verdict = { verdict: 'approve', criteria_results: [], issues: [], withheld: [legacy] };
  const titles = async (outputs: { stepId: string; raw: string }[], verdicts: unknown[]) =>
    parseInsights(await loadInsightOutputs(tableDb(outputs, verdicts), 't1'));

  it('turns a withheld finding into one insight although the reply has no INSIGHTS block', async () => {
    const ins = await titles([], [verdict]);
    expect(ins).toHaveLength(1);
    expect(ins[0]).toMatchObject({ title: 'legacy', location: 'lib.ts' });
    expect(ins[0]!.description).toContain('high');
  });

  it('lists a finding the reviewer also wrote under ## INSIGHTS once', async () => {
    const raw = '```json\n{}\n```\n\n## INSIGHTS\n- INSIGHT: legacy | lib.ts:40 | old code\n';
    const ins = await titles([{ stepId: '06c-dag-execute', raw }], [verdict]);
    expect(ins).toHaveLength(1);
    expect(ins[0]!.location).toBe('lib.ts:40');
  });

  it('keeps the reviewer own insights next to a withheld finding it did not repeat', async () => {
    const raw = '## INSIGHTS\n- INSIGHT: Extract helper | util.ts:3 | dedupe\n';
    const ins = await titles([{ stepId: '06c-dag-execute', raw }], [verdict]);
    expect(ins.map((i) => i.title).sort()).toEqual(['Extract helper', 'legacy']);
  });

  it('ignores a verdict that withheld nothing and one that is not a verdict', async () => {
    const none = { verdict: 'approve', criteria_results: [], issues: [] };
    expect(await titles([], [none, null, 'x', { withheld: 'x' }])).toEqual([]);
  });
});
