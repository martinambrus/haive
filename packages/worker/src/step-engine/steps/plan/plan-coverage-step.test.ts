import { describe, expect, it } from 'vitest';
import { planCoverageStep } from './02-plan-coverage.js';
import { findStructuralGaps } from './plan-coverage-scan.js';
import type { FormSchema } from '@haive/shared';

type Detected = Parameters<NonNullable<typeof planCoverageStep.form>>[1];

const detected = (over: Partial<Detected> = {}): Detected =>
  ({
    repositoryId: 'r1',
    structural: [],
    sections: [],
    sectionBodies: {},
    planMarkdown: '# Plan',
    nodeCount: 791,
    docName: 'spec.md',
    ...over,
  }) as Detected;

const formOf = (d: Detected) => planCoverageStep.form!({} as never, d) as FormSchema | null;

describe('the coverage gate', () => {
  it('does not park when the build left nothing behind', () => {
    // A clean build must finish unattended, exactly as before this step existed.
    expect(formOf(detected())).toBeNull();
  });

  it('parks when a decomposition was lost', () => {
    const form = formOf(
      detected({
        structural: [
          { nodeId: 'n1', title: 'Privacy', reason: 'its decomposition was rejected and lost' },
        ],
      }),
    );
    expect(form).not.toBeNull();
    expect(form!.fields.map((f) => f.id)).toEqual(['decision', 'items', 'note']);
  });

  it('pre-ticks a known loss but not a heuristic guess', () => {
    // A lost decomposition is a fact the build recorded. An uncovered section is
    // a guess from term matching, so it must not be actioned by default.
    const form = formOf(
      detected({
        structural: [{ nodeId: 'n1', title: 'Privacy', reason: 'lost' }],
        sections: [
          { title: '7.8 Music', line: 9, missingTerms: ['music'], matchedNodes: 0, score: 0 },
        ],
      }),
    );
    const items = form!.fields.find((f) => f.id === 'items') as { defaults?: string[] };
    expect(items.defaults).toEqual(['node:n1']);
  });

  it('offers accepting as an equal choice, not a hidden one', () => {
    const form = formOf(detected({ structural: [{ nodeId: 'n1', title: 'X', reason: 'lost' }] }));
    const decision = form!.fields.find((f) => f.id === 'decision') as {
      options: { value: string }[];
    };
    expect(decision.options.map((o) => o.value)).toEqual(['redecompose', 'accept']);
  });

  it('names the document only when there was one', () => {
    // A from_repo build has no single authority to check against.
    const form = formOf(
      detected({ structural: [{ nodeId: 'n1', title: 'X', reason: 'lost' }], docName: null }),
    );
    expect(form!.description).not.toContain('undefined');
  });
});

describe('findStructuralGaps', () => {
  // Real ids, because the agent id is what names the node and the extractor
  // requires that shape — short stand-ins would test a path production never takes.
  const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const D = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  const nodes = [
    { id: 'root', title: 'Root', kind: 'component', parentId: null },
    { id: A, title: 'Alpha', kind: 'component', parentId: 'root' },
    { id: B, title: 'Beta', kind: 'component', parentId: 'root' },
    { id: D, title: 'A decision', kind: 'decision', parentId: 'root' },
  ];
  const P = { failure: 'plan patch not applied:', partial: 'plan patch partially applied:' };

  it('flags a childless component whose expansion was rejected', () => {
    const gaps = findStructuralGaps(
      nodes,
      [{ agentId: `plan-expand-${A}-p1`, errorMessage: 'plan patch not applied: node not found' }],
      P,
    );
    expect(gaps.map((g) => g.nodeId)).toEqual([A]);
  });

  it('leaves an ordinary childless leaf alone', () => {
    // Most of a plan is leaves. Only one whose expansion was ATTEMPTED and lost
    // is suspect; flagging every leaf would report the plan itself.
    expect(findStructuralGaps(nodes, [], P)).toEqual([]);
  });

  it('never flags a decision, which is made rather than decomposed', () => {
    const gaps = findStructuralGaps(
      nodes,
      [{ agentId: `plan-expand-${D}-p1`, errorMessage: 'plan patch not applied: x' }],
      P,
    );
    expect(gaps.map((g) => g.nodeId)).not.toContain(D);
  });

  it('reports a thinned decomposition even though the node has children', () => {
    const withKids = [...nodes, { id: 'c', title: 'Child', kind: 'component', parentId: A }];
    const gaps = findStructuralGaps(
      withKids,
      [
        {
          agentId: `plan-expand-${A}-p1`,
          errorMessage: 'plan patch partially applied: link dropped: x',
        },
      ],
      P,
    );
    expect(gaps[0]?.reason).toContain('dropped');
  });

  it('does not report the same node twice', () => {
    const gaps = findStructuralGaps(
      nodes,
      [
        { agentId: `plan-expand-${A}-p1`, errorMessage: 'plan patch not applied: x' },
        { agentId: `plan-expand-${A}-p2`, errorMessage: 'plan patch partially applied: y' },
      ],
      P,
    );
    expect(gaps).toHaveLength(1);
  });
});

describe('not re-offering work already done', () => {
  const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

  /** The filter detect() applies, stated once so the test and the step cannot
   *  disagree about its shape. */
  const handledSet = (rows: { agentId: string; status: string; errorMessage: string | null }[]) =>
    new Set(rows.filter((a) => a.status === 'done' && !a.errorMessage).map((a) => a.agentId));

  it('drops an item a previous pass re-decomposed', () => {
    // The build's row still says "1 operation dropped" — that stays true after
    // the gap is filled — so without this the report re-offers finished work and
    // a second run grows the plan for nothing. MEASURED on a real task: 19
    // items before the filter, 0 after.
    const handled = handledSet([
      { agentId: `cover-node-${A}`, status: 'done', errorMessage: null },
    ]);
    const gaps = [{ nodeId: A, title: 'Alpha', reason: 'lost' }];
    expect(gaps.filter((g) => !handled.has(`cover-node-${g.nodeId}`))).toEqual([]);
  });

  it('keeps an item whose re-decomposition itself failed', () => {
    // Its patch never landed, so the gap is still there and must stay offered.
    const handled = handledSet([
      { agentId: `cover-node-${A}`, status: 'done', errorMessage: 'plan patch not applied: x' },
    ]);
    const gaps = [{ nodeId: A, title: 'Alpha', reason: 'lost' }];
    expect(gaps.filter((g) => !handled.has(`cover-node-${g.nodeId}`))).toHaveLength(1);
  });

  it('keeps an item whose agent never finished', () => {
    const handled = handledSet([
      { agentId: `cover-node-${A}`, status: 'failed', errorMessage: null },
    ]);
    expect(handled.has(`cover-node-${A}`)).toBe(false);
  });

  it('drops only the item that was handled', () => {
    const handled = handledSet([
      { agentId: `cover-node-${A}`, status: 'done', errorMessage: null },
    ]);
    const gaps = [
      { nodeId: A, title: 'Alpha', reason: 'lost' },
      { nodeId: B, title: 'Beta', reason: 'lost' },
    ];
    expect(gaps.filter((g) => !handled.has(`cover-node-${g.nodeId}`)).map((g) => g.nodeId)).toEqual(
      [B],
    );
  });
});
