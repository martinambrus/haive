import { describe, expect, it } from 'vitest';
import { schema } from '@haive/database';
import { INSIGHTS_AT_GATE, insightsRow, loadUnactedInsights } from './_gate-insights.js';

/** Answers by TABLE: the loader reads the step invocations' raw output, then 08e's rows. */
function tableDb(outputs: { stepId: string; raw: string }[], triage: unknown[]) {
  let rows: unknown[] = [];
  const chain: Record<string, unknown> = {};
  Object.assign(chain, {
    from: (table: unknown) => {
      rows = table === schema.cliInvocations ? outputs : table === schema.taskSteps ? triage : [];
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

  it('keeps each field on one bounded line', async () => {
    const nel = String.fromCharCode(0x85);
    const out = await loadUnactedInsights(
      tableDb(
        [{ stepId: 's', raw: block(`- INSIGHT: Fix${nel}it | a.ts:1 | ${'d'.repeat(300)}`) }],
        [],
      ),
      't1',
    );
    const [i] = out.insights;
    expect(i!.title).toBe('Fix it');
    expect(i!.description).toHaveLength(200);
  });

  it('caps the list and counts what the cap cuts', async () => {
    const lines = Array.from(
      { length: INSIGHTS_AT_GATE + 5 },
      (_, n) => `- INSIGHT: Idea ${n} | f${n}.ts:1`,
    );
    const out = await loadUnactedInsights(
      tableDb([{ stepId: 's', raw: block(...lines) }], []),
      't1',
    );
    expect(out.insights).toHaveLength(INSIGHTS_AT_GATE);
    expect(out.omitted).toBe(5);
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
