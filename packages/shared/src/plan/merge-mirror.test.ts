import { describe, it, expect } from 'vitest';
import { mergePlanMirror, PLAN_MIRROR_ASKED_FIELDS } from './merge-mirror.js';
import type { PlanMirror, PlanMirrorPayload } from '../types/index.js';

type N = PlanMirror['nodes'][number];
type E = PlanMirror['edges'][number];
type L = PlanMirror['codeLinks'][number];

const ids = new Map<string, string>();
function id(name: string): string {
  let v = ids.get(name);
  if (!v) {
    v = `${String(ids.size + 1).padStart(8, '0')}-0000-4000-8000-000000000000`;
    ids.set(name, v);
  }
  return v;
}

function n(name: string, parent: string | null, ordinal = 0, over: Partial<N> = {}): N {
  return {
    id: id(name),
    parentId: parent === null ? null : id(parent),
    ordinal,
    title: name,
    kind: 'component',
    body: null,
    status: 'todo',
    taskable: true,
    ...over,
  };
}
const edge = (from: string, to: string, note: string | null = null): E => ({
  fromNodeId: id(from),
  toNodeId: id(to),
  kind: 'affects',
  note,
});
const link = (node: string, repoPath: string, over: Partial<L> = {}): L => ({
  nodeId: id(node),
  repoPath,
  symbol: null,
  evidence: null,
  derivedAtCommit: null,
  stale: false,
  role: 'implements',
  ...over,
});
const mirror = (nodes: N[], edges: E[] = [], codeLinks: L[] = []): PlanMirror => ({
  schemaVersion: 2,
  nodes,
  edges,
  codeLinks,
});

/** R -> A -> C, R -> B */
const baseNodes = (): N[] => [n('R', null), n('A', 'R', 0), n('B', 'R', 1), n('C', 'A', 0)];
const swap = (nodes: N[], name: string, over: Partial<N>): N[] =>
  nodes.map((x) => (x.id === id(name) ? { ...x, ...over } : x));
const without = (nodes: N[], ...names: string[]): N[] =>
  nodes.filter((x) => !names.some((nm) => id(nm) === x.id));
const byName = (m: PlanMirror, name: string): N | undefined =>
  m.nodes.find((x) => x.id === id(name));

function assertAcyclic(m: PlanMirror): void {
  const parent = new Map(m.nodes.map((x) => [x.id, x.parentId]));
  for (const x of m.nodes) {
    const seen = new Set<string>();
    for (let p: string | null = x.id; p !== null; p = parent.get(p) ?? null) {
      expect(seen.has(p)).toBe(false);
      seen.add(p);
      if (p !== x.id) expect(parent.has(p)).toBe(true);
    }
  }
}

