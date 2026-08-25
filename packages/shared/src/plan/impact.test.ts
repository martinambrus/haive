import { describe, it, expect } from 'vitest';
import { computeImpact, renderImpactMermaid } from './impact.js';
import type { PlanEdgeRecord } from './read.js';

let seq = 0;
const edge = (
  from: string,
  to: string,
  kind: PlanEdgeRecord['kind'] = 'affects',
): PlanEdgeRecord => ({ id: `e${seq++}`, fromNodeId: from, toNodeId: to, kind, note: null });

describe('computeImpact', () => {
  it('walks forward one hop at a time', () => {
    const r = computeImpact('a', [edge('a', 'b'), edge('b', 'c')], { bidirectional: false });
    expect(r.hops.map((h) => [h.nodeId, h.depth])).toEqual([
      ['b', 1],
      ['c', 2],
    ]);
    expect(r.truncated).toBeNull();
  });

  it('terminates on a cycle instead of looping forever', () => {
    // The failure this module exists to avoid: a recursive CTE without dedup
    // never returns on this graph.
    const r = computeImpact('a', [edge('a', 'b'), edge('b', 'c'), edge('c', 'a')], {
      bidirectional: false,
    });
    expect(r.hops.map((h) => h.nodeId).sort()).toEqual(['b', 'c']);
    expect(r.truncated).toBeNull();
  });

  it('terminates on a two-node mutual cycle', () => {
    const r = computeImpact('a', [edge('a', 'b'), edge('b', 'a')]);
    expect(r.hops.map((h) => h.nodeId)).toEqual(['b']);
  });

  it('follows edges pointing at the origin too by default', () => {
    const r = computeImpact('b', [edge('a', 'b')]);
    expect(r.hops.map((h) => [h.nodeId, h.reversed])).toEqual([['a', true]]);
  });

  it('honours bidirectional:false', () => {
    expect(computeImpact('b', [edge('a', 'b')], { bidirectional: false }).hops).toEqual([]);
  });

  it('reports a depth cap rather than truncating silently', () => {
    const r = computeImpact('a', [edge('a', 'b'), edge('b', 'c'), edge('c', 'd')], {
      maxDepth: 2,
      bidirectional: false,
    });
    expect(r.hops.map((h) => h.nodeId)).toEqual(['b', 'c']);
    expect(r.truncated).toEqual({ reason: 'depth', limit: 2 });
  });

  it('does not claim truncation when the last level is simply the end', () => {
    // Over-reporting would mark nearly every result incomplete and train the
    // reader to ignore the warning.
    const r = computeImpact('a', [edge('a', 'b'), edge('b', 'c')], {
      maxDepth: 2,
      bidirectional: false,
    });
    expect(r.truncated).toBeNull();
  });

  it('reports a node cap', () => {
    const edges = ['b', 'c', 'd', 'e'].map((t) => edge('a', t));
    const r = computeImpact('a', edges, { maxNodes: 2, bidirectional: false });
    expect(r.hops).toHaveLength(2);
    expect(r.truncated).toEqual({ reason: 'nodes', limit: 2 });
  });

  it('filters to the requested edge kinds', () => {
    const r = computeImpact('a', [edge('a', 'b', 'affects'), edge('a', 'c', 'implements')], {
      kinds: ['affects'],
      bidirectional: false,
    });
    expect(r.hops.map((h) => h.nodeId)).toEqual(['b']);
  });

  it('records how each node was reached', () => {
    const r = computeImpact('a', [edge('a', 'b', 'depends_on')], { bidirectional: false });
    expect(r.hops[0]).toMatchObject({ viaNodeId: 'a', viaKind: 'depends_on', reversed: false });
  });
});

describe('renderImpactMermaid', () => {
  const titles = new Map([
    ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Origin'],
    ['bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'Target'],
  ]);
  const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

  it('emits a flowchart with the origin marked', () => {
    const out = renderImpactMermaid(computeImpact(A, [edge(A, B)]), titles);
    expect(out.startsWith('flowchart TD')).toBe(true);
    expect(out).toContain(':::origin');
    expect(out).toContain('"Origin"');
    expect(out).toContain('"Target"');
  });

  it('strips quotes and newlines from titles', () => {
    // Titles are LLM- or user-authored, and mermaid renders at securityLevel
    // 'strict' — an unescaped quote would end the label and turn the rest of the
    // title into diagram syntax.
    const hostile = new Map([
      [A, 'Say "hi"\nflowchart LR'],
      [B, 'ok'],
    ]);
    const out = renderImpactMermaid(computeImpact(A, [edge(A, B)]), hostile);
    expect(out).not.toContain('Say "hi"');
    expect(out.split('\n').filter((l) => l.trim().startsWith('flowchart'))).toHaveLength(1);
  });

  it('renders a reversed hop with a dotted arrow', () => {
    const out = renderImpactMermaid(computeImpact(B, [edge(A, B)]), titles);
    expect(out).toContain('-.->');
  });

  it('encodes node ids as a recoverable pnode token', () => {
    // The browser recovers the uuid from THIS token, not from mermaid's
    // surrounding decoration (`<renderId>-flowchart-<id>-<index>`), which is an
    // internal convention. A version that keyed on mermaid's prefix bound zero
    // click handlers and failed silently.
    const out = renderImpactMermaid(computeImpact(A, [edge(A, B)]), titles);
    expect(out).toContain(`pnode${A.replace(/-/g, '')}`);
    expect(out).toContain(`pnode${B.replace(/-/g, '')}`);
    const recovered = /pnode([0-9a-f]{32})/i.exec(out)?.[1];
    expect(recovered).toBe(A.replace(/-/g, ''));
  });
});
