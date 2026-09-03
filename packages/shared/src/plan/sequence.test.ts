import { describe, it, expect } from 'vitest';
import {
  computePlanSequence,
  orderSiblingsByDependency,
  type PlanSequenceEdge,
  type PlanSequenceNode,
} from './sequence.js';
import type { PlanNodeStatus } from '../schemas/plan.js';

let counter = 0;
/** Readable ids that are still uuid-shaped, so a fixture reads like the thing it
 *  stands for rather than like sixteen bytes of hex. */
function id(name: string): string {
  counter++;
  return `${name.padEnd(8, '0').slice(0, 8)}-0000-4000-8000-${String(counter).padStart(12, '0')}`;
}

function node(
  nodeId: string,
  parentId: string | null,
  ordinal: number,
  over: Partial<PlanSequenceNode> = {},
): PlanSequenceNode {
  return { id: nodeId, parentId, ordinal, title: nodeId.slice(0, 8), status: 'todo', ...over };
}

function dep(from: string, to: string): PlanSequenceEdge {
  return { fromNodeId: from, toNodeId: to, kind: 'depends_on' };
}

/** node id -> number, for readable assertions. */
function numbers(nodes: PlanSequenceNode[], edges: PlanSequenceEdge[] = []): Map<string, number> {
  return computePlanSequence(nodes, edges).sequenceById;
}

describe('computePlanSequence — numbering', () => {
  it('numbers every child before its container', () => {
    // The brief's own example: four sub-nodes are 1..4 and the node containing
    // them is 5. That ordering is the point — a container is finished when the
    // things inside it are.
    const root = id('root');
    const parent = id('parent');
    const kids = [id('a'), id('b'), id('c'), id('d')];
    const nodes = [
      node(root, null, 0),
      node(parent, root, 0),
      ...kids.map((k, i) => node(k, parent, i)),
    ];

    const seq = numbers(nodes);
    expect(kids.map((k) => seq.get(k))).toEqual([1, 2, 3, 4]);
    expect(seq.get(parent)).toBe(5);
    expect(seq.get(root)).toBe(6);
  });

  it('renumbers when a sub-node is added, shifting the tail by one', () => {
    // "add a sub-node to node 5, so node 5 becomes 6 and the new one becomes 5,
    // and everything above shifts by one". Nothing renumbers anything — the two
    // trees are simply numbered independently, which is the whole argument for
    // deriving rather than storing.
    const root = id('root');
    const parent = id('parent');
    const later = id('later');
    const kids = [id('a'), id('b'), id('c'), id('d')];
    const before = [
      node(root, null, 0),
      node(parent, root, 0),
      ...kids.map((k, i) => node(k, parent, i)),
      node(later, root, 1),
    ];
    const beforeSeq = numbers(before);
    expect(beforeSeq.get(parent)).toBe(5);
    expect(beforeSeq.get(later)).toBe(6);

    const added = id('added');
    const after = [...before.slice(0, -1), node(added, parent, 4), before.at(-1)!];
    const afterSeq = numbers(after);
    expect(afterSeq.get(added)).toBe(5);
    expect(afterSeq.get(parent)).toBe(6);
    expect(afterSeq.get(later)).toBe(7);
  });

  it('follows stored sibling order, not id or insertion order', () => {
    const root = id('root');
    const first = id('first');
    const second = id('second');
    // Input arrives the way the loader returns it: ORDER BY ordinal.
    const seq = numbers([node(root, null, 0), node(second, root, 0), node(first, root, 1)]);
    expect(seq.get(second)).toBe(1);
    expect(seq.get(first)).toBe(2);
  });

  it('does not let depends_on edges reorder the numbering', () => {
    // The refinement is a WRITE-side helper. A read that silently re-ordered on
    // top of `ordinal` would disagree with the canvas, with plan.json, and with
    // the order a person set by hand — with no way to override it.
    const root = id('root');
    const a = id('a');
    const b = id('b');
    const nodes = [node(root, null, 0), node(a, root, 0), node(b, root, 1)];
    expect(numbers(nodes, [dep(a, b)]).get(a)).toBe(1);
  });

  it('numbers a deep chain from the bottom up', () => {
    const ids = [id('l0'), id('l1'), id('l2'), id('l3')];
    const nodes = ids.map((n, i) => node(n, i === 0 ? null : ids[i - 1]!, 0));
    const seq = numbers(nodes);
    expect(ids.map((n) => seq.get(n))).toEqual([4, 3, 2, 1]);
  });

  it('still numbers a node whose parent is missing from the input', () => {
    // A view that silently omits a node is worse than one that shows it last.
    const root = id('root');
    const orphan = id('orphan');
    const seq = numbers([node(root, null, 0), node(orphan, id('gone'), 0)]);
    expect(seq.get(root)).toBe(1);
    expect(seq.get(orphan)).toBe(2);
  });

  it('assigns a distinct number to every node', () => {
    const root = id('root');
    const nodes = [node(root, null, 0)];
    for (let i = 0; i < 20; i++) nodes.push(node(id(`n${i}`), root, i));
    const seq = numbers(nodes);
    expect(new Set(seq.values()).size).toBe(nodes.length);
    expect(Math.max(...seq.values())).toBe(nodes.length);
  });
});

