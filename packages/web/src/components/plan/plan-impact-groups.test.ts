import { describe, expect, it } from 'vitest';
import type { PlanImpactHop } from '@/lib/api-client';
import { defaultOpenImpactDepths, groupImpactHops } from './plan-impact-groups';

function hop(nodeId: string, depth: number): PlanImpactHop {
  return {
    nodeId,
    depth,
    viaNodeId: 'origin',
    viaKind: 'depends_on',
    reversed: false,
    title: nodeId,
    status: 'todo',
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

  it('keeps the order the walk found them inside a group', () => {
    // Stable across refetches, so a list does not reshuffle under the reader.
    const groups = groupImpactHops([hop('z', 1), hop('a', 1), hop('m', 1)]);
    expect(groups[0]!.hops.map((h) => h.nodeId)).toEqual(['z', 'a', 'm']);
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