describe('mergePlanMirror: node fields', () => {
  it('takes a field changed on one side only', () => {
    const base = mirror(baseNodes());
    const local = mirror(swap(baseNodes(), 'A', { title: 'A local' }));
    const incoming = mirror(swap(baseNodes(), 'B', { status: 'done' }));
    const r = mergePlanMirror({ base, local, incoming });
    expect(byName(r.merged, 'A')?.title).toBe('A local');
    expect(byName(r.merged, 'B')?.status).toBe('done');
    expect(r.conflicts).toEqual([]);
    expect(r.reported).toEqual([]);
  });

  it('keeps the value both sides changed the same way', () => {
    const base = mirror(baseNodes());
    const both = swap(baseNodes(), 'A', { title: 'same', body: 'text' });
    const r = mergePlanMirror({ base, local: mirror(both), incoming: mirror(both) });
    expect(byName(r.merged, 'A')).toMatchObject({ title: 'same', body: 'text' });
    expect(r.conflicts).toEqual([]);
  });

  it.each([
    ['title', 'old title', 'local title', 'incoming title'],
    ['body', null, 'local body', 'incoming body'],
    ['kind', 'component', 'decision', 'research'],
    ['status', 'todo', 'in_progress', 'done'],
  ] as const)(
    'conflicts on %s changed differently and keeps incoming in merged',
    (field, b, l, i) => {
      const at = (value: unknown): PlanMirror =>
        mirror(swap(baseNodes(), 'A', { [field]: value } as Partial<N>));
      const r = mergePlanMirror({ base: at(b), local: at(l), incoming: at(i) });
      expect(r.conflicts).toEqual([{ nodeId: id('A'), field, base: b, local: l, incoming: i }]);
      expect(byName(r.merged, 'A')?.[field]).toBe(i);
    },
  );

  it('a boolean flipped on one side goes through, since two flips agree', () => {
    const at = (taskable: boolean): PlanMirror => mirror(swap(baseNodes(), 'A', { taskable }));
    const r = mergePlanMirror({ base: at(true), local: at(false), incoming: at(true) });
    expect(byName(r.merged, 'A')?.taskable).toBe(false);
    expect(r.conflicts).toEqual([]);
  });

  it('conflicts on taskable when a node added on both sides differs', () => {
    const added = (taskable: boolean): PlanMirror =>
      mirror([...baseNodes(), n('N', 'R', 2, { taskable })]);
    const r = mergePlanMirror({
      base: mirror(baseNodes()),
      local: added(false),
      incoming: added(true),
    });
    expect(r.conflicts).toEqual([
      { nodeId: id('N'), field: 'taskable', base: undefined, local: false, incoming: true },
    ]);
    expect(byName(r.merged, 'N')?.taskable).toBe(true);
  });

  it('covers every asked field', () => {
    expect([...PLAN_MIRROR_ASKED_FIELDS]).toEqual(['title', 'body', 'kind', 'status', 'taskable']);
  });

  it('reports a conflict with base, local and incoming values', () => {
    const base = mirror(swap(baseNodes(), 'A', { body: 'old' }));
    const local = mirror(swap(baseNodes(), 'A', { body: 'mine' }));
    const incoming = mirror(swap(baseNodes(), 'A', { body: 'theirs' }));
    const r = mergePlanMirror({ base, local, incoming });
    expect(r.conflicts).toEqual([
      { nodeId: id('A'), field: 'body', base: 'old', local: 'mine', incoming: 'theirs' },
    ]);
    expect(byName(r.merged, 'A')?.body).toBe('theirs');
  });

  it('lets local win ordinal and parentId changed differently, and reports it', () => {
    const base = mirror(baseNodes());
    const local = mirror(swap(baseNodes(), 'C', { ordinal: 4, parentId: id('B') }));
    const incoming = mirror(swap(baseNodes(), 'C', { ordinal: 7, parentId: id('R') }));
    const r = mergePlanMirror({ base, local, incoming });
    expect(byName(r.merged, 'C')).toMatchObject({ ordinal: 4, parentId: id('B') });
    expect(r.conflicts).toEqual([]);
    expect(r.reported).toEqual(
      expect.arrayContaining([
        {
          kind: 'local-wins',
          subject: id('C'),
          field: 'parentId',
          local: id('B'),
          incoming: id('R'),
        },
        { kind: 'local-wins', subject: id('C'), field: 'ordinal', local: 4, incoming: 7 },
      ]),
    );
  });

  it('takes an ordinal or parent only one side changed', () => {
    const base = mirror(baseNodes());
    const local = mirror(swap(baseNodes(), 'B', { ordinal: 3 }));
    const incoming = mirror(swap(baseNodes(), 'C', { parentId: id('B') }));
    const r = mergePlanMirror({ base, local, incoming });
    expect(byName(r.merged, 'B')?.ordinal).toBe(3);
    expect(byName(r.merged, 'C')?.parentId).toBe(id('B'));
    expect(r.reported).toEqual([]);
  });

  it('keeps a node present only locally and adds one present only in incoming', () => {
    const base = mirror(baseNodes());
    const local = mirror([...baseNodes(), n('L', 'R', 2)]);
    const incoming = mirror([...baseNodes(), n('I', 'R', 2)]);
    const r = mergePlanMirror({ base, local, incoming });
    expect(byName(r.merged, 'L')).toBeDefined();
    expect(byName(r.merged, 'I')).toBeDefined();
    expect(r.deleted).toEqual([]);
    expect(r.resurrected).toEqual([]);
  });
});

