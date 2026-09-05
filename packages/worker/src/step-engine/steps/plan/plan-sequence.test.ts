import { describe, it, expect } from 'vitest';
import type { PlanEdgeRecord, PlanNodeSkeleton } from '@haive/shared/plan';
import { SEQUENCE_AGENTS_PER_PASS } from '@haive/shared/plan';
import {
  agentOrdinals,
  collectDisagreements,
  sequenceForm,
  sequencePassComplete,
  type MiningRow,
  type PlanSequenceDetect,
} from './03-plan-sequence.js';

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
    lastReviewedAt: null,
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

  it('strips the `node:` prefix the renderer prints and the contract tells agents to copy', () => {
    // The common reply shape, not an edge case: on one 400-agent pass 250 of the
    // 400 replies carried the prefix, and every one of their orderings was
    // invisible to collectDisagreements until this stripped it.
    expect(agentOrdinals([reply({ [`node:${A}`]: 0, [`NODE:${B}`]: 1 })])).toEqual(
      new Map([
        [A, 0],
        [B, 1],
      ]),
    );
  });

  it('leaves a temp id that merely looks prefixed alone', () => {
    // `node:api` is not a uuid, so it names a node the agent is inventing.
    expect(agentOrdinals([reply({ 'node:api': 0 })])).toEqual(new Map([['node:api', 0]]));
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

  it('flags a contradiction stated with prefixed refs', () => {
    const found = collectDisagreements(
      NODES,
      [edge(A, B)],
      agentOrdinals([reply({ [`node:${A}`]: 0, [`node:${B}`]: 1 })]),
    );
    expect(found).toHaveLength(1);
  });

  it('carries the recorded reason through, so a reviewer sees the claim', () => {
    const e = { ...edge(A, B), note: 'Alpha is invoked by Beta' };
    const found = collectDisagreements(NODES, [e], agentOrdinals([reply({ [A]: 0, [B]: 1 })]));
    expect(found[0]?.note).toBe('Alpha is invoked by Beta');
  });
});

describe('sequencePassComplete', () => {
  it('is over when every group has been asked', () => {
    expect(sequencePassComplete(0, 12)).toBe(true);
  });

  it('is over when the budget is spent, even with groups still pending', () => {
    // The failure this exists for: 889 sibling runs against a 400-agent budget,
    // so `targets.length` never reaches 0 and the end-of-pass review was
    // unreachable while apply() asked for it anyway.
    expect(sequencePassComplete(489, SEQUENCE_AGENTS_PER_PASS)).toBe(true);
  });

  it('is not over while both groups and budget remain', () => {
    expect(sequencePassComplete(5, 12)).toBe(false);
  });
});

describe('sequenceForm', () => {
  function detected(over: Partial<PlanSequenceDetect> = {}): PlanSequenceDetect {
    return {
      repositoryId: '33333333-3333-4333-8333-333333333333',
      nodeCount: 7983,
      decidedRuns: 87,
      targets: [],
      contradictoryRuns: 0,
      cycles: 0,
      ancestorDeps: 0,
      agentsUsed: 0,
      wave: 0,
      disagreements: [],
      ...over,
    };
  }

  const DISAGREEMENT = {
    edgeId: 'edge-aaaa-bbbb',
    fromNodeId: A,
    fromTitle: 'Alpha',
    toNodeId: B,
    toTitle: 'Beta',
    note: null,
  };

  const target = { parentId: PARENT, parentTitle: 'Parent', childCount: 3 };

  it('asks about the budget on the first pass', () => {
    const form = sequenceForm(detected({ targets: [target] }));
    expect(form?.fields[0]?.id).toBe('decision');
  });

  it('reviews disagreements once the budget is spent with groups still pending', () => {
    // apply() reopens the form here; before this it returned null and the runner
    // failed the step with "requested another form, but refreshed detection
    // produced no form".
    const form = sequenceForm(
      detected({
        targets: Array.from({ length: 489 }, () => target),
        agentsUsed: SEQUENCE_AGENTS_PER_PASS,
        disagreements: [DISAGREEMENT],
      }),
    );
    expect(form?.fields[0]?.id).toBe('removeEdges');
  });

  it('reviews disagreements when every group has been asked', () => {
    const form = sequenceForm(detected({ agentsUsed: 12, disagreements: [DISAGREEMENT] }));
    expect(form?.fields[0]?.id).toBe('removeEdges');
  });

  it('stays out of the way mid-pass', () => {
    expect(
      sequenceForm(detected({ targets: [target], agentsUsed: 12, disagreements: [DISAGREEMENT] })),
    ).toBeNull();
  });

  it('asks nothing when the pass ended with nothing to review', () => {
    expect(sequenceForm(detected({ agentsUsed: SEQUENCE_AGENTS_PER_PASS }))).toBeNull();
  });
});
