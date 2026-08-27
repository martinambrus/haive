import { describe, it, expect } from 'vitest';
import { IMPACT_DIAGRAM_MAX_NODES, computeImpact, renderImpactMermaid } from './impact.js';
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
    const { source, omitted } = renderImpactMermaid(computeImpact(A, [edge(A, B)]), titles);
    // LR, not TD: top-down lays one BFS level out as a ROW, which is how a
    // 122-node level became a 45,871px-wide diagram.
    expect(source.startsWith('flowchart LR')).toBe(true);
    expect(source).toContain(':::origin');
    expect(source).toContain('"Origin"');
    expect(source).toContain('"Target"');
    expect(omitted).toBe(0);
  });

  it('strips quotes and newlines from titles', () => {
    // Titles are LLM- or user-authored, and mermaid renders at securityLevel
    // 'strict' — an unescaped quote would end the label and turn the rest of the
    // title into diagram syntax.
    const hostile = new Map([
      [A, 'Say "hi"\nflowchart LR'],
      [B, 'ok'],
    ]);
    const { source } = renderImpactMermaid(computeImpact(A, [edge(A, B)]), hostile);
    expect(source).not.toContain('Say "hi"');
    expect(source.split('\n').filter((l) => l.trim().startsWith('flowchart'))).toHaveLength(1);
  });

  it('renders a reversed hop with a dotted arrow', () => {
    const { source } = renderImpactMermaid(computeImpact(B, [edge(A, B)]), titles);
    expect(source).toContain('-.->');
  });

  it('encodes node ids as a recoverable pnode token', () => {
    // The browser recovers the uuid from THIS token, not from mermaid's
    // surrounding decoration (`<renderId>-flowchart-<id>-<index>`), which is an
    // internal convention. A version that keyed on mermaid's prefix bound zero
    // click handlers and failed silently.
    const { source } = renderImpactMermaid(computeImpact(A, [edge(A, B)]), titles);
    expect(source).toContain(`pnode${A.replace(/-/g, '')}`);
    expect(source).toContain(`pnode${B.replace(/-/g, '')}`);
    const recovered = /pnode([0-9a-f]{32})/i.exec(source)?.[1];
    expect(recovered).toBe(A.replace(/-/g, ''));
  });
});

describe('the diagram cap', () => {
  // A hub with many spokes: exactly the shape that made a real diagram
  // 45,871px wide. Every spoke is one hop from the origin.
  const HUB = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const spoke = (i: number) => `bbbbbbbb-bbbb-4bbb-8bbb-${String(i).padStart(12, '0')}`;
  const spokes = Array.from({ length: 60 }, (_, i) => spoke(i));
  const edges = spokes.map((s) => edge(HUB, s));
  const titles = new Map([[HUB, 'Hub'], ...spokes.map((s, i) => [s, `Spoke ${i}`] as const)]);

  it('draws only the nearest nodes and says how many it left', () => {
    const result = computeImpact(HUB, edges);
    const { source, omitted } = renderImpactMermaid(result, titles);
    const drawn = source.split('\n').filter((l) => /^\s+pnode\w+\[/.test(l));
    // origin + the cap
    expect(drawn).toHaveLength(IMPACT_DIAGRAM_MAX_NODES + 1);
    expect(omitted).toBe(60 - IMPACT_DIAGRAM_MAX_NODES);
  });

  it('caps the DIAGRAM only, never the walk', () => {
    // The list beside the diagram shows everything; the picture is the only
    // thing bounded. A cap that ate hops would be the silent truncation this
    // whole view exists to prevent.
    const result = computeImpact(HUB, edges);
    renderImpactMermaid(result, titles);
    expect(result.hops).toHaveLength(60);
  });

  it('honours an explicit cap', () => {
    const { source, omitted } = renderImpactMermaid(computeImpact(HUB, edges), titles, {
      maxNodes: 5,
    });
    expect(source.split('\n').filter((l) => /^\s+pnode\w+\[/.test(l))).toHaveLength(6);
    expect(omitted).toBe(55);
  });

  it('never draws an edge to a node it did not draw', () => {
    // Nearest-first is what guarantees this: a hop's via-node is always at a
    // shallower depth, so it is always at a lower index than the hop itself.
    const chain = ['a', 'b', 'c', 'd', 'e'].map(
      (c) => `${c.repeat(8)}-${c.repeat(4)}-4${c.repeat(3)}-8${c.repeat(3)}-${c.repeat(12)}`,
    );
    const chainEdges = chain.slice(0, -1).map((from, i) => edge(from, chain[i + 1]!));
    const chainTitles = new Map(chain.map((id, i) => [id, `N${i}`]));
    const { source } = renderImpactMermaid(computeImpact(chain[0]!, chainEdges), chainTitles, {
      maxNodes: 2,
    });
    const declared = new Set([...source.matchAll(/^\s+(pnode\w+)\[/gm)].map((m) => m[1]!));
    for (const [, a, b] of source.matchAll(/^\s+(pnode\w+) -[.-]?->\|[^|]*\| (pnode\w+)$/gm)) {
      expect(declared.has(a!)).toBe(true);
      expect(declared.has(b!)).toBe(true);
    }
  });

  it('shortens a label so the box does not set the diagram width', () => {
    const long = 'rs_dynamic_modules dialog: module picker & dynamic-module placeholder insertion';
    const { source } = renderImpactMermaid(
      computeImpact(HUB, [edge(HUB, spoke(0))]),
      new Map([
        [HUB, long],
        [spoke(0), 'short'],
      ]),
    );
    expect(source).not.toContain(long);
    expect(source).toContain('…');
    const widest = Math.max(...[...source.matchAll(/\["([^"]*)"\]/g)].map((m) => m[1]!.length));
    expect(widest).toBeLessThanOrEqual(40);
  });
});
