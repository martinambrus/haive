import { describe, it, expect } from 'vitest';
import { parsePlanNodeRefs, renderPlanMarkdownFrom } from './render.js';
import { planNodePath } from './paths.js';
import type { PlanNodeRecord } from './read.js';

const ROOT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const API = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const AUTH = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const rootPath = planNodePath(null, ROOT);
const apiPath = planNodePath(rootPath, API);
const authPath = planNodePath(apiPath, AUTH);

function node(over: Partial<PlanNodeRecord> & { id: string; path: string }): PlanNodeRecord {
  return {
    parentId: null,
    ordinal: 0,
    title: 'node',
    kind: 'component',
    body: null,
    status: 'todo',
    taskable: false,
    version: 1,
    createdBy: 'user',
    sourceTaskId: null,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    ...over,
  } as PlanNodeRecord;
}

const NODES: PlanNodeRecord[] = [
  node({ id: ROOT, path: rootPath, title: 'Product', body: 'The whole thing.' }),
  node({ id: API, path: apiPath, parentId: ROOT, title: 'API', ordinal: 0 }),
  node({
    id: AUTH,
    path: authPath,
    parentId: API,
    title: 'Auth',
    ordinal: 0,
    taskable: true,
    status: 'in_progress',
  }),
];

describe('renderPlanMarkdownFrom', () => {
  it('nests headings by depth', () => {
    const out = renderPlanMarkdownFrom(NODES, []);
    expect(out).toContain('# Product');
    expect(out).toContain('## API');
    expect(out).toContain('### Auth');
  });

  it('stamps every node with a quotable id', () => {
    // The agent has to copy these back in its patches and the spec writer has to
    // name them, so they are rendered VISIBLY rather than as an HTML comment a
    // model may drop.
    const out = renderPlanMarkdownFrom(NODES, []);
    for (const n of NODES) expect(out).toContain(`node:${n.id}`);
  });

  it('carries kind, status and taskability', () => {
    const out = renderPlanMarkdownFrom(NODES, []);
    expect(out).toContain('in_progress');
    expect(out).toContain('taskable');
  });

  it('renders links with the target title and id', () => {
    const out = renderPlanMarkdownFrom(NODES, [
      { fromNodeId: AUTH, toNodeId: API, kind: 'depends_on', note: 'needs the router' },
    ]);
    expect(out).toContain('depends on: API');
    expect(out).toContain(`node:${API}`);
    expect(out).toContain('needs the router');
  });

  it('omits bodies under titlesOnly', () => {
    expect(renderPlanMarkdownFrom(NODES, [], { titlesOnly: true })).not.toContain(
      'The whole thing.',
    );
    expect(renderPlanMarkdownFrom(NODES, [])).toContain('The whole thing.');
  });

  it('honours maxDepth', () => {
    const out = renderPlanMarkdownFrom(NODES, [], { maxDepth: 1 });
    expect(out).toContain('# Product');
    expect(out).toContain('## API');
    expect(out).not.toContain('### Auth');
  });

  it('marks the focused node', () => {
    expect(renderPlanMarkdownFrom(NODES, [], { focusNodeId: AUTH })).toContain('you are here');
  });

  it('says so when there is no plan', () => {
    expect(renderPlanMarkdownFrom([], [])).toContain('no plan yet');
  });

  it('keeps depth legible past heading level six', () => {
    // Markdown has six heading levels and a plan can be deeper. Clamping alone
    // would make level 7 and level 9 render identically.
    let path = rootPath;
    const deep: PlanNodeRecord[] = [node({ id: ROOT, path: rootPath, title: 'Product' })];
    let parent = ROOT;
    for (let i = 0; i < 8; i++) {
      const id = `dddddddd-dddd-4ddd-8ddd-${String(i).padStart(12, '0')}`;
      path = planNodePath(path, id);
      deep.push(node({ id, path, parentId: parent, title: `L${i + 1}` }));
      parent = id;
    }
    const out = renderPlanMarkdownFrom(deep, []);
    expect(out).toContain('depth 6');
    expect(out).toContain('depth 8');
  });
});

describe('parsePlanNodeRefs', () => {
  it('finds every id mentioned, in order, deduped', () => {
    const text = `Touches node:${API} and node:${AUTH}, and node:${API} again.`;
    expect(parsePlanNodeRefs(text)).toEqual([API, AUTH]);
  });

  it('is case-insensitive and normalises to lowercase', () => {
    expect(parsePlanNodeRefs(`node:${API.toUpperCase()}`)).toEqual([API]);
  });

  it('ignores a bare uuid with no marker', () => {
    // The marker is what separates "the agent is naming a plan node" from any
    // other uuid a spec happens to quote — a task id, a migration, a fixture.
    expect(parsePlanNodeRefs(`the task ${API} failed`)).toEqual([]);
  });

  it('finds an id inside prose and punctuation', () => {
    expect(parsePlanNodeRefs(`- \`node:${API}\` — the API.`)).toEqual([API]);
  });

  it('returns nothing for text with no refs', () => {
    expect(parsePlanNodeRefs('## Affected components\n\nnone — this is a docs change.')).toEqual(
      [],
    );
  });
});