describe('mergePlanMirror: deletion', () => {
  it('deletes a node the incoming side removed when local left its subtree untouched', () => {
    const base = mirror(baseNodes());
    const r = mergePlanMirror({
      base,
      local: base,
      incoming: mirror(without(baseNodes(), 'B')),
    });
    expect(r.deleted).toEqual([id('B')]);
    expect(byName(r.merged, 'B')).toBeUndefined();
  });

  it('deletes a subtree bottom-up', () => {
    const deep = [...baseNodes(), n('D', 'C', 0)];
    const base = mirror(deep);
    const r = mergePlanMirror({
      base,
      local: base,
      incoming: mirror(without(deep, 'A', 'C', 'D')),
    });
    expect(r.deleted).toEqual([id('D'), id('C'), id('A')]);
    expect(r.merged.nodes.map((x) => x.id)).toEqual([id('R'), id('B')]);
  });

  it('does not report a node local already deleted and incoming left alone', () => {
    const base = mirror(baseNodes());
    const r = mergePlanMirror({
      base,
      local: mirror(without(baseNodes(), 'B')),
      incoming: base,
    });
    expect(byName(r.merged, 'B')).toBeUndefined();
    expect(r.deleted).toEqual([]);
    expect(r.resurrected).toEqual([]);
  });

  it('keeps a locally modified node the incoming side deleted, with its ancestors', () => {
    const base = mirror(baseNodes());
    const local = mirror(swap(baseNodes(), 'C', { title: 'C edited' }));
    const incoming = mirror(without(baseNodes(), 'A', 'C'));
    const r = mergePlanMirror({ base, local, incoming });
    expect(byName(r.merged, 'C')?.title).toBe('C edited');
    expect(byName(r.merged, 'A')).toBeDefined();
    expect(r.deleted).toEqual([]);
    expect(r.resurrected).toEqual([]);
    expect(r.reported).toEqual([
      { kind: 'kept-modified', subject: id('C'), deletedBy: 'incoming' },
      { kind: 'kept-ancestor', subject: id('A'), deletedBy: 'incoming' },
    ]);
  });

  it('keeps a node reordered on one side that the other side deleted', () => {
    const base = mirror(baseNodes());
    const local = mirror(swap(baseNodes(), 'B', { ordinal: 5 }));
    const r = mergePlanMirror({ base, local, incoming: mirror(without(baseNodes(), 'B')) });
    expect(byName(r.merged, 'B')?.ordinal).toBe(5);
    expect(r.deleted).toEqual([]);
    expect(r.reported).toEqual([
      { kind: 'kept-modified', subject: id('B'), deletedBy: 'incoming' },
    ]);
  });

  it('keeps a locally added child and so its parent the incoming side deleted', () => {
    const base = mirror(baseNodes());
    const local = mirror([...baseNodes(), n('N', 'B', 0)]);
    const incoming = mirror(without(baseNodes(), 'B'));
    const r = mergePlanMirror({ base, local, incoming });
    expect(byName(r.merged, 'B')).toBeDefined();
    expect(byName(r.merged, 'N')).toBeDefined();
    expect(r.deleted).toEqual([]);
  });

  it('keeps a sibling subtree untouched while deleting only the removed one', () => {
    const base = mirror(baseNodes());
    const local = mirror(swap(baseNodes(), 'B', { title: 'B edited' }));
    const incoming = mirror(without(baseNodes(), 'A', 'C'));
    const r = mergePlanMirror({ base, local, incoming });
    expect(r.deleted).toEqual([id('C'), id('A')]);
    expect(byName(r.merged, 'B')?.title).toBe('B edited');
  });

  it('restores a node local deleted that the incoming side modified', () => {
    const base = mirror(baseNodes());
    const local = mirror(without(baseNodes(), 'B'));
    const incoming = mirror(swap(baseNodes(), 'B', { status: 'done' }));
    const r = mergePlanMirror({ base, local, incoming });
    expect(byName(r.merged, 'B')?.status).toBe('done');
    expect(r.resurrected).toEqual([id('B')]);
    expect(r.reported).toContainEqual({
      kind: 'kept-modified',
      subject: id('B'),
      deletedBy: 'local',
    });
  });

  it('pulls the incoming ancestors of a resurrected node back', () => {
    const base = mirror(baseNodes());
    const local = mirror(without(baseNodes(), 'A', 'C'));
    const incoming = mirror(swap(baseNodes(), 'C', { body: 'edited upstream' }));
    const r = mergePlanMirror({ base, local, incoming });
    expect(r.resurrected).toEqual([id('C'), id('A')]);
    expect(byName(r.merged, 'A')).toBeDefined();
    expect(byName(r.merged, 'C')?.body).toBe('edited upstream');
    expect(r.reported).toContainEqual({
      kind: 'kept-ancestor',
      subject: id('A'),
      deletedBy: 'local',
    });
    assertAcyclic(r.merged);
  });

  it('resurrects the parent an incoming move points at when local deleted it', () => {
    const base = mirror(baseNodes());
    const local = mirror(without(baseNodes(), 'B'));
    const incoming = mirror(swap(baseNodes(), 'C', { parentId: id('B') }));
    const r = mergePlanMirror({ base, local, incoming });
    expect(byName(r.merged, 'C')?.parentId).toBe(id('B'));
    expect(r.resurrected).toContain(id('B'));
  });

  it('breaks a parent cycle two moves make, local keeping its own parent choice', () => {
    const base = mirror(baseNodes());
    const local = mirror(swap(baseNodes(), 'A', { parentId: id('B') }));
    const incoming = mirror(swap(baseNodes(), 'B', { parentId: id('A') }));
    const r = mergePlanMirror({ base, local, incoming });
    assertAcyclic(r.merged);
    expect(byName(r.merged, 'A')?.parentId).toBe(id('B'));
    expect(byName(r.merged, 'B')?.parentId).toBe(id('R'));
    expect(r.reported).toContainEqual({
      kind: 'local-wins',
      subject: id('B'),
      field: 'parentId',
      local: id('R'),
      incoming: id('A'),
    });
  });

  it('stays acyclic when local moves a node under a parent incoming deleted', () => {
    const base = mirror(baseNodes());
    const local = mirror(swap(baseNodes(), 'B', { parentId: id('C') }));
    const incoming = mirror(without(baseNodes(), 'A', 'C'));
    const r = mergePlanMirror({ base, local, incoming });
    assertAcyclic(r.merged);
    expect(r.merged.nodes.map((x) => x.id).sort()).toEqual(['R', 'A', 'B', 'C'].map(id).sort());
    expect(r.deleted).toEqual([]);
  });

  it('stays acyclic when incoming moves a node under a parent local deleted', () => {
    const base = mirror(baseNodes());
    const local = mirror(without(baseNodes(), 'A', 'C'));
    const incoming = mirror(swap(baseNodes(), 'B', { parentId: id('C') }));
    const r = mergePlanMirror({ base, local, incoming });
    assertAcyclic(r.merged);
    expect(byName(r.merged, 'B')?.parentId).toBe(id('C'));
    expect(r.resurrected.sort()).toEqual([id('A'), id('C')].sort());
  });

  it('drops edges and code links whose endpoint node was deleted', () => {
    const base = mirror(
      baseNodes(),
      [edge('B', 'C'), edge('A', 'C'), edge('R', 'A')],
      [link('B', 'src/b.ts'), link('C', 'src/c.ts')],
    );
    const incoming = mirror(
      without(baseNodes(), 'B'),
      [edge('A', 'C'), edge('R', 'A')],
      [link('C', 'src/c.ts')],
    );
    const r = mergePlanMirror({ base, local: base, incoming });
    expect(r.deleted).toEqual([id('B')]);
    expect(r.merged.edges.map((e) => [e.fromNodeId, e.toNodeId])).toEqual([
      [id('A'), id('C')],
      [id('R'), id('A')],
    ]);
    expect(r.merged.codeLinks.map((l) => l.repoPath)).toEqual(['src/c.ts']);
  });

  it('drops a locally added edge to a node that ends up deleted', () => {
    const base = mirror(baseNodes());
    const local = mirror(baseNodes(), [edge('B', 'C')]);
    const incoming = mirror(without(baseNodes(), 'B'));
    const r = mergePlanMirror({ base, local, incoming });
    expect(r.deleted).toEqual([id('B')]);
    expect(r.merged.edges).toEqual([]);
  });
});

