import { describe, expect, it, vi } from 'vitest';
import gateFixture from '../../../../test/fixtures/insight-gate-base.json' with { type: 'json' };
import { schema } from '@haive/database';
import { INSIGHTS_AT_GATE, insightsRow, loadUnactedInsights } from './_gate-insights.js';

/** Answers by TABLE: the loader reads the step invocations' raw output, then 08e's rows. */
function tableDb(
  outputs: { stepId: string; raw: string }[],
  triage: unknown[],
  verdicts: unknown[] = [],
) {
  let rows: unknown[] = [];
  const chain: Record<string, unknown> = {};
  Object.assign(chain, {
    from: (table: unknown) => {
      rows =
        table === schema.cliInvocations
          ? outputs.map((r, n) => ({
              invocationId: `inv-${n}`,
              taskStepId: `step-${n}`,
              round: n,
              supersededAt: n === 0 ? new Date(0) : null,
              ...r,
            }))
          : table === schema.taskSteps
            ? triage
            : table === schema.taskDagIssues
              ? verdicts.map((reviewerVerdict, n) => ({ issueId: `issue-${n}`, reviewerVerdict }))
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

const block = (...lines: string[]): string => ['## INSIGHTS', ...lines].join('\n');

describe('loadUnactedInsights', () => {
  it('includes a finding a DAG reviewer withheld from its issue', async () => {
    const withheld = { description: 'legacy', file: 'lib.ts', severity: 'high' };
    const out = await loadUnactedInsights(
      tableDb(
        [],
        [],
        [{ verdict: 'approve', criteria_results: [], issues: [], withheld: [withheld] }],
      ),
      't1',
    );
    expect(out.insights.map((i) => [i.title, i.location])).toEqual([['legacy', 'lib.ts']]);
  });

  it('lists what agents noted, minus what 08e picked in any round', async () => {
    const out = await loadUnactedInsights(
      tableDb(
        [
          {
            stepId: '07-phase-2-implement',
            raw: block(
              '- INSIGHT: Extract helper | a.ts:1 | dedupe',
              '- INSIGHT: Add index | db.ts:5 | faster',
              '- INSIGHT: Rename flag | c.ts:9 | clearer',
            ),
          },
          {
            stepId: '08c-code-review',
            raw: block(
              '- INSIGHT: Cache lookup | x.ts:1 | hot path',
              '- INSIGHT: Extract helper | a.ts:1 | dup',
            ),
          },
        ],
        [
          { output: { selected: [{ title: 'Add index', location: 'db.ts:5' }] } },
          { output: { selected: [{ title: 'CACHE LOOKUP', location: 'X.ts:1' }] } },
          { output: null },
          { output: { selected: 'not a list' } },
        ],
      ),
      't1',
    );
    expect(out.omitted).toBe(0);
    expect(out.insights.map((i) => [i.title, i.sourceStep])).toEqual([
      ['Extract helper', '07-phase-2-implement'],
      ['Rename flag', '07-phase-2-implement'],
    ]);
  });

  it('returns full fields without presentation clipping', async () => {
    const nel = String.fromCharCode(0x85);
    const out = await loadUnactedInsights(
      tableDb(
        [{ stepId: 's', raw: block(`- INSIGHT: Fix${nel}it | a.ts:1 | ${'d'.repeat(300)}`) }],
        [],
      ),
      't1',
    );
    const [i] = out.insights;
    expect(i!.title).toBe(`Fix${nel}it`);
    expect(i!.description).toBe('d'.repeat(300));
  });

  it('caps the list and counts what the cap cuts', async () => {
    expect(INSIGHTS_AT_GATE).toBe(30);
    const lines = Array.from(
      { length: INSIGHTS_AT_GATE + 5 },
      (_, n) => `- INSIGHT: Idea ${n} | f${n}.ts:1`,
    );
    const out = await loadUnactedInsights(
      tableDb([{ stepId: 's', raw: block(...lines) }], []),
      't1',
      { limit: INSIGHTS_AT_GATE },
    );
    expect(out.insights).toHaveLength(INSIGHTS_AT_GATE);
    expect(out.omitted).toBe(5);
  });
  it('loads more than 30 records by default', async () => {
    const raw = block(...Array.from({ length: 35 }, (_, n) => `- INSIGHT: Idea ${n} | f${n}.ts:1`));
    const out = await loadUnactedInsights(tableDb([{ stepId: 's', raw }], []), 't1');
    expect(out.insights).toHaveLength(35);
    expect(out.omitted).toBe(0);
  });

  it('filters picks across rounds BEFORE limiting and counts only eligible omissions', async () => {
    const outputs = [
      {
        stepId: 's',
        raw: block(...['A', 'B', 'C', 'D', 'E'].map((t) => `- INSIGHT: ${t} | ${t}.ts:1`)),
      },
    ];
    const triage = ['a', 'B'].map((title) => ({
      output: { selected: [{ title, location: `${title}.ts:1` }] },
    }));
    const db = tableDb(outputs, triage);
    const out = await loadUnactedInsights(db, 't1', { limit: 2 });
    expect(out.insights.map((i) => [i.title, i.picked])).toEqual([
      ['C', false],
      ['D', false],
    ]);
    expect(out.omitted).toBe(1);
    expect(await loadUnactedInsights(db, 't1', { limit: 2, includePicked: false })).toEqual(out);
    const all = await loadUnactedInsights(db, 't1', { includePicked: true });
    expect(all.insights.map((i) => i.picked)).toEqual([true, true, false, false, false]);
    expect(all.omitted).toBe(0);
    expect(await loadUnactedInsights(db, 't1', { limit: 0, includePicked: true })).toEqual({
      insights: [],
      omitted: 5,
    });
    const capped = await loadUnactedInsights(db, 't1', { includePicked: true, limit: 2 });
    expect(capped.insights.map((i) => i.title)).toEqual(['A', 'B']);
    expect(capped.omitted).toBe(3);
    expect(await loadUnactedInsights(db, 't1', { limit: 0 })).toEqual({ insights: [], omitted: 3 });
  });

  it.each([-1, 0.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, '2', null])(
    'rejects invalid limit %s before reading',
    async (limit) => {
      const select = vi.fn();
      await expect(
        loadUnactedInsights({ select } as never, 't1', { limit: limit as number }),
      ).rejects.toThrow(RangeError);
      expect(select).not.toHaveBeenCalled();
    },
  );

  it('dedupes and matches picks on complete keys, retaining full colliding prefixes', async () => {
    const title = 'T'.repeat(210),
      location = 'p'.repeat(210),
      description = 'D'.repeat(300);
    const raw = block(
      `- INSIGHT: ${title}A | ${location}A:1 | ${description}`,
      `- INSIGHT: ${title}B | ${location}B:1 | ${description}`,
      `- INSIGHT: ${title.toLowerCase()}b | ${location.toUpperCase()}b:1 | duplicate`,
    );
    const out = await loadUnactedInsights(
      tableDb(
        [{ stepId: 's', raw }],
        [{ output: { selected: [{ title: title + 'A', location: location + 'A:1' }] } }],
      ),
      't1',
    );
    expect(out.insights).toHaveLength(1);
    expect(out.insights[0]).toMatchObject({
      title: title + 'B',
      location: location + 'B:1',
      description,
      picked: false,
    });
    expect(out.insights[0]!.identity).toBe(`${location.toLowerCase()}b::${title.toLowerCase()}b`);
  });

  it('keeps stable occurrence ids across order/case changes, and identity across line shifts', async () => {
    const a = await loadUnactedInsights(
      tableDb(
        [{ stepId: 's', raw: block('- INSIGHT: Title | a.ts:1', '- INSIGHT: Title | a.ts:9-11') }],
        [],
      ),
      't1',
    );
    const b = await loadUnactedInsights(
      tableDb([{ stepId: 's', raw: block('- INSIGHT: Other', '- INSIGHT: TITLE | A.TS:1') }], []),
      't1',
    );
    expect(a.insights[0]!.id).toBe(b.insights[1]!.id);
    expect(a.insights[0]!.id).not.toBe(a.insights[1]!.id);
    expect(a.insights[0]!.identity).toBe('a.ts::title');
    expect(a.insights[0]!.identity).toBe(a.insights[1]!.identity);
    const picked = await loadUnactedInsights(
      tableDb(
        [{ stepId: 's', raw: block('- INSIGHT: Title | a.ts:1', '- INSIGHT: Title | a.ts:9-11') }],
        [{ output: { selected: [{ title: 'Title', location: 'a.ts:1' }] } }],
      ),
      't1',
    );
    expect(picked.insights.map((i) => i.location)).toEqual(['a.ts:9-11']);
  });

  it('ignores malformed legacy selections without treating missing locations as picks', async () => {
    const db = tableDb(
      [{ stepId: 's', raw: block('- INSIGHT: Title', '- INSIGHT: Title | a.ts') }],
      [
        {
          output: {
            selected: [
              null,
              3,
              'x',
              {},
              { title: 'Title' },
              { title: 'Title', location: 42 },
              { title: 'Title', location: {} },
              { title: 3, location: '' },
            ],
          },
        },
      ],
    );
    expect((await loadUnactedInsights(db, 't1')).insights).toHaveLength(2);
  });

  it('aggregates physical invocation and withheld provenance, including covered findings', async () => {
    const raw = block('- INSIGHT: Legacy | lib.ts:9 | old code');
    const verdict = {
      verdict: 'approve',
      criteria_results: [],
      issues: [],
      withheld: [
        { description: 'legacy', file: 'lib.ts', severity: 'high' },
        { description: 'Other', file: 'else.ts', severity: 'low' },
      ],
    };
    const out = await loadUnactedInsights(
      tableDb(
        [
          { stepId: 'module.example.review', raw },
          { stepId: '08c-code-review', raw: raw.toUpperCase() },
        ],
        [],
        [verdict],
      ),
      't1',
    );
    expect(out.insights).toHaveLength(2);
    expect(out.insights[0]!.sourceRefs).toEqual([
      {
        kind: 'invocation',
        invocationId: 'inv-0',
        taskStepId: 'step-0',
        stepId: 'module.example.review',
        round: 0,
        superseded: true,
      },
      {
        kind: 'invocation',
        invocationId: 'inv-1',
        taskStepId: 'step-1',
        stepId: '08c-code-review',
        round: 1,
        superseded: false,
      },
      { kind: 'dag_withheld', issueId: 'issue-0', stepId: '06c-dag-execute', severity: 'high' },
    ]);
    expect(out.insights[1]!.sourceRefs).toEqual([
      { kind: 'dag_withheld', issueId: 'issue-0', stepId: '06c-dag-execute', severity: 'low' },
    ]);
  });

  it('preserves the gate row byte for byte from the base capture', async () => {
    const out = await loadUnactedInsights(tableDb(gateFixture.outputs, gateFixture.triage), 't1', {
      limit: INSIGHTS_AT_GATE,
    });
    expect(JSON.stringify(insightsRow(out.insights, out.omitted, 'Next.'))).toBe(
      JSON.stringify(gateFixture.expected),
    );
  });
});

describe('insightsRow', () => {
  it('renders nothing when there is nothing to show', () => {
    expect(insightsRow([], 0, 'x')).toBeNull();
  });

  it('names each finding, where it is and who noted it, and counts the omitted ones', () => {
    const row = insightsRow(
      [
        {
          id: 'i-1',
          sourceStep: '08c-code-review',
          title: 'Cache lookup',
          location: 'x.ts:1',
          description: 'hot path',
        },
        {
          id: 'i-2',
          sourceStep: '07-phase-2-implement',
          title: 'Tidy',
          location: 'a.ts:2',
          description: 'a.ts:2',
        },
      ],
      3,
      'Next.',
    )!;
    expect(row.label).toBe('Out-of-scope findings — not acted on');
    expect(row.status).toBe('info');
    expect(row.statusLabel).toBe('5 FOUND');
    expect(row.defaultOpen).toBe(false);
    expect(row.body).toContain('did not make them. Next.');
    expect(row.body).toContain('- Cache lookup (`x.ts:1`) — hot path (from 08c-code-review)');
    expect(row.body).toContain('- Tidy (`a.ts:2`) (from 07-phase-2-implement)');
    expect(row.body).toContain('3 more not shown.');
  });

  it('shows agent text as text, so an image in it is never fetched', () => {
    const row = insightsRow(
      [
        {
          id: 'i-1',
          sourceStep: 's',
          title: '![x](http://e.test/i.png)',
          location: '',
          description: '',
        },
      ],
      0,
      'Next.',
    )!;
    expect(row.body).not.toContain('![');
    expect(row.body).toContain('\\!\\[x\\]\\(http\\:\\/\\/e\\.test\\/i\\.png\\)');
    expect(row.detail).toBe("1 improvement noted outside the task's scope");
  });
});
