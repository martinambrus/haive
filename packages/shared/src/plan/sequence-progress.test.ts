import { describe, it, expect } from 'vitest';
import {
  SEQUENCE_AGENTS_PER_PASS,
  askedParents,
  computeSequenceProgress,
  sequenceAgentId,
  sequenceAgentParent,
  sequenceAgentWave,
  type AskedRow,
} from './sequence-progress.js';
import type { PlanSequenceEdge, PlanSequenceNode } from './sequence.js';

const PARENT = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const D = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

function node(id: string, parentId: string | null): PlanSequenceNode {
  return {
    id,
    parentId,
    ordinal: 0,
    title: id.slice(0, 4),
    kind: 'component',
    status: 'todo',
    taskable: false,
    lastReviewedAt: null,
    createdAt: new Date('2026-01-01'),
  } as PlanSequenceNode;
}

function edge(from: string, to: string): PlanSequenceEdge {
  return { fromNodeId: from, toNodeId: to, kind: 'depends_on' } as PlanSequenceEdge;
}

describe('sequence agent ids', () => {
  it('round-trips the parent and the wave', () => {
    const id = sequenceAgentId(PARENT, 7);
    expect(sequenceAgentParent(id)).toBe(PARENT);
    expect(sequenceAgentWave(id)).toBe(7);
  });

  it('ignores an id belonging to another fan-out', () => {
    expect(sequenceAgentParent(`plan-expand-${PARENT}-p1`)).toBeNull();
    expect(sequenceAgentWave(`plan-expand-${PARENT}-p1`)).toBe(0);
  });
});

describe('askedParents', () => {
  const THIS_STEP = 'step-now';
  const row = (over: Partial<AskedRow> = {}): AskedRow => ({
    agentId: sequenceAgentId(PARENT, 1),
    status: 'done',
    taskStepId: THIS_STEP,
    ...over,
  });

  it('carries a finished group across passes, so the next one starts past it', () => {
    // Without this a second task rebuilt the frontier in plan order and re-asked
    // the same 390 of 400 groups the first had already ordered.
    expect(askedParents([row({ taskStepId: 'step-earlier' })], THIS_STEP).has(PARENT)).toBe(true);
  });

  it("ignores an earlier pass's agent that never answered", () => {
    // It left the group unordered; never asking again would strand exactly the
    // groups that most need a second try. MEASURED: one agent failed in pass two,
    // and its group correctly returned to the pool.
    for (const status of ['failed', 'pending', 'running'] as const) {
      expect(askedParents([row({ taskStepId: 'step-earlier', status })], THIS_STEP).size).toBe(0);
    }
  });

  it('counts an in-flight agent of the CURRENT pass, whatever its status', () => {
    // A group already out with an agent must not be dispatched twice by the next
    // wave of the same pass.
    for (const status of ['pending', 'running', 'failed'] as const) {
      expect(askedParents([row({ status })], THIS_STEP).has(PARENT)).toBe(true);
    }
  });

  it('reads strictly for a caller that has no pass of its own', () => {
    // The API counts what is left from outside any pass, so an unfinished row
    // must not count as asked.
    const rows = [row({ taskStepId: 'step-a', status: 'running' })];
    expect(askedParents(rows, 'no-step-of-mine').size).toBe(0);
  });

  it('matches the parent id case-insensitively', () => {
    const id = sequenceAgentId(PARENT.toUpperCase(), 3);
    expect(askedParents([row({ agentId: id })], 'x').has(PARENT)).toBe(true);
  });

  it('dedupes a parent asked by more than one pass', () => {
    const rows = [
      row({ taskStepId: 'step-earlier' }),
      row({ agentId: sequenceAgentId(PARENT, 2) }),
    ];
    expect(askedParents(rows, 'step-now').size).toBe(1);
  });
});

describe('computeSequenceProgress', () => {
  const nodes = [
    node(PARENT, null),
    node(A, PARENT),
    node(B, PARENT),
    node(OTHER, null),
    node(C, OTHER),
    node(D, OTHER),
  ];

  it('counts a run whose edges leave the order open', () => {
    const p = computeSequenceProgress(nodes, [], new Set());
    expect(p.groupsRemaining).toBe(2);
    // Nodes, not groups: "2 groups" says how many passes are left, "4 nodes" says
    // how much plan is still unordered, and those are different questions.
    expect(p.nodesRemaining).toBe(4);
    expect(p.perPass).toBe(SEQUENCE_AGENTS_PER_PASS);
    expect(p.passesRemaining).toBe(1);
  });

  it('drops a run the edges already decide', () => {
    // The free deterministic pass settles this one, so no agent is needed.
    const p = computeSequenceProgress(nodes, [edge(A, B)], new Set());
    expect(p.groupsRemaining).toBe(1);
    expect(p.nodesRemaining).toBe(2);
  });

  it('drops a run that has already been asked', () => {
    const p = computeSequenceProgress(nodes, [], new Set([PARENT.toLowerCase()]));
    expect(p.groupsRemaining).toBe(1);
  });

  it('ignores an only child — there is no order to decide', () => {
    const p = computeSequenceProgress([node(PARENT, null), node(A, PARENT)], [], new Set());
    expect(p.groupsRemaining).toBe(0);
    expect(p.nodesRemaining).toBe(0);
    expect(p.passesRemaining).toBe(0);
  });

  it('reports the passes a large plan still needs', () => {
    // One parent per run, two children each, more runs than one pass can cover.
    const many: PlanSequenceNode[] = [];
    for (let i = 0; i < SEQUENCE_AGENTS_PER_PASS + 5; i++) {
      const p = `p${i}`;
      many.push(node(p, null), node(`${p}-a`, p), node(`${p}-b`, p));
    }
    const p = computeSequenceProgress(many, [], new Set());
    expect(p.groupsRemaining).toBe(SEQUENCE_AGENTS_PER_PASS + 5);
    expect(p.passesRemaining).toBe(2);
  });
});