describe('mergePlanMirror: edges', () => {
  const nodes = baseNodes();

  it('adds a member either side added', () => {
    const base = mirror(nodes, [edge('A', 'B')]);
    const local = mirror(nodes, [edge('A', 'B'), edge('B', 'C')]);
    const incoming = mirror(nodes, [edge('A', 'B'), edge('R', 'C')]);
    const r = mergePlanMirror({ base, local, incoming });
    expect(r.merged.edges.map((e) => `${e.fromNodeId}>${e.toNodeId}`).sort()).toEqual(
      [`${id('A')}>${id('B')}`, `${id('B')}>${id('C')}`, `${id('R')}>${id('C')}`].sort(),
    );
  });

  it('removes a member one side removed and the other left unchanged', () => {
    const base = mirror(nodes, [edge('A', 'B'), edge('B', 'C')]);
    const local = mirror(nodes, [edge('B', 'C')]);
    const incoming = mirror(nodes, [edge('A', 'B')]);
    const r = mergePlanMirror({ base, local, incoming });
    expect(r.merged.edges).toEqual([]);
  });

  it('keeps a member one side removed and the other changed, reporting it', () => {
    const base = mirror(nodes, [edge('A', 'B', 'old')]);
    const local = mirror(nodes, []);
    const incoming = mirror(nodes, [edge('A', 'B', 'new')]);
    const r = mergePlanMirror({ base, local, incoming });
    expect(r.merged.edges).toEqual([edge('A', 'B', 'new')]);
    expect(r.reported).toEqual([
      {
        kind: 'kept-modified',
        subject: `edge:${id('A')}>${id('B')}:affects`,
        deletedBy: 'local',
      },
    ]);
  });

  it('takes a note only one side changed', () => {
    const base = mirror(nodes, [edge('A', 'B', 'old')]);
    const incoming = mirror(nodes, [edge('A', 'B', 'new')]);
    const r = mergePlanMirror({ base, local: base, incoming });
    expect(r.merged.edges[0]?.note).toBe('new');
  });

  it('keeps local when both sides changed the note differently, reporting it', () => {
    const base = mirror(nodes, [edge('A', 'B', 'old')]);
    const local = mirror(nodes, [edge('A', 'B', 'mine')]);
    const incoming = mirror(nodes, [edge('A', 'B', 'theirs')]);
    const r = mergePlanMirror({ base, local, incoming });
    expect(r.merged.edges[0]?.note).toBe('mine');
    expect(r.conflicts).toEqual([]);
    expect(r.reported).toEqual([
      {
        kind: 'local-wins',
        subject: `edge:${id('A')}>${id('B')}:affects`,
        field: 'note',
        local: 'mine',
        incoming: 'theirs',
      },
    ]);
  });
});

