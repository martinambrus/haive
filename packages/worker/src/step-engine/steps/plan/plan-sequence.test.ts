import { describe, it, expect } from 'vitest';
import type { PlanEdgeRecord, PlanNodeSkeleton } from '@haive/shared/plan';
import { agentOrdinals, collectDisagreements, type MiningRow } from './03-plan-sequence.js';

const PARENT = '11111111-1111-4111-8111-111111111111';
const OTHER_PARENT = '22222222-2222-4222-8222-222222222222';
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

function node(id: string, parentId: string | null, title = id.slice(0, 4)): PlanNodeSkeleton {
  return {
    id,
    parentId,
    path: `/${parentId ?? ''}${parentId ? '/' : ''}${id}/`,
    ordinal: 0,
    title,
    kind: 'component',
    status: 'todo',
    taskable: false,
    version: 1,
    createdBy: 'llm',
    sourceTaskId: null,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
  };
}

function edge(
  from: string,
  to: string,
  kind: PlanEdgeRecord['kind'] = 'depends_on',
): PlanEdgeRecord {
  return {
    id: `edge-${from.slice(0, 4)}-${to.slice(0, 4)}`,
    fromNodeId: from,
    toNodeId: to,
    kind,
    note: null,
  };
}

/** One agent reply carrying an ordinal per node. */
function reply(ordinals: Record<string, number>, over: Partial<MiningRow> = {}): MiningRow {
  return {
    agentId: 'plan-seq-x-p1',
    status: 'done',
    output: {
      summary: 's',
      ops: Object.entries(ordinals).map(([nodeRef, ordinal]) => ({
        op: 'upsert',
        nodeRef,
        ordinal,
      })),
    },
    rawOutput: null,
    ...over,
  };
}

const NODES = [node(PARENT, null), node(A, PARENT, 'Alpha'), node(B, PARENT, 'Beta')];

describe('agentOrdinals', () => {
  it('reads the order each agent actually stated', () => {
    expect(agentOrdinals([reply({ [A]: 0, [B]: 1 })])).toEqual(
      new Map([
        [A, 0],
        [B, 1],
      ]),
    );
  });

  it('ignores an agent that did not finish', () => {
    expect(agentOrdinals([reply({ [A]: 0 }, { status: 'failed' })]).size).toBe(0);
  });

  it('ignores anything that is not an ordinal assignment', () => {
    const row = reply({});
    (row.output as { ops: unknown[] }).ops = [
      { op: 'upsert', nodeRef: A, title: 'renamed' },
      { op: 'link', fromRef: A, toRef: B, kind: 'depends_on' },
      { op: 'upsert', nodeRef: B, ordinal: 3 },
    ];
    expect(agentOrdinals([row])).toEqual(new Map([[B, 3]]));
  });

  it('matches node refs case-insensitively, as the applier does', () => {
    expect(agentOrdinals([reply({ [A.toUpperCase()]: 2 })]).get(A)).toBe(2);
  });

  it('survives a reply that is not a patch at all', () => {
    expect(agentOrdinals([reply({}, { output: 'I could not do this' })]).size).toBe(0);
  });
});

describe('collectDisagreements', () => {
  it('flags an edge whose direction the ordering contradicts', () => {
    // A waits for B, so B must be built first. The agent put A first.
    const found = collectDisagreements(
      NODES,
      [edge(A, B)],
      agentOrdinals([reply({ [A]: 0, [B]: 1 })]),
    );
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      fromTitle: 'Alpha',
      toTitle: 'Beta',
      edgeId: 'edge-aaaa-bbbb',
    });
  });

  it('stays quiet when the two readings agree', () => {
    expect(
      collectDisagreements(NODES, [edge(A, B)], agentOrdinals([reply({ [B]: 0, [A]: 1 })])),
    ).toEqual([]);
  });

  it('treats an equal ordinal as agreement, not contradiction', () => {
    // Nothing was said about which comes first, so nothing was contradicted.
    expect(
      collectDisagreements(NODES, [edge(A, B)], agentOrdinals([reply({ [A]: 0, [B]: 0 })])),
    ).toEqual([]);
  });

  it('ignores an edge crossing two sibling runs', () => {
    // An agent is asked about ONE run, so its order says nothing about a pair
    // split across two of them.
    const nodes = [
      node(PARENT, null),
      node(OTHER_PARENT, null),
      node(A, PARENT),
      node(C, OTHER_PARENT),
    ];
    expect(
      collectDisagreements(nodes, [edge(A, C)], agentOrdinals([reply({ [A]: 0, [C]: 1 })])),
    ).toEqual([]);
  });

  it('ignores a pair no agent ordered', () => {
    expect(collectDisagreements(NODES, [edge(A, B)], new Map())).toEqual([]);
    expect(collectDisagreements(NODES, [edge(A, B)], agentOrdinals([reply({ [A]: 0 })]))).toEqual(
      [],
    );
  });

  it.each(['affects', 'implements'] as const)('ignores a %s edge', (kind) => {
    // Only `depends_on` holds work back, so only its direction is a claim about
    // build order that an ordering can contradict.
    expect(
      collectDisagreements(NODES, [edge(A, B, kind)], agentOrdinals([reply({ [A]: 0, [B]: 1 })])),
    ).toEqual([]);
  });

  it('ignores an edge whose endpoint is not in the plan', () => {
    expect(
      collectDisagreements(NODES, [edge(A, C)], agentOrdinals([reply({ [A]: 0, [C]: 1 })])),
    ).toEqual([]);
  });

  it('carries the recorded reason through, so a reviewer sees the claim', () => {
    const e = { ...edge(A, B), note: 'Alpha is invoked by Beta' };
    const found = collectDisagreements(NODES, [e], agentOrdinals([reply({ [A]: 0, [B]: 1 })]));
    expect(found[0]?.note).toBe('Alpha is invoked by Beta');
  });
});