describe('computePlanSequence — stats', () => {
  it('counts direct children and total descendants, and rolls status up', () => {
    const root = id('root');
    const mid = id('mid');
    const leaf = id('leaf');
    const stats = computePlanSequence(
      [
        node(root, null, 0),
        node(mid, root, 0, { status: 'done' }),
        node(leaf, mid, 0, { status: 'todo' }),
      ],
      [],
    ).statsById;

    expect(stats.get(root)).toMatchObject({ directChildren: 1, totalDescendants: 2 });
    expect(stats.get(mid)).toMatchObject({ directChildren: 1, totalDescendants: 1 });
    // A parent marked done over an unfinished child is a bookkeeping error, not
    // a claim to be honoured.
    expect(stats.get(mid)!.rolledStatus).toBe('in_progress');
    expect(stats.get(leaf)!.rolledStatus).toBe('todo');
  });
});

describe('computePlanSequence — blocking', () => {
  const build = (
    targetStatus: PlanNodeStatus,
  ): { blocked: Map<string, unknown>; from: string; to: string } => {
    const root = id('root');
    const from = id('from');
    const to = id('to');
    const result = computePlanSequence(
      [node(root, null, 0), node(to, root, 0, { status: targetStatus }), node(from, root, 1)],
      [dep(from, to)],
    );
    return { blocked: result.blockedById, from, to };
  };

  it('blocks on an unmet prerequisite and names it by number', () => {
    const root = id('root');
    const from = id('from');
    const to = id('to');
    const result = computePlanSequence(
      [node(root, null, 0), node(to, root, 0), node(from, root, 1)],
      [dep(from, to)],
    );
    expect(result.blockedById.get(from)).toEqual([
      { nodeId: to, sequence: result.sequenceById.get(to), title: expect.any(String) },
    ]);
  });

  it.each(['done', 'not_applicable'] as PlanNodeStatus[])(
    'treats a %s prerequisite as settled',
    (status) => {
      const { blocked, from } = build(status);
      expect(blocked.has(from)).toBe(false);
    },
  );

  it.each(['todo', 'in_progress', 'blocked_human'] as PlanNodeStatus[])(
    'treats a %s prerequisite as outstanding',
    (status) => {
      const { blocked, from } = build(status);
      expect(blocked.has(from)).toBe(true);
    },
  );

  it('judges a prerequisite by its ROLLED status, not its own', () => {
    // A container marked done whose children are not is not a finished
    // prerequisite, whatever its own row says.
    const root = id('root');
    const from = id('from');
    const container = id('cont');
    const child = id('child');
    const result = computePlanSequence(
      [
        node(root, null, 0),
        node(container, root, 0, { status: 'done' }),
        node(child, container, 0, { status: 'todo' }),
        node(from, root, 1),
      ],
      [dep(from, container)],
    );
    expect(result.blockedById.has(from)).toBe(true);
  });

  it('does not inherit a block down to children', () => {
    // Post-order already builds children before their parent, so a parent's
    // prerequisite is a statement about the PARENT. Inheriting would mark most
    // of a deep tree blocked and say nothing.
    const root = id('root');
    const parent = id('parent');
    const child = id('child');
    const target = id('target');
    const result = computePlanSequence(
      [node(root, null, 0), node(target, root, 0), node(parent, root, 1), node(child, parent, 0)],
      [dep(parent, target)],
    );
    expect(result.blockedById.has(parent)).toBe(true);
    expect(result.blockedById.has(child)).toBe(false);
  });

  it('lists several blockers lowest number first', () => {
    const root = id('root');
    const from = id('from');
    const early = id('early');
    const late = id('late');
    const result = computePlanSequence(
      [node(root, null, 0), node(early, root, 0), node(late, root, 1), node(from, root, 2)],
      [dep(from, late), dep(from, early)],
    );
    const seqs = result.blockedById.get(from)!.map((b) => b.sequence);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(seqs[0]).toBe(result.sequenceById.get(early));
  });

  it('ignores affects and implements edges', () => {
    const root = id('root');
    const from = id('from');
    const to = id('to');
    const nodes = [node(root, null, 0), node(to, root, 0), node(from, root, 1)];
    for (const kind of ['affects', 'implements'] as const) {
      const result = computePlanSequence(nodes, [{ fromNodeId: from, toNodeId: to, kind }]);
      expect(result.blockedById.size).toBe(0);
    }
  });

  it('ignores an edge whose endpoint is not in the plan', () => {
    const root = id('root');
    const from = id('from');
    const result = computePlanSequence(
      [node(root, null, 0), node(from, root, 0)],
      [dep(from, id('ghost'))],
    );
    expect(result.blockedById.size).toBe(0);
  });
});

