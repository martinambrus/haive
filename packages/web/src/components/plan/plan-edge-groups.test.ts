import { describe, expect, it } from 'vitest';
import { groupPlanEdges } from './plan-edge-groups';
import type { PlanEdge } from '@/lib/api-client';

const ME = 'me';
const edge = (over: Partial<PlanEdge>): PlanEdge => ({
  id: 'e1',
  fromNodeId: ME,
  toNodeId: 'other',
  kind: 'depends_on',
  note: null,
  fromTitle: 'Me',
  toTitle: 'Other',
  ...over,
});

describe('groupPlanEdges', () => {
  it('offers every outgoing kind even with no links at all', () => {
    // Each is a link the user can create from here, and a group that appears
    // only once it has content cannot offer the control that fills it.
    const groups = groupPlanEdges([], ME);
    expect(groups.map((g) => g.id)).toEqual(['depends_on:out', 'affects:out', 'implements:out']);
    expect(groups.every((g) => g.items.length === 0)).toBe(true);
  });

  it('separates the two directions of one kind', () => {
    const groups = groupPlanEdges(
      [
        edge({ id: 'out', fromNodeId: ME, toNodeId: 'x', toTitle: 'X' }),
        edge({ id: 'in', fromNodeId: 'y', toNodeId: ME, fromTitle: 'Y' }),
      ],
      ME,
    );
    expect(groups.map((g) => g.label)).toContain('Depended on by');
    expect(groups.find((g) => g.id === 'depends_on:out')?.items).toHaveLength(1);
    expect(groups[0]?.items).toEqual([{ edgeId: 'out', nodeId: 'x', title: 'X', note: null }]);
    expect(groups[1]?.items).toEqual([{ edgeId: 'in', nodeId: 'y', title: 'Y', note: null }]);
  });

  it('names each direction of every kind', () => {
    const groups = groupPlanEdges(
      [
        edge({ id: 'a', kind: 'affects', toNodeId: 'x', toTitle: 'X' }),
        edge({ id: 'b', kind: 'affects', fromNodeId: 'y', toNodeId: ME, fromTitle: 'Y' }),
        edge({ id: 'c', kind: 'implements', toNodeId: 'x', toTitle: 'X' }),
        edge({ id: 'd', kind: 'implements', fromNodeId: 'y', toNodeId: ME, fromTitle: 'Y' }),
      ],
      ME,
    );
    expect(groups.map((g) => g.label)).toEqual([
      'Depends on',
      'Affects',
      'Affected by',
      'Implements',
      'Implemented by',
    ]);
  });

  it('orders kinds consistently and puts outgoing before incoming', () => {
    const groups = groupPlanEdges(
      [
        edge({ id: 'i', kind: 'implements', toNodeId: 'x', toTitle: 'X' }),
        edge({ id: 'din', kind: 'depends_on', fromNodeId: 'y', toNodeId: ME, fromTitle: 'Y' }),
        edge({ id: 'dout', kind: 'depends_on', toNodeId: 'x', toTitle: 'X' }),
      ],
      ME,
    );
    expect(groups.map((g) => g.id)).toEqual([
      'depends_on:out',
      'depends_on:in',
      'affects:out',
      'implements:out',
    ]);
  });

  it('omits an INCOMING group with no links — nobody can create one from here', () => {
    const groups = groupPlanEdges([edge({ toNodeId: 'x', toTitle: 'X' })], ME);
    expect(groups.map((g) => g.id)).toEqual(['depends_on:out', 'affects:out', 'implements:out']);
  });

  it('names a link whose title the server did not send', () => {
    // Dropping the row would under-report what this node is connected to.
    const groups = groupPlanEdges([edge({ toNodeId: 'x', toTitle: null })], ME);
    expect(groups.find((g) => g.id === 'depends_on:out')?.items[0]?.title).toBe('Untitled node');
  });

  it('sorts each group by name, not by insertion order', () => {
    const groups = groupPlanEdges(
      [
        edge({ id: '1', toNodeId: 'c', toTitle: 'Charlie' }),
        edge({ id: '2', toNodeId: 'a', toTitle: 'alpha' }),
        edge({ id: '3', toNodeId: 'b', toTitle: 'Bravo' }),
      ],
      ME,
    );
    expect(groups[0]?.items.map((i) => i.title)).toEqual(['alpha', 'Bravo', 'Charlie']);
  });

  it('carries the id of the node on the OTHER end, whichever way the edge points', () => {
    const groups = groupPlanEdges(
      [
        edge({ id: 'out', fromNodeId: ME, toNodeId: 'x', toTitle: 'X' }),
        edge({ id: 'in', fromNodeId: 'y', toNodeId: ME, fromTitle: 'Y' }),
      ],
      ME,
    );
    expect(groups[0]?.items[0]?.nodeId).toBe('x');
    expect(groups[1]?.items[0]?.nodeId).toBe('y');
  });

  it('carries the note through', () => {
    const groups = groupPlanEdges([edge({ toNodeId: 'x', toTitle: 'X', note: 'why' })], ME);
    expect(groups.find((g) => g.id === 'depends_on:out')?.items[0]?.note).toBe('why');
  });

  it('ignores an edge that touches neither side of this node', () => {
    const groups = groupPlanEdges([edge({ fromNodeId: 'a', toNodeId: 'b' })], ME);
    expect(groups.every((g) => g.items.length === 0)).toBe(true);
  });
});
