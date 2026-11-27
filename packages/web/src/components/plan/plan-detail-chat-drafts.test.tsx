import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRenderer, findAll, fire, textOf } from '../../../test/render-tree';
import type { PlanNodeTask, PlanNodeDetail } from '@/lib/api-client';
import { PlanChat } from './plan-chat';
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
  switchProvider: vi.fn(),
  providers: [] as Record<string, unknown>[],
  chat: null as Record<string, unknown> | null,
  chatTask: null as Record<string, unknown> | null,
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
  setPlanChatProvider: net.switchProvider,
  getPlanMessages: async () => net.chat ?? { messages: [], conversations: [] },
  getPlanBuildClis: async () => ({ plannerCliProviderId: null }),
  markPlanNodeRead: async () => undefined,
  api: {
    get: async (path: string) =>
      path.startsWith('/tasks/') && net.chatTask ? net.chatTask : { providers: net.providers },
  },
}));
vi.mock('@/components/markdown/markdown-view', () => ({
  MarkdownView: ({ body }: { body: string }) => body,
}));

let dispose = () => {};
afterEach(() => {
  dispose();
  vi.unstubAllGlobals();
  net.chat = null;
  net.chatTask = null;
  net.providers = [];
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

it('refuses an oversized new message without sending or losing the draft', async () => {
  const fetcher = vi.fn(() => {
    throw new Error('Unexpected network');
  });
  vi.stubGlobal('fetch', fetcher);
  let visible = true;
  const view = createRenderer(() =>
    visible ? <PlanChat repositoryId="repo" nodeId="node" onPatched={() => {}} /> : null,
  );
  dispose = () => {
    visible = false;
    view.draw();
  };
  await view.flush();
  const message = 'x'.repeat(20_001);
  fire.type(findAll(view.tree(), (e) => e.tag === 'textarea')[0]!, message);
  view.draw();
  fire.click(findAll(view.tree(), (e) => e.tag === 'button' && textOf(e) === 'Send')[0]!);
  await view.flush();
  expect(fetcher).not.toHaveBeenCalled();
  expect(findAll(view.tree(), (e) => e.tag === 'textarea')[0]!.props.value).toBe(message);
  expect(
    findAll(view.tree(), (e) => textOf(e).includes('20,000 characters')).length,
  ).toBeGreaterThan(0);
});

it.each(['initialValue', 'default'] as const)(
  'offers the whole legacy pending message for an explicit edit in the plan panel (%s)',
  async (key) => {
    const original = 'legacy '.repeat(3000);
    net.chat = {
      messages: [
        {
          id: 'pending',
          taskId: 'task',
          nodeId: 'node',
          role: 'user',
          body: original,
          patch: null,
          cliLabel: null,
          createdAt: '2026-11-14',
        },
      ],
      conversations: [
        {
          taskId: 'task',
          title: 'Chat',
          status: 'waiting_user',
          createdAt: '2026-11-14',
          cliProviderId: null,
        },
      ],
    };
    net.chatTask = {
      task: { id: 'task', status: 'waiting_user', deadAt: null },
      steps: [
        {
          stepId: '01-plan-chat',
          status: 'waiting_form',
          waitingStartedAt: '2026-11-14',
          formSchema: {
            title: 'Edit message',
            description: 'The stored message must be edited.',
            fields: [{ id: 'message', type: 'textarea', [key]: original }],
          },
        },
      ],
    };
    let visible = true;
    const view = createRenderer(() =>
      visible ? <PlanChat repositoryId="repo" nodeId="node" onPatched={() => {}} /> : null,
    );
    dispose = () => {
      visible = false;
      view.draw();
    };
    await view.flush();
    await view.flush();
    const edit = findAll(
      view.tree(),
      (e) => e.tag === 'button' && textOf(e) === 'Edit stored message',
    );
    expect(edit).toHaveLength(1);
    fire.click(edit[0]!);
    view.draw();
    expect(findAll(view.tree(), (e) => e.tag === 'textarea')[0]!.props.value).toBe(original);
  },
);

it.each([false, true, undefined])(
  'shows cleanup confirmation after a plan-chat CLI switch (%s)',
  async (killConfirmed) => {
    net.chat = {
      messages: [
        {
          id: 'message',
          taskId: 'chat-task',
          nodeId: 'node',
          role: 'user',
          body: 'Question',
          patch: null,
          cliLabel: null,
          createdAt: '',
        },
      ],
      conversations: [
        {
          taskId: 'chat-task',
          title: 'Chat',
          status: 'waiting_user',
          createdAt: '',
          cliProviderId: null,
        },
      ],
    };
    net.chatTask = {
      task: { id: 'chat-task', status: 'waiting_user', deadAt: null },
      steps: [{ stepId: '01-plan-chat', status: 'waiting_form', waitingStartedAt: '2026-11-14' }],
    };
    net.providers = [{ id: 'new-cli', name: 'New CLI', enabled: true }];
    net.switchProvider.mockReset().mockResolvedValue({ killConfirmed });
    let visible = true;
    const view = createRenderer(() =>
      visible ? <PlanChat repositoryId="repo" nodeId="node" onPatched={() => {}} /> : null,
    );
    dispose = () => {
      visible = false;
      view.draw();
    };
    await view.flush();
    await view.flush();
    const select = findAll(view.tree(), (e) => e.tag === 'select')[0]!;
    expect(select).toBeDefined();
    (select.props.onChange as (event: unknown) => void)({ target: { value: 'new-cli' } });
    await view.flush();
    await view.flush();
    expect(net.switchProvider).toHaveBeenCalledWith('chat-task', 'new-cli');
    const warnings = findAll(view.tree(), (e) => e.props.role === 'status');
    expect(warnings).toHaveLength(killConfirmed === false ? 1 : 0);
    if (killConfirmed === false) {
      expect(textOf(warnings[0]!)).toContain('Sandbox cleanup could not be confirmed.');
      expect(warnings[0]!.props.className).toContain('text-amber-200');
      net.switchProvider.mockResolvedValueOnce({ killConfirmed: true });
      (select.props.onChange as (event: unknown) => void)({ target: { value: 'another-cli' } });
      await view.flush();
      await view.flush();
      expect(findAll(view.tree(), (e) => e.props.role === 'status')).toHaveLength(0);
    }
  },
);
