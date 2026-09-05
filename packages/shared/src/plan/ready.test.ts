import { describe, it, expect } from 'vitest';
import { computePlanReady, type PlanReadyNode } from './ready.js';
import { computePlanSequence, type PlanSequenceEdge, type PlanSequenceNode } from './sequence.js';
import type { PlanNodeKind, PlanNodeStatus } from '../schemas/plan.js';

let counter = 0;
/** Readable ids that are still uuid-shaped, as in `sequence.test.ts`. */
function id(name: string): string {
  counter++;
  return `${name.padEnd(8, '0').slice(0, 8)}-0000-4000-8000-${String(counter).padStart(12, '0')}`;
}

/** A fixture node satisfying BOTH input shapes at once: the sequence is computed
 *  from one and readiness from the other, and a test that built them separately
 *  could drift them apart. `path` is materialised the way `applyPlanPatch` does. */
type Fixture = PlanSequenceNode & PlanReadyNode;

function tree(): {
  add: (
    parent: Fixture | null,
    name: string,
    over?: Partial<Omit<Fixture, 'id' | 'path'>>,
  ) => Fixture;
  nodes: Fixture[];
} {
  const nodes: Fixture[] = [];
  const add = (
    parent: Fixture | null,
    name: string,
    over: Partial<Omit<Fixture, 'id' | 'path'>> = {},
  ): Fixture => {
    const nodeId = id(name);
    const node: Fixture = {
      id: nodeId,
      parentId: parent?.id ?? null,
      path: `${parent ? parent.path : '/'}${nodeId}/`,
      ordinal: nodes.filter((n) => n.parentId === (parent?.id ?? null)).length,
      title: name,
      kind: 'component' as PlanNodeKind,
      status: 'todo' as PlanNodeStatus,
      taskable: true,
      ...over,
    };
    nodes.push(node);
    return node;
  };
  return { add, nodes };
}

function dep(from: Fixture, to: Fixture): PlanSequenceEdge {
  return { fromNodeId: from.id, toNodeId: to.id, kind: 'depends_on' };
}

function ready(
  nodes: Fixture[],
  edges: PlanSequenceEdge[] = [],
  openTasks: string[] = [],
): { titles: string[]; nextTitle: string | null } {
  const derived = computePlanSequence(nodes, edges);
  const result = computePlanReady(nodes, derived, new Set(openTasks));
  const titleById = new Map(nodes.map((n) => [n.id, n.title]));
  return {
    titles: result.readyIds.map((i) => titleById.get(i)!),
    nextTitle: result.nextId ? (titleById.get(result.nextId) ?? null) : null,
  };
}

