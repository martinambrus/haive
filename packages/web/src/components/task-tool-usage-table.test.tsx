import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { TaskCustomToolCall, TaskToolUsage, TaskToolUsageStep } from '@/lib/api-client';
import { TaskToolUsageTable } from './task-tool-usage-table';

const NO_RUN: TaskToolUsageStep = {
  runs: 0,
  observable: 0,
  partial: 0,
  unobservable: 0,
  unrecorded: 0,
  inFlight: 0,
  personasAssigned: [],
  personasRead: [],
  skillsInvoked: [],
  skillsRead: [],
  mcp: [],
  subagents: [],
  toolCalls: 0,
};

const RAN: TaskToolUsageStep = {
  ...NO_RUN,
  runs: 2,
  observable: 2,
  personasAssigned: [{ id: 'reviewer', n: 2 }],
  personasRead: [{ id: 'reviewer', n: 1 }],
  skillsInvoked: [{ id: 'deploy', n: 3 }],
  skillsRead: [{ id: 'style', n: 4 }],
  mcp: [{ server: 'haive-rag', tool: 'rag_search', calls: 5 }],
  subagents: [{ id: 'Explore', n: 6 }],
  toolCalls: 7,
};

const REFUSED: TaskCustomToolCall = {
  tool: 'lookup',
  action: 'http-get',
  ok: 0,
  refused: 1,
  error: 0,
  running: 0,
};

const usageData = (
  usage: TaskToolUsageStep | null,
  totals: TaskToolUsageStep,
  coverage: Partial<TaskToolUsage['coverage']>,
): TaskToolUsage => ({
  taskId: 'task-1',
  steps: [
    {
      stepRowId: 'row-1',
      stepId: 'tu-one',
      round: 0,
      title: 'One',
      usage,
      customTools: [REFUSED],
      integrations: [],
    },
  ],
  totals,
  coverage: {
    total: 0,
    observable: 0,
    partial: 0,
    unobservable: 0,
    unrecorded: 0,
    inFlight: 0,
    ...coverage,
  },
  callTotals: { customTools: [REFUSED], integrations: [] },
});

const textOf = (markup: string) => {
  let text = markup;
  for (let before = ''; before !== text;) {
    before = text;
    text = text.replace(/<[^>]+>/g, '');
  }
  return text;
};
const render = (data: TaskToolUsage) => renderToStaticMarkup(<TaskToolUsageTable data={data} />);
const bodyRows = (markup: string): string[][] =>
  [...markup.matchAll(/<tr[^>]*>(.*?)<\/tr>/gs)]
    .slice(1)
    .map((row) => [...row[1]!.matchAll(/<td[^>]*>(.*?)<\/td>/gs)].map((cell) => textOf(cell[1]!)));
const noteOf = (markup: string) => textOf(markup.match(/<p[^>]*>(.*?)<\/p>/s)![1]!);

describe('TaskToolUsageTable with no run in the rollup', () => {
  it.each([
    ['the zero totals the api answers', NO_RUN],
    ['whatever the totals hold', RAN],
  ])('shows a dash for every column read from runs in the total row, %s', (_name, totals) => {
    expect(bodyRows(render(usageData(null, totals, { total: 0 })))).toEqual([
      ['tu-one', '—', '—', '—', '—', 'lookup 1 refused', '—', '—', '—'],
      ['total', '—', '—', '—', '—', 'lookup 1 refused', '—', '—', '—'],
    ]);
  });

  it('says no run is in the rollup instead of counting 0 of 0 runs', () => {
    const note = noteOf(render(usageData(null, NO_RUN, { total: 0 })));
    expect(note).not.toContain('0 of 0');
    expect(note).not.toContain('runs observable');
    expect(note).toContain('No run of this task is in the rollup');
    expect(note).toContain(
      'Custom tools and integrations count every call Haive logged for this task',
    );
  });
});

describe('TaskToolUsageTable with runs in the rollup', () => {
  const markup = render(usageData(RAN, RAN, { total: 2, observable: 2 }));

  it('counts the runs and lists what they used in the total row', () => {
    expect(bodyRows(markup)).toEqual([
      [
        'tu-one',
        '2/2',
        'reviewer (2) → reviewer (1)',
        'deploy (3) / style (4)',
        'haive-rag/rag_search (5)',
        'lookup 1 refused',
        '—',
        'Explore (6)',
        '7',
      ],
      [
        'total',
        '2/2',
        'reviewer (2) → reviewer (1)',
        'deploy (3) / style (4)',
        'haive-rag/rag_search (5)',
        'lookup 1 refused',
        '—',
        'Explore (6)',
        '7',
      ],
    ]);
  });

  it('names runs still in flight apart from runs that ran before the record', () => {
    const note = noteOf(
      render(usageData(RAN, RAN, { total: 4, observable: 2, unrecorded: 1, inFlight: 2 })),
    );
    expect(note).toContain('1 ran before this record existed.');
    expect(note).toContain('2 still queued or running, recorded when they end.');
  });

  it('keeps the coverage note, its qualifiers and the call-log sentence', () => {
    const note = noteOf(
      render(
        usageData(RAN, RAN, {
          total: 4,
          observable: 2,
          partial: 1,
          unobservable: 1,
          unrecorded: 1,
        }),
      ),
    );
    expect(note).toContain('2 of 4 runs observable, 1 partial (counts are floors).');
    expect(note).toContain('1 ran on a CLI whose output carries no tool events');
    expect(note).toContain('1 ran before this record existed.');
    expect(note).toContain('Personas assigned by Haive are recorded only once');
    expect(note).toContain('they need not match the MCP column.');
    expect(note).not.toContain('No run of this task is in the rollup');
  });
});