describe('computePlanSequence — defects', () => {
  it('reports a mutual depends_on pair as a cycle', () => {
    // MEASURED on the dev install: 8 such pairs on one plan. Neither end can
    // ever unblock, so this is a plan defect rather than something to wait for.
    const root = id('root');
    const a = id('a');
    const b = id('b');
    const result = computePlanSequence(
      [node(root, null, 0), node(a, root, 0), node(b, root, 1)],
      [dep(a, b), dep(b, a)],
    );
    expect(result.cycles).toHaveLength(1);
    expect([...result.cycles[0]!].sort()).toEqual([a, b].sort());
  });

  it('reports a longer cycle once, not once per entry point', () => {
    const root = id('root');
    const a = id('a');
    const b = id('b');
    const c = id('c');
    const result = computePlanSequence(
      [node(root, null, 0), node(a, root, 0), node(b, root, 1), node(c, root, 2)],
      [dep(a, b), dep(b, c), dep(c, a)],
    );
    expect(result.cycles).toHaveLength(1);
    expect(result.cycles[0]).toHaveLength(3);
  });

  it('reports no cycle for a plain chain or a diamond', () => {
    const root = id('root');
    const a = id('a');
    const b = id('b');
    const c = id('c');
    const result = computePlanSequence(
      [node(root, null, 0), node(a, root, 0), node(b, root, 1), node(c, root, 2)],
      [dep(a, b), dep(a, c), dep(b, c)],
    );
    expect(result.cycles).toEqual([]);
  });

  it('reports a dependency on the node’s own ancestor', () => {
    // Unsatisfiable in the other direction: the roll-up cannot green the
    // ancestor while the descendant waiting on it is outstanding.
    const root = id('root');
    const parent = id('parent');
    const child = id('child');
    const result = computePlanSequence(
      [node(root, null, 0), node(parent, root, 0), node(child, parent, 0)],
      [dep(child, parent)],
    );
    expect(result.ancestorDeps).toEqual([{ fromNodeId: child, toNodeId: parent }]);
  });

  it('does not call a dependency on a cousin an ancestor dependency', () => {
    const root = id('root');
    const left = id('left');
    const right = id('right');
    const leftKid = id('lkid');
    const result = computePlanSequence(
      [node(root, null, 0), node(left, root, 0), node(leftKid, left, 0), node(right, root, 1)],
      [dep(leftKid, right)],
    );
    expect(result.ancestorDeps).toEqual([]);
  });
});

