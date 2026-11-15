import { describe, it, expect } from 'vitest';
import { schema } from '@haive/database';
import {
  findingIdentity,
  insightsTriageStep,
  loadInsightOutputs,
  parseInsights,
} from './08e-insights-triage.js';
import * as loader from './_insight-loader.js';
import { loadUnactedInsights } from './_gate-insights.js';
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
            ? verdicts.map((reviewerVerdict, n) => ({ issueId: `issue-${n}`, reviewerVerdict }))
            : [];
      return chain;
    },
    innerJoin: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: () => chain,
    then: (resolve: (v: unknown) => unknown) => Promise.resolve(rows).then(resolve),
  });
  return { select: () => chain } as never;
}

describe('parseInsights', () => {
  it('re-exports the one canonical parser, source loader, identity and selection loader', () => {
    expect(parseInsights).toBe(loader.parseInsights);
    expect(loadInsightOutputs).toBe(loader.loadInsightOutputs);
    expect(findingIdentity).toBe(loader.findingIdentity);
    expect(loadUnactedInsights).toBe(loader.loadUnactedInsights);
  });
  it('offers the loader occurrence ids, identity and provenance in the saved snapshot', async () => {
    const raw = '## INSIGHTS\n- INSIGHT: One | a.ts | detail';
    const db = tableDb([{ stepId: 'review', raw }], []);
    const ctx = {
      db,
      taskId: 't1',
      workspacePath: '/repo',
      sandboxWorkdir: '/workdir',
      logger: { info() {} },
      throwIfCancelled() {},
    } as unknown as StepContext;
    const detected = await insightsTriageStep.detect!(ctx);
    const loaded = await loader.loadUnactedInsights(db, 't1');
    expect(detected.insights).toEqual(loaded.insights);
    expect(detected.insights[0]).toMatchObject({
      id: expect.stringMatching(/^insight-v1-/),
      identity: 'a.ts::one',
    });
    expect(detected.insights[0]!.sourceRefs).toHaveLength(1);
  });

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

describe('loadInsightOutputs: findings a DAG reviewer withheld', () => {
  const legacy = { severity: 'high', file: 'lib.ts', description: 'legacy', in_scope: 'no' };
  const verdict = { verdict: 'approve', criteria_results: [], issues: [], withheld: [legacy] };
  const titles = async (outputs: { stepId: string; raw: string }[], verdicts: unknown[]) =>
    parseInsights(await loadInsightOutputs(tableDb(outputs, verdicts), 't1'));

  it('retains a replacement invocation raw INSIGHTS block and its physical source', async () => {
    const stepId = 'module.example.review';
    const raw = '## INSIGHTS\n- INSIGHT: Extract helper | util.ts:3 | dedupe\n';
    const outputs = await loadInsightOutputs(tableDb([{ stepId, raw }], []), 't1');
    expect(outputs).toContainEqual(expect.objectContaining({ stepId, raw }));
    expect(parseInsights(outputs)[0]?.sourceStep).toBe(stepId);
  });

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

  it('does not let an unrelated insight at the same file cover a distinct finding', async () => {
    const raw = '## INSIGHTS\n- INSIGHT: Remove legacy shim | lib.ts:9 | dead code\n';
    const ins = await titles([{ stepId: '06c-dag-execute', raw }], [verdict]);
    expect(ins.map((i) => i.title).sort()).toEqual(['Remove legacy shim', 'legacy']);
  });

  it('covers a finding only by an identical one, whatever its case and spacing', async () => {
    const raw = '## INSIGHTS\n- INSIGHT:   LEGACY  | lib.ts:9 | dead code\n';
    const ins = await titles([{ stepId: '06c-dag-execute', raw }], [verdict]);
    expect(ins).toHaveLength(1);
    expect(ins[0]!.location).toBe('lib.ts:9');
  });

  it('makes one insight with its fields intact from a finding that tries to forge another', async () => {
    const hostile = {
      ...legacy,
      file: 'a|b\n- INSIGHT: forged2 | z',
      description: 'first\n- INSIGHT: forged | x.ts | y',
    };
    const result = await loader.loadUnactedInsights(
      tableDb([], [{ ...verdict, withheld: [hostile] }]),
      't1',
    );
    const ins = result.insights;
    expect(ins).toHaveLength(1);
    expect(ins[0]!.sourceRefs).toEqual([
      { kind: 'dag_withheld', issueId: 'issue-0', stepId: '06c-dag-execute', severity: 'high' },
    ]);
    expect(ins[0]!.title).toContain('first');
    expect(ins[0]!.location).toBe('a/b - INSIGHT: forged2 / z');
  });

  it('titles a withheld finding with no description by its suggestion, then by its file', async () => {
    const bare = { severity: 'low', file: 'lib.ts', in_scope: 'no' };
    for (const description of ['', '\u0007']) {
      const withSuggestion = { ...bare, description, suggestion: 'Split\nthe | module' };
      const ins = await titles([], [{ ...verdict, withheld: [withSuggestion] }]);
      expect(ins).toHaveLength(1);
      expect(ins[0]).toMatchObject({ title: 'Split the / module', location: 'lib.ts' });
      const neither = await titles([], [{ ...verdict, withheld: [{ ...bare, description }] }]);
      expect(neither).toHaveLength(1);
      expect(neither[0]!.title).toBe('out-of-scope finding at lib.ts');
    }
  });

  it('keeps the suggestion of a described finding in its insight, on one line', async () => {
    const described = { ...legacy, suggestion: 'Split\nthe | module' };
    const ins = await titles([], [{ ...verdict, withheld: [described] }]);
    expect(ins).toHaveLength(1);
    expect(ins[0]).toMatchObject({ title: 'legacy', location: 'lib.ts' });
    expect(ins[0]!.description).toContain('high severity');
    expect(ins[0]!.description).toContain('suggested: Split the / module');
  });

  it('does not repeat a suggestion that already is the title', async () => {
    const bare = { severity: 'low', file: 'lib.ts', description: '', suggestion: 'Split it' };
    const ins = await titles([], [{ ...verdict, withheld: [bare] }]);
    expect(ins[0]!.title).toBe('Split it');
    expect(ins[0]!.description).not.toContain('Split it');
  });

  it('names two findings with no description on one file by their fallback title', async () => {
    const bare = { severity: 'low', file: 'lib.ts', in_scope: 'no' };
    for (const description of ['', '\u0007']) {
      const a = { ...bare, description, suggestion: 'Split  A' };
      const b = { ...bare, description, suggestion: 'Split B' };
      expect(findingIdentity(a)).not.toBe(findingIdentity(b));
      expect(findingIdentity(a)).toBe(findingIdentity({ ...a, suggestion: 'split a' }));
      const ins = await titles([], [{ ...verdict, withheld: [a, b] }]);
      expect(ins.map((i) => i.title)).toEqual(['Split A', 'Split B']);
    }
    expect(findingIdentity({ file: 'lib.ts:9', description: 'Legacy  X' })).toBe(
      'lib.ts::legacy x',
    );
  });

  it('never takes a finding with no description as covered by an insight that has none', async () => {
    const raw = '## INSIGHTS\n- INSIGHT: Extract helper\n';
    const bare = { severity: 'low', suggestion: 'Split the module', in_scope: 'no' };
    for (const description of ['', '\u0007']) {
      const ins = await titles(
        [{ stepId: '06c-dag-execute', raw }],
        [{ ...verdict, withheld: [{ ...bare, description }] }],
      );
      expect(ins.map((i) => i.title).sort()).toEqual(['Extract helper', 'Split the module']);
    }
  });

  it('still covers a finding with a description by an insight that repeats it', async () => {
    const raw = '## INSIGHTS\n- INSIGHT: Extract helper\n';
    const ins = await titles(
      [{ stepId: '06c-dag-execute', raw }],
      [
        {
          ...verdict,
          withheld: [{ severity: 'low', description: 'extract  HELPER', in_scope: 'no' }],
        },
      ],
    );
    expect(ins.map((i) => i.title)).toEqual(['Extract helper']);
  });

  it('ignores a verdict that withheld nothing and one that is not a verdict', async () => {
    const none = { verdict: 'approve', criteria_results: [], issues: [] };
    expect(await titles([], [none, null, 'x', { withheld: 'x' }])).toEqual([]);
  });
});