describe('mergePlanMirror: code links', () => {
  const nodes = baseNodes();

  it('merges membership as a set and keys a null symbol apart from a named one', () => {
    const base = mirror(nodes, [], [link('A', 'a.ts'), link('A', 'gone.ts')]);
    const local = mirror(nodes, [], [link('A', 'a.ts'), link('A', 'gone.ts'), link('A', 'l.ts')]);
    const incoming = mirror(
      nodes,
      [],
      [link('A', 'a.ts'), link('A', 'a.ts', { symbol: 'fn' }), link('B', 'i.ts')],
    );
    const r = mergePlanMirror({ base, local, incoming });
    expect(
      r.merged.codeLinks.map(
        (l) => `${l.nodeId === id('A') ? 'A' : 'B'}:${l.repoPath}:${l.symbol}`,
      ),
    ).toEqual(['A:a.ts:null', 'A:a.ts:fn', 'B:i.ts:null', 'A:l.ts:null']);
  });

  it('keeps local for a field changed differently on both sides, reporting it', () => {
    const base = mirror(nodes, [], [link('A', 'a.ts', { evidence: 'e0' })]);
    const local = mirror(nodes, [], [link('A', 'a.ts', { evidence: 'mine', stale: true })]);
    const incoming = mirror(nodes, [], [link('A', 'a.ts', { evidence: 'theirs', role: 'covers' })]);
    const r = mergePlanMirror({ base, local, incoming });
    expect(r.merged.codeLinks).toEqual([
      link('A', 'a.ts', { evidence: 'mine', stale: true, role: 'covers' }),
    ]);
    expect(r.reported).toEqual([
      {
        kind: 'local-wins',
        subject: `code-link:${id('A')}:a.ts:`,
        field: 'evidence',
        local: 'mine',
        incoming: 'theirs',
      },
    ]);
  });
});