describe('computePlanReady', () => {
  it('offers taskable todo leaves in build order', () => {
    const t = tree();
    const root = t.add(null, 'root', { taskable: false });
    t.add(root, 'first');
    t.add(root, 'second');

    // Post-order numbers both children before the root, and the root is not
    // taskable, so the answer is the two leaves in the order they were written.
    expect(ready(t.nodes)).toEqual({ titles: ['first', 'second'], nextTitle: 'first' });
  });

  it('drops a node whose own prerequisite is unfinished', () => {
    const t = tree();
    const root = t.add(null, 'root', { taskable: false });
    const api = t.add(root, 'api');
    const schema = t.add(root, 'schema');

    expect(ready(t.nodes, [dep(api, schema)]).titles).toEqual(['schema']);
  });

  it('drops a node whose ANCESTOR is waiting, which the direct rule does not', () => {
    // The measurement this module exists for: `blockedById` says the leaf is
    // ready because the leaf itself declares nothing, while its container cannot
    // start at all.
    const t = tree();
    const root = t.add(null, 'root', { taskable: false });
    const foundation = t.add(root, 'foundation');
    const feature = t.add(root, 'feature', { taskable: false });
    const leaf = t.add(feature, 'leaf');
    const edges = [dep(feature, foundation)];

    const derived = computePlanSequence(t.nodes, edges);
    expect(derived.blockedById.has(leaf.id)).toBe(false);
    expect(ready(t.nodes, edges).titles).toEqual(['foundation']);
  });

  it('offers the leaf again once the ancestor is unblocked', () => {
    const t = tree();
    const root = t.add(null, 'root', { taskable: false });
    const foundation = t.add(root, 'foundation', { status: 'done' });
    const feature = t.add(root, 'feature', { taskable: false });
    t.add(feature, 'leaf');

    expect(ready(t.nodes, [dep(feature, foundation)]).titles).toEqual(['leaf']);
  });

  it('drops a node whose prerequisite is settled on its own row but has an unfinished child', () => {
    // Readiness rides the rolled-up status, so a container is not a met
    // prerequisite while anything inside it is outstanding.
    const t = tree();
    const root = t.add(null, 'root', { taskable: false });
    const foundation = t.add(root, 'foundation', { status: 'done', taskable: false });
    t.add(foundation, 'inner');
    const feature = t.add(root, 'feature');

    expect(ready(t.nodes, [dep(feature, foundation)]).titles).toEqual(['inner']);
  });

  it('drops a node that already has an open task', () => {
    const t = tree();
    const root = t.add(null, 'root', { taskable: false });
    const first = t.add(root, 'first');
    t.add(root, 'second');

    expect(ready(t.nodes, [], [first.id]).titles).toEqual(['second']);
  });

  it('drops anything that is not `todo`', () => {
    const t = tree();
    const root = t.add(null, 'root', { taskable: false });
    t.add(root, 'running', { status: 'in_progress' });
    t.add(root, 'finished', { status: 'done' });
    t.add(root, 'waived', { status: 'not_applicable' });
    t.add(root, 'human', { status: 'blocked_human' });
    t.add(root, 'open');

    expect(ready(t.nodes).titles).toEqual(['open']);
  });

  it('requires `taskable` for a component but not for research or external', () => {
    const t = tree();
    const root = t.add(null, 'root', { taskable: false });
    t.add(root, 'undecomposed', { taskable: false });
    t.add(root, 'question', { kind: 'research', taskable: false });
    t.add(root, 'contract', { kind: 'external', taskable: false });

    expect(ready(t.nodes).titles).toEqual(['question', 'contract']);
  });

  it('drops a research or external node that still has children', () => {
    const t = tree();
    const root = t.add(null, 'root', { taskable: false });
    const question = t.add(root, 'question', { kind: 'research', taskable: false });
    t.add(question, 'sub-question', { kind: 'research', taskable: false });

    expect(ready(t.nodes).titles).toEqual(['sub-question']);
  });

  it('drops every node in a dependency cycle and everything under it', () => {
    // A cycle can never be satisfied, so its members never lose their blockers —
    // which is what keeps them and their subtrees out with no defect test here.
    const t = tree();
    const root = t.add(null, 'root', { taskable: false });
    const a = t.add(root, 'a', { taskable: false });
    const b = t.add(root, 'b');
    const underA = t.add(a, 'under-a');
    const free = t.add(root, 'free');
    const edges = [dep(a, b), dep(b, a)];

    const result = ready(t.nodes, edges);
    expect(result.titles).toEqual(['free']);
    expect(result.titles).not.toContain(underA.title);
    expect(result.nextTitle).toBe(free.title);
  });

  it('answers nothing when the whole plan is settled', () => {
    const t = tree();
    const root = t.add(null, 'root', { status: 'done', taskable: false });
    t.add(root, 'shipped', { status: 'done' });

    expect(ready(t.nodes)).toEqual({ titles: [], nextTitle: null });
  });

  it('orders by build number, not by input order', () => {
    // Deepest-leftmost first: the second root's leaf is numbered before its own
    // container, and the input deliberately lists the containers first.
    const t = tree();
    const root = t.add(null, 'root', { taskable: false });
    const later = t.add(root, 'later', { taskable: false });
    const earlier = t.add(root, 'earlier', { taskable: false });
    const deep = t.add(later, 'deep');
    const shallow = t.add(earlier, 'shallow');

    const derived = computePlanSequence(t.nodes, []);
    expect(derived.sequenceById.get(deep.id)).toBeLessThan(derived.sequenceById.get(shallow.id)!);
    expect(ready(t.nodes).titles).toEqual(['deep', 'shallow']);
  });
});
