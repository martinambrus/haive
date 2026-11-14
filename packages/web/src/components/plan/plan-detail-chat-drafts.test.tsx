import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRenderer, findAll, fire } from '../../../test/render-tree';
import type { PlanNodeTask, PlanNodeDetail } from '@/lib/api-client';
import { PlanDetailPanel } from './plan-detail-panel';

vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  ...(await import('../../../test/render-tree')).reactHooks,
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('next/link', async () => {
  const { createElement } = await import('react');
  return {
    default: ({ href, children }: { href: string; children?: unknown }) =>
      createElement('a', { href }, children as never),
  };
});

vi.mock('lucide-react', async (original) =>
  Object.fromEntries(Object.keys(await original<object>()).map((name) => [name, () => null])),
);
const net = vi.hoisted(() => ({
  tasks: [] as PlanNodeTask[],
  advisory: null as PlanNodeTask | null,
}));
vi.mock('@/lib/api-client', async (original) => ({
  ...(await original<typeof import('@/lib/api-client')>()),
  getPlanNode: async (_repo: string, id: string): Promise<PlanNodeDetail> => ({
    node: {
      id,
      parentId: null,
      path: `/${id}/`,
      ordinal: 0,
      title: id,
      kind: 'component',
      body: null,
      status: 'todo',
      taskable: true,
      version: 1,
      createdBy: 'user',
      sourceTaskId: null,
      directChildren: 0,
      totalDescendants: 0,
      rolledStatus: 'todo',
      sequence: 1,
      blockedBy: [],
      driftedTasks: 0,
      createdAt: '',
      updatedAt: '',
    },
    ancestry: [],
    children: [],
    edges: [],
    codeLinks: [],
    tasks: net.tasks,
    advisoryTask: net.advisory,
  }),
  getPlanMessages: async () => ({ messages: [], conversations: [] }),
  getPlanBuildClis: async () => ({ plannerCliProviderId: null }),
  markPlanNodeRead: async () => undefined,
  api: { get: async () => ({ providers: [] }) },
}));
vi.mock('@/components/markdown/markdown-view', () => ({ MarkdownView: () => null }));

let dispose = () => {};
afterEach(() => {
  dispose();
  vi.unstubAllGlobals();
});

it('keeps each node’s draft through a switch from A to B and back in PlanDetailPanel', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('Unexpected network request');
    }),
  );
  const drafts = new Map<string, string>(); // same owner as the page's ref
  let nodeId = 'node-A';
  let visible = true;
  const view = createRenderer(() =>
    visible ? (
      <PlanDetailPanel
        repositoryId="repo-1"
        nodeId={nodeId}
        tree={[]}
        tab="chat"
        chatDrafts={drafts}
        unreadCount={0}
        onRead={() => {}}
        onTabChange={() => {}}
        onChanged={() => {}}
        onNavigate={() => {}}
        onClose={() => {}}
      />
    ) : null,
  );
  dispose = () => {
    visible = false;
    view.draw();
  };
  const settle = async () => {
    await view.flush();
    await view.flush();
  };
  const textarea = () => {
    const fields = findAll(view.tree(), (el) => el.tag === 'textarea');
    expect(fields).toHaveLength(1);
    return fields[0]!;
  };
  await settle();
  fire.type(textarea(), 'Draft for A');
  view.draw();
  nodeId = 'node-B';
  view.draw();
  await settle();
  expect(textarea().props.value).toBe('');
  fire.type(textarea(), 'Draft for B');
  view.draw();
  nodeId = 'node-A';
  view.draw();
  await settle();
  expect(textarea().props.value).toBe('Draft for A');
  nodeId = 'node-B';
  view.draw();
  await settle();
  expect(textarea().props.value).toBe('Draft for B');
});

describe.each(['node', 'advisory'] as const)('%s work', (source) => {
  it.each([
    ['waiting_user', false],
    ['created', false],
    ['waiting_pr', false],
    ['queued', true],
    ['running', true],
    ['completed', false],
    ['failed', false],
    ['cancelled', false],
  ] as const)('reports pending %s work as %s', async (status, pending) => {
    net.tasks = [
      {
        taskId: 'task-1',
        title: 'Work',
        status,
        type: source === 'advisory' ? 'advisory' : 'workflow',
        createdAt: '',
      },
    ];
    if (source === 'advisory') {
      net.advisory = net.tasks[0]!;
      net.tasks = [];
    }
    const reportActivity = vi.fn();
    let visible = true;
    const view = createRenderer(() =>
      visible ? (
        <PlanDetailPanel
          repositoryId="repo-1"
          nodeId="node-A"
          tree={[]}
          tab="details"
          chatDrafts={new Map()}
          unreadCount={0}
          onRead={() => {}}
          onTabChange={() => {}}
          onChanged={() => {}}
          onNavigate={() => {}}
          onClose={() => {}}
          reportActivity={reportActivity}
        />
      ) : null,
    );
    dispose = () => {
      visible = false;
      view.draw();
      net.tasks = [];
      net.advisory = null;
    };
    await view.flush();
    expect(reportActivity.mock.lastCall?.[1]).toBe(pending);
  });
});