describe('mergePlanMirror: no base', () => {
  it('is additive: incoming wins every field, local-only is kept, nothing is deleted', () => {
    const local = mirror(
      [...swap(baseNodes(), 'A', { title: 'mine', ordinal: 5 }), n('L', 'R', 9)],
      [edge('A', 'B', 'mine')],
      [link('A', 'a.ts', { evidence: 'mine' })],
    );
    const incoming = mirror(
      without(swap(baseNodes(), 'A', { title: 'theirs' }), 'B'),
      [edge('A', 'B', 'theirs'), edge('R', 'A')],
      [link('A', 'a.ts', { evidence: 'theirs' })],
    );
    const r = mergePlanMirror({ base: null, local, incoming });
    expect(byName(r.merged, 'A')).toMatchObject({ title: 'theirs', ordinal: 0 });
    expect(byName(r.merged, 'B')).toBeDefined();
    expect(byName(r.merged, 'L')).toBeDefined();
    expect(r.deleted).toEqual([]);
    expect(r.resurrected).toEqual([]);
    expect(r.conflicts).toEqual([]);
    expect(r.reported).toEqual([]);
    expect(r.merged.edges).toEqual([edge('A', 'B', 'theirs'), edge('R', 'A')]);
    expect(r.merged.codeLinks).toEqual([link('A', 'a.ts', { evidence: 'theirs' })]);
  });

  it('keeps a local-only node when incoming moves another under it, without a cycle', () => {
    const local = mirror([...baseNodes(), n('L', 'C', 0)]);
    const incoming = mirror(swap(baseNodes(), 'C', { parentId: id('A') }));
    const r = mergePlanMirror({ base: null, local, incoming });
    assertAcyclic(r.merged);
    expect(byName(r.merged, 'L')?.parentId).toBe(id('C'));
  });

  it('breaks a cycle an incoming move closes over local structure', () => {
    const local = mirror(swap(baseNodes(), 'A', { parentId: id('B') }));
    const incoming = mirror(swap(baseNodes(), 'B', { parentId: id('A') }));
    const r = mergePlanMirror({ base: null, local, incoming });
    assertAcyclic(r.merged);
  });
});

