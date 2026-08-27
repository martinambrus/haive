import { describe, expect, it } from 'vitest';
import type { PlanImpactHop } from '@/lib/api-client';
import { defaultOpenImpactDepths, groupImpactHops } from './plan-impact-groups';

function hop(nodeId: string, depth: number, over: Partial<PlanImpactHop> = {}): PlanImpactHop {
  return {
    nodeId,
    depth,
    viaNodeId: 'origin',
    viaKind: 'depends_on',
    reversed: false,
    title: nodeId,
    status: 'todo',
    ...over,
  };
}

describe('groupImpactHops', () => {
  it('has nothing to group for a node nothing links to', () => {
    expect(groupImpactHops([])).toEqual([]);
  });

  it('splits the walk by distance, nearest group first', () => {
    const groups = groupImpactHops([hop('c', 2), hop('a', 1), hop('d', 3), hop('b', 1)]);
    expect(groups.map((g) => g.depth)).toEqual([1, 2, 3]);
    expect(groups[0]!.hops.map((h) => h.nodeId)).toEqual(['a', 'b']);
  });

  it('sorts a group by name, not by the order the walk found them', () => {
    // A group can hold over a hundred hops; the order the walk happened to
    // reach them gives the reader nothing to find a row by.
    const groups = groupImpactHops([hop('z', 1), hop('a', 1), hop('m', 1)]);
    expect(groups[0]!.hops.map((h) => h.nodeId)).toEqual(['a', 'm', 'z']);
  });

  it('pluralises the distance', () => {
    const groups = groupImpactHops([hop('a', 1), hop('b', 2)]);
    expect(groups.map((g) => g.label)).toEqual(['1 hop', '2 hops']);
  });

  it('drops nothing — this list is the complete answer', () => {
    // The diagram is the bounded surface. If this one truncated too, a short
    // list would read as "nothing else is affected", which is the failure the
    // whole view exists to prevent.
    const many = Array.from({ length: 250 }, (_, i) => hop(`n${i}`, (i % 4) + 1));
    const total = groupImpactHops(many).reduce((n, g) => n + g.hops.length, 0);
    expect(total).toBe(250);
  });

  it('does not invent a group for a depth nothing sits at', () => {
    // A walk can skip a level when the only path onward was already visited.
    expect(groupImpactHops([hop('a', 1), hop('c', 3)]).map((g) => g.depth)).toEqual([1, 3]);
  });
});

describe('defaultOpenImpactDepths', () => {
  it('opens the nearest group only', () => {
    // On a hub-shaped plan the second group holds over a hundred rows; opening
    // it by default buries the handful that answer the question.
    const groups = groupImpactHops([hop('a', 1), hop('b', 2), hop('c', 3)]);
    expect([...defaultOpenImpactDepths(groups)]).toEqual([1]);
  });

  it('opens whatever the nearest group turns out to be', () => {
    const groups = groupImpactHops([hop('b', 2), hop('c', 3)]);
    expect([...defaultOpenImpactDepths(groups)]).toEqual([2]);
  });

  it('opens nothing when there is nothing to open', () => {
    expect([...defaultOpenImpactDepths([])]).toEqual([]);
  });
});

describe('relation sub-groups', () => {
  it('splits a depth by how the walk reached each node', () => {
    const groups = groupImpactHops([
      hop('a', 1, { viaKind: 'depends_on' }),
      hop('b', 1, { viaKind: 'affects' }),
      hop('c', 1, { viaKind: 'depends_on' }),
    ]);
    expect(groups[0]!.relations.map((r) => [r.label, r.hops.length])).toEqual([
      ['Depends on', 2],
      ['Affects', 1],
    ]);
  });

  it('names a relation by the direction the walk crossed it', () => {
    // Direction is half the meaning: "depends on this" and "this depends on"
    // are opposite facts, and one heading for both states the wrong one for
    // every reversed hop.
    const groups = groupImpactHops([
      hop('a', 1, { viaKind: 'depends_on', reversed: false }),
      hop('b', 1, { viaKind: 'depends_on', reversed: true }),
    ]);
    expect(groups[0]!.relations.map((r) => r.label)).toEqual(['Depends on', 'Depended on by']);
  });

  it('emits only relations that are actually there', () => {
    // Unlike the Links tab, an empty group offers nothing here — there is no
    // "add a hop" action, a hop is something the walk found.
    const groups = groupImpactHops([hop('a', 1, { viaKind: 'implements' })]);
    expect(groups[0]!.relations).toHaveLength(1);
    expect(groups[0]!.relations[0]!.label).toBe('Implements');
  });

  it('sorts alphabetically inside a relation', () => {
    const groups = groupImpactHops([
      hop('n3', 1, { title: 'Zebra' }),
      hop('n1', 1, { title: 'Alpha' }),
      hop('n2', 1, { title: 'Mango' }),
    ]);
    expect(groups[0]!.relations[0]!.hops.map((h) => h.title)).toEqual(['Alpha', 'Mango', 'Zebra']);
  });

  it('sorts a hop the server could not name without throwing', () => {
    const groups = groupImpactHops([hop('n1', 1, { title: null }), hop('n2', 1, { title: 'A' })]);
    expect(groups[0]!.relations[0]!.hops).toHaveLength(2);
  });

  it('accounts for every hop in the depth exactly once', () => {
    // The sub-groups are a re-slice of the same set, never a filter of it.
    const hops = [
      hop('a', 2, { viaKind: 'affects', reversed: true }),
      hop('b', 2, { viaKind: 'implements' }),
      hop('c', 2, { viaKind: 'depends_on' }),
      hop('d', 2, { viaKind: 'affects', reversed: true }),
    ];
    const group = groupImpactHops(hops)[0]!;
    const inRelations = group.relations.flatMap((r) => r.hops.map((h) => h.nodeId));
    expect(inRelations.sort()).toEqual(['a', 'b', 'c', 'd']);
    expect(inRelations).toHaveLength(group.hops.length);
  });
});
