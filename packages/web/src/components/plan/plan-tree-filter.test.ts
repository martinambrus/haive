import { describe, expect, it } from 'vitest';
import { ancestorsOf, computeVisibleSet, flattenVisible } from './plan-tree-filter';

/** id -> parentId, the only two fields the filter reads. */
const nodes = [
  { id: 'root', parentId: null },
  { id: 'a', parentId: 'root' },
  { id: 'a1', parentId: 'a' },
  { id: 'a2', parentId: 'a' },
  { id: 'b', parentId: 'root' },
  { id: 'b1', parentId: 'b' },
];

describe('computeVisibleSet', () => {
  it('is not a filter when there is no search', () => {
    expect(computeVisibleSet(nodes, null)).toBeNull();
    expect(computeVisibleSet(nodes, undefined)).toBeNull();
  });

  it('keeps an empty result AS a filter', () => {
    // Zero hits must render "Nothing matched.", never silently unfilter.
    expect(computeVisibleSet(nodes, new Set())).toEqual(new Set());
  });

  it('keeps every ancestor of a match so the outline still locates it', () => {
    expect(computeVisibleSet(nodes, new Set(['a1']))).toEqual(new Set(['a1', 'a', 'root']));
  });

  it('unions the chains of several matches without duplicating work', () => {
    expect(computeVisibleSet(nodes, new Set(['a1', 'b1']))).toEqual(
      new Set(['a1', 'a', 'b1', 'b', 'root']),
    );
  });

  it('never adds a sibling that did not match', () => {
    const keep = computeVisibleSet(nodes, new Set(['a1']));
    expect(keep?.has('a2')).toBe(false);
    expect(keep?.has('b')).toBe(false);
  });

  it('terminates on a parent cycle', () => {
    // The edge graph has cycles by construction elsewhere in the plan; a
    // corrupt parent chain must not spin the browser.
    const cyclic = [
      { id: 'x', parentId: 'y' },
      { id: 'y', parentId: 'x' },
    ];
    expect(computeVisibleSet(cyclic, new Set(['x']))).toEqual(new Set(['x', 'y']));
  });

  it('stops walking at a parent id the node list does not contain', () => {
    // The unknown id is recorded and the walk ends there. Harmless: the tree
    // renders from its own node list and only consults this set for
    // visibility, so an id matching no node can never draw a row.
    const orphan = [{ id: 'lost', parentId: 'missing' }];
    expect(computeVisibleSet(orphan, new Set(['lost']))).toEqual(new Set(['lost', 'missing']));
  });
});

describe('ancestorsOf', () => {
  it('walks from the node up to the root, nearest first', () => {
    expect(ancestorsOf(nodes, 'a1')).toEqual(['a', 'root']);
  });

  it('returns nothing for a root', () => {
    expect(ancestorsOf(nodes, 'root')).toEqual([]);
  });

  it('returns nothing for a node it does not know', () => {
    expect(ancestorsOf(nodes, 'ghost')).toEqual([]);
  });

  it('stops on a parent cycle instead of spinning', () => {
    const cyclic = [
      { id: 'x', parentId: 'y' },
      { id: 'y', parentId: 'x' },
    ];
    expect(ancestorsOf(cyclic, 'x')).toEqual(['y']);
  });
});

describe('flattenVisible', () => {
  const none = new Set<string>();

  it('lists rows in the order they appear, with depth', () => {
    expect(flattenVisible(nodes, none, null).map((r) => [r.id, r.depth])).toEqual([
      ['root', 0],
      ['a', 1],
      ['a1', 2],
      ['a2', 2],
      ['b', 1],
      ['b1', 2],
    ]);
  });

  it('stops descending into a folded node but still lists it', () => {
    const rows = flattenVisible(nodes, new Set(['a']), null);
    expect(rows.map((r) => r.id)).toEqual(['root', 'a', 'b', 'b1']);
    expect(rows.find((r) => r.id === 'a')?.hasChildren).toBe(true);
  });

  it('ignores folds while a filter is active', () => {
    // A folded ancestor would hide the very matches the filter exists to show.
    const keep = computeVisibleSet(nodes, new Set(['a1']));
    const rows = flattenVisible(nodes, new Set(['a', 'root']), keep);
    expect(rows.map((r) => r.id)).toEqual(['root', 'a', 'a1']);
  });

  it('reports whether a node has VISIBLE children, not any children', () => {
    const keep = computeVisibleSet(nodes, new Set(['a']));
    const rows = flattenVisible(nodes, none, keep);
    expect(rows.find((r) => r.id === 'a')?.hasChildren).toBe(false);
  });

  it('terminates on a parent cycle', () => {
    const cyclic = [
      { id: 'x', parentId: null },
      { id: 'y', parentId: 'x' },
      { id: 'z', parentId: 'y' },
    ];
    expect(flattenVisible(cyclic, none, null).map((r) => r.id)).toEqual(['x', 'y', 'z']);
  });
});
