import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PlanPage from '../../app/(app)/repos/[id]/plan/page';
import {
  buttons,
  createRenderer,
  findAll,
  fire,
  isDisabled,
  textOf,
} from '../../../test/render-tree';

vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  ...(await import('../../../test/render-tree')).reactHooks,
}));
vi.mock('next/navigation', () => ({
  useParams: () => ({ id: 'repo-1' }),
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock('next/link', async () => {
  const { createElement } = await import('react');
  return {
    default: ({ href, children }: { href: string; children?: unknown }) =>
      createElement('a', { href }, children as never),
  };
});
vi.mock('lucide-react', () => ({
  CloudDownload: () => null,
  CloudUpload: () => null,
  LayoutGrid: () => null,
  ListOrdered: () => null,
  Link2: () => null,
  ListTree: () => null,
  Play: () => null,
  Plus: () => null,
  Save: () => null,
  Trash2: () => null,
}));
vi.mock('@/components/markdown/markdown-view', () => ({ MarkdownView: () => null }));
vi.mock('@/lib/use-page-title', () => ({ usePageTitle: () => {} }));
vi.mock('@/components/markdown/inline-markdown', () => ({
  InlineMarkdown: ({ body }: { body: string }) => <span>{body}</span>,
}));
vi.mock('./plan-card-grid', () => ({ PlanCardGrid: () => null }));
vi.mock('./plan-detail-panel', () => ({
  PlanDetailPanel: (props: unknown) => {
    net.detail(props);
    return null;
  },
}));
vi.mock('./plan-tree', () => ({ PlanTree: () => null }));
vi.mock('./plan-delete-dialog', () => ({ PlanDeleteDialog: () => null }));
vi.mock('./plan-starter', () => ({
  PlanStarter: (props: unknown) => {
    net.starter(props);
    return null;
  },
}));
vi.mock('@/components/repos/link-origin-dialog', () => ({ LinkOriginDialog: () => null }));
vi.mock('@/components/project-state-conflicts-banner', () => ({
  ProjectStateConflictsBanner: () => null,
}));

const net = vi.hoisted(() => ({
  sequence: vi.fn(),
  merge: vi.fn(),
  nodeCount: 1,
  ordering: null as { activeTaskId: string } | null,
  active: vi.fn(),
  overview: vi.fn(),
  postPlan: vi.fn(),
  starter: vi.fn(),
  detail: vi.fn(),
}));
vi.mock('@/lib/active-time/use-active-time', () => ({ useActiveTime: net.active }));
vi.mock('@/lib/api-client', async (original) => ({
  ...(await original<typeof import('@/lib/api-client')>()),
  api: {
    get: async (path: string) =>
      path === '/repositories/repo-1/plan'
        ? { ordering: net.ordering }
        : { task: { id: 'live', status: 'running' }, steps: [], providers: [] },
  },
  postPlanUserActive: net.postPlan,
  startPlanSequence: net.sequence,
  getUiPrefs: async () => ({}),
  getPlanOverview: async () => {
    net.overview();
    return {
      repositoryName: 'Fixture',
      nodeCount: net.nodeCount,
      ordering: net.ordering,
      root: null,
    };
  },
  getPlanTree: async () => ({ nodes: [] }),
  getPlanNode: async () => ({ node: { id: 'node-1' }, children: [], ancestry: [] }),
  getPlanUnread: async () => ({ counts: {} }),
  getPlanMerge: net.merge,
  getRepoOnboardingStatus: async () => ({ onboarded: true }),
  getPlanSnapshot: async () => ({
    revision: 1,
    writtenRevision: 1,
    snapshotState: 'written',
    snapshotWritten: true,
    lastError: null,
    filesExist: true,
    gitAvailable: true,
    tracked: true,
    uncommitted: false,
    committed: true,
    pushed: true,
    branch: 'main',
    hasOrigin: true,
    originUrl: 'https://example.com/repo.git',
  }),
}));

const flush = async (view: ReturnType<typeof createRenderer>) => {
  const pending = view.flush();
  await vi.advanceTimersByTimeAsync(0);
  return pending;
};

const failure = {
  taskId: 'failed-merge',
  status: 'failed',
  createdAt: '2026-10-01T00:00:00.000Z',
  completedAt: '2026-10-02T00:00:00.000Z',
};
beforeEach(() => {
  vi.useFakeTimers();
  net.nodeCount = 1;
  net.ordering = null;
  net.active.mockClear();
  net.overview.mockClear();
  net.postPlan.mockClear();
  net.starter.mockClear();
  net.merge.mockReset().mockResolvedValue({ merge: null, failedMerge: failure });
  vi.stubGlobal('window', {
    location: { search: '', href: 'http://localhost/repos/repo-1/plan' },
    history: { replaceState: vi.fn() },
    matchMedia: () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  vi.stubGlobal('document', {
    hidden: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('unexpected network call');
    }),
  );
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('plan page failed merge recovery', () => {
  it('shows the unresolved failure and task Retry link on a fresh page load', async () => {
    const view = createRenderer(() => <PlanPage />);
    await flush(view);
    expect(net.merge).toHaveBeenCalledWith('repo-1');
    expect(textOf(view.tree())).toContain('The merge failed.');
    const links = findAll(
      view.tree(),
      (h) => h.tag === 'a' && h.props.href === '/tasks/failed-merge',
    );
    expect(links).toHaveLength(1);
    expect(textOf(links[0]!)).toBe('Open the task to retry');
    expect(isDisabled(buttons(view.tree(), /^pull$/i)[0]!)).toBe(false);
    expect(isDisabled(buttons(view.tree(), /^save & push$/i)[0]!)).toBe(false);
  });

  it('clears the notice when a later poll reports the failure resolved', async () => {
    const view = createRenderer(() => <PlanPage />);
    await flush(view);
    expect(textOf(view.tree())).toContain('The merge failed.');
    net.merge.mockResolvedValue({ merge: null, failedMerge: null });
    await vi.advanceTimersByTimeAsync(10_000);
    await flush(view);
    expect(textOf(view.tree())).not.toContain('The merge failed.');
  });

  it('leaves the live conversation in charge while another merge is open', async () => {
    net.merge.mockResolvedValue({
      merge: { taskId: 'live', status: 'running', messages: [] },
      failedMerge: failure,
    });
    const view = createRenderer(() => <PlanPage />);
    await flush(view);
    expect(textOf(view.tree())).not.toContain('The merge failed.');
    expect(isDisabled(buttons(view.tree(), /^pull$/i)[0]!)).toBe(true);
  });

  it('also recovers the failed conversation when the repository has no plan', async () => {
    net.nodeCount = 0;
    const view = createRenderer(() => <PlanPage />);
    await flush(view);
    expect(textOf(view.tree())).toContain('The merge failed.');
    expect(
      findAll(view.tree(), (h) => h.tag === 'a' && h.props.href === '/tasks/failed-merge'),
    ).toHaveLength(1);
  });
});

describe('plan page attention wiring', () => {
  it('counts on an empty plan and keeps the repository sink stable across polls', async () => {
    net.nodeCount = 0;
    const view = createRenderer(() => <PlanPage />);
    await flush(view);
    const first = net.active.mock.lastCall?.[0];
    expect(first).toMatchObject({ enabled: true, pending: false });
    first.sink(1234);
    expect(net.postPlan).toHaveBeenCalledWith('repo-1', 1234);
    await vi.advanceTimersByTimeAsync(10_000);
    await flush(view);
    expect(net.active.mock.lastCall?.[0].sink).toBe(first.sink);
  });
  it('combines independent reporters and clears pending only after the last one clears', async () => {
    net.nodeCount = 0;
    const view = createRenderer(() => <PlanPage />);
    await flush(view);
    const report = net.starter.mock.lastCall?.[0].reportActivity;
    expect(report).toBeTypeOf('function');
    const chat = Symbol(),
      build = Symbol();
    report(chat, true);
    report(build, true);
    await flush(view);
    expect(net.active.mock.lastCall?.[0].pending).toBe(true);
    report(chat, false);
    await flush(view);
    expect(net.active.mock.lastCall?.[0].pending).toBe(true);
    report(build, false);
    await flush(view);
    expect(net.active.mock.lastCall?.[0].pending).toBe(false);
  });
  it('does not infer pending from a loaded ordering task id without a status', async () => {
    net.ordering = { activeTaskId: 'ordering-task' };
    const view = createRenderer(() => <PlanPage />);
    await flush(view);
    expect(net.active.mock.lastCall?.[0].pending).toBe(false);
  });
});

it('renews the content key when the selected node chat reports an answer, not on polling', async () => {
  window.location.search = '?node=node-1';
  const view = createRenderer(() => <PlanPage />);
  await flush(view);
  const before = net.active.mock.lastCall?.[0].contentKey;
  const answer = net.detail.mock.lastCall?.[0].onChatAnswer;
  expect(answer).toBeTypeOf('function');
  answer();
  await flush(view);
  const after = net.active.mock.lastCall?.[0].contentKey;
  expect(after).not.toBe(before);
  await vi.advanceTimersByTimeAsync(10_000);
  await flush(view);
  expect(net.active.mock.lastCall?.[0].contentKey).toBe(after);
});

it('reports ordering only while the page’s start request is in flight', async () => {
  let resolve!: (result: { taskId: string }) => void;
  net.sequence.mockReturnValue(
    new Promise((done) => {
      resolve = done;
    }),
  );
  const view = createRenderer(() => <PlanPage />);
  await flush(view);
  expect(net.active.mock.lastCall?.[0].pending).toBe(false);
  fire.click(buttons(view.tree(), /^order the plan$/i)[0]!);
  await flush(view);
  expect(net.active.mock.lastCall?.[0].pending).toBe(true);
  resolve({ taskId: 'ordering-task' });
  await flush(view);
  expect(net.active.mock.lastCall?.[0].pending).toBe(false);
});