describe('orderSiblingsByDependency', () => {
  it('puts a prerequisite before the sibling waiting on it', () => {
    const parent = id('parent');
    const a = id('a');
    const b = id('b');
    const run = [node(a, parent, 0), node(b, parent, 1)];
    const { ordered, contradictory } = orderSiblingsByDependency(run, [dep(a, b)]);
    expect(ordered.map((n) => n.id)).toEqual([b, a]);
    expect(contradictory).toBe(false);
  });

  it('leaves a run that declares nothing exactly as it was', () => {
    const parent = id('parent');
    const run = [0, 1, 2, 3].map((i) => node(id(`n${i}`), parent, i));
    expect(orderSiblingsByDependency(run, []).ordered).toEqual(run);
  });

  it('breaks ties by stored order, so the result is stable', () => {
    const parent = id('parent');
    const first = id('first');
    const second = id('second');
    const last = id('last');
    const run = [node(first, parent, 0), node(second, parent, 1), node(last, parent, 2)];
    // Both `first` and `second` are ready; the earlier stored one wins.
    const { ordered } = orderSiblingsByDependency(run, [dep(last, first)]);
    expect(ordered.map((n) => n.id)).toEqual([first, second, last]);
  });

  it('keeps stored order and says so when the edges contradict each other', () => {
    const parent = id('parent');
    const a = id('a');
    const b = id('b');
    const run = [node(a, parent, 0), node(b, parent, 1)];
    const { ordered, contradictory } = orderSiblingsByDependency(run, [dep(a, b), dep(b, a)]);
    expect(ordered.map((n) => n.id)).toEqual([a, b]);
    expect(contradictory).toBe(true);
  });

  it('reports `decided` only when the edges pin exactly one order', () => {
    // The sequencing step spends an agent on a run the edges left a choice in,
    // and skips one they already settled.
    const parent = id('parent');
    const a = id('a');
    const b = id('b');
    const c = id('c');
    const run = [node(a, parent, 0), node(b, parent, 1), node(c, parent, 2)];
    // A total chain: c before b before a. Nothing is ever ambiguous.
    expect(orderSiblingsByDependency(run, [dep(a, b), dep(b, c)]).decided).toBe(true);
    // One edge leaves two nodes ready at the first step.
    expect(orderSiblingsByDependency(run, [dep(a, b)]).decided).toBe(false);
    // No edges at all decide nothing, however short the run.
    expect(orderSiblingsByDependency(run, []).decided).toBe(false);
    // A contradiction is never "decided".
    expect(orderSiblingsByDependency(run, [dep(a, b), dep(b, a)]).decided).toBe(false);
  });

  it('calls a single child decided, since there is no order to choose', () => {
    const parent = id('parent');
    expect(orderSiblingsByDependency([node(id('only'), parent, 0)], []).decided).toBe(true);
  });

  it('ignores a dependency on a node outside the run', () => {
    const parent = id('parent');
    const a = id('a');
    const b = id('b');
    const run = [node(a, parent, 0), node(b, parent, 1)];
    const { ordered, contradictory } = orderSiblingsByDependency(run, [dep(a, id('elsewhere'))]);
    expect(ordered.map((n) => n.id)).toEqual([a, b]);
    expect(contradictory).toBe(false);
  });
});
