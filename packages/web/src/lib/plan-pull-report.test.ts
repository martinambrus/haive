import { describe, expect, it } from 'vitest';
import { pullReportLines } from './plan-pull-report';

const titles = new Map([['11111111-1111-4111-8111-111111111111', 'Billing']]);
const titleOf = (id: string) => titles.get(id) ?? null;

describe('pullReportLines', () => {
  it('says nothing when the pull decided nothing', () => {
    expect(pullReportLines({}, titleOf)).toEqual([]);
  });

  it('names deletions, questions and decisions', () => {
    const lines = pullReportLines(
      {
        nodesDeleted: ['22222222-2222-4222-8222-222222222222'],
        conflicts: [{ nodeId: '11111111-1111-4111-8111-111111111111', field: 'title' }],
        reported: [
          {
            kind: 'kept-modified',
            subject: '11111111-1111-4111-8111-111111111111',
            deletedBy: 'incoming',
          },
          { kind: 'local-wins', subject: 'edge:a>b:affects', field: 'note' },
        ],
      },
      titleOf,
    );
    expect(lines).toEqual([
      '1 node(s) were deleted here because the other side deleted them and nobody here had changed them: `22222222`.',
      '1 change(s) were made differently on both sides and wait for your answer: `Billing` title.',
      '`Billing` was kept: the other side deleted it, but this install had changed it.',
      "The note of a link between two nodes was changed on both sides; this install's was kept.",
    ]);
  });

  it('quotes a node title as code, so markdown in it is shown as written', () => {
    const lines = pullReportLines(
      { conflicts: [{ nodeId: 'n1', field: 'title' }] },
      () => '**bold** `tick`',
    );
    expect(lines[0]).toContain('`` **bold** `tick` `` title');
  });

  it('lists at most eight decisions and counts the rest', () => {
    const reported = Array.from({ length: 11 }, () => ({
      kind: 'kept-ancestor',
      subject: '11111111-1111-4111-8111-111111111111',
    }));
    const lines = pullReportLines({ reported }, titleOf);
    expect(lines).toHaveLength(9);
    expect(lines[8]).toBe('3 more decisions are not listed.');
  });
});