describe('mergePlanMirror: ordering and shape', () => {
  it('orders nodes by ordinal, then incoming position, then local-only', () => {
    const base = mirror(baseNodes());
    const local = mirror([...baseNodes(), n('L', 'R', 0)]);
    const incoming = mirror([...baseNodes(), n('I', 'R', 0)]);
    const r = mergePlanMirror({ base, local, incoming });
    expect(r.merged.nodes.map((x) => x.title)).toEqual(['R', 'A', 'C', 'I', 'L', 'B']);
  });

  it('keeps local code links when the incoming snapshot is v1, which cannot carry them', () => {
    const links = [link('A', 'src/a.ts'), link('C', 'src/c.ts')];
    const r = mergePlanMirror({
      base: mirror(baseNodes(), [], links),
      local: mirror(baseNodes(), [], links),
      incoming: {
        schemaVersion: 1,
        nodes: baseNodes().map((x) => ({ ...x, createdBy: 'import' })),
        edges: [],
      },
    });
    expect(r.merged.codeLinks).toEqual(links);
    expect(r.reported).toEqual([]);
  });

  it('accepts v1 payloads, ignoring createdBy and having no code links', () => {
    const v1 = (nodes: N[]): PlanMirrorPayload => ({
      schemaVersion: 1,
      nodes: nodes.map((x) => ({ ...x, createdBy: 'import' })),
      edges: [],
    });
    const r = mergePlanMirror({
      base: v1(baseNodes()),
      local: v1(baseNodes()),
      incoming: v1(swap(baseNodes(), 'A', { title: 'new' })),
    });
    expect(r.merged.schemaVersion).toBe(2);
    expect(byName(r.merged, 'A')?.title).toBe('new');
    expect(r.merged.codeLinks).toEqual([]);
    expect(Object.keys(r.merged.nodes[0]!)).toEqual([
      'id',
      'parentId',
      'ordinal',
      'title',
      'kind',
      'body',
      'status',
      'taskable',
    ]);
  });
});

describe('mergePlanMirror: idempotence', () => {
  const rich = mirror(
    [
      n('R', null),
      n('A', 'R', 0),
      n('C', 'A', 0),
      n('D', 'C', 0),
      n('E', 'B', 0, { body: 'text', status: 'done' }),
      n('B', 'R', 1),
    ],
    [edge('A', 'B', 'n'), edge('C', 'E')],
    [link('A', 'a.ts', { symbol: 's', stale: true }), link('E', 'e.ts')],
  );

  it('merge(x, x, x) is x', () => {
    const r = mergePlanMirror({ base: rich, local: rich, incoming: rich });
    expect(r.merged).toEqual(rich);
    expect(r.conflicts).toEqual([]);
    expect(r.deleted).toEqual([]);
    expect(r.resurrected).toEqual([]);
    expect(r.reported).toEqual([]);
  });

  it('merge(null, x, x) is x', () => {
    expect(mergePlanMirror({ base: null, local: rich, incoming: rich }).merged).toEqual(rich);
  });

  it('merging the result again with itself as base yields no conflicts', () => {
    const base = mirror(swap(baseNodes(), 'A', { title: 'old' }));
    const local = mirror(swap(baseNodes(), 'A', { title: 'mine' }), [edge('A', 'B', 'x')]);
    const incoming = mirror(without(swap(baseNodes(), 'A', { title: 'theirs' }), 'B'), [
      edge('A', 'C'),
    ]);
    const first = mergePlanMirror({ base, local, incoming });
    expect(first.conflicts).toHaveLength(1);
    const again = mergePlanMirror({
      base: first.merged,
      local: first.merged,
      incoming: first.merged,
    });
    expect(again.merged).toEqual(first.merged);
    expect(again.conflicts).toEqual([]);
    const forward = mergePlanMirror({ base: first.merged, local: first.merged, incoming });
    expect(forward.conflicts).toEqual([]);
  });
});
