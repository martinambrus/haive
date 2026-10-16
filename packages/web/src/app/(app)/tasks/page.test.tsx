import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import TasksPage from './page';
import { createRenderer, findAll, textOf, type Renderer } from '../../../../test/render-tree';

// No DOM in this package: the page runs through test/render-tree.ts, and the network is a stub of fetch.
vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  ...(await import('../../../../test/render-tree')).reactHooks,
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('next/link', async () => {
  const { createElement } = await import('react');
  return {
    default: ({ href, children }: { href: string; children?: unknown }) =>
      createElement('a', { href }, children as never),
  };
});
vi.mock('@/lib/use-page-title', () => ({ usePageTitle: () => {} }));
vi.mock('@/components/usage-strip', () => ({ UsageStrip: () => null }));
vi.mock('@/components/task-vote', () => ({ TaskVote: () => null }));

const MODULE_STOP_SENTENCE = 'Stopped because the module alpha was turned off by an administrator.';
const ERROR_TEXT = 'Stopped by an administrator';

const net = vi.hoisted(() => ({ tasks: [] as unknown[], unstubbed: [] as string[] }));

const task = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  userId: 'u1',
  type: 'workflow',
  title: `Task ${id}`,
  description: null,
  status: 'failed',
  autoContinue: false,
  currentStepId: null,
  currentStepIndex: 0,
  errorMessage: ERROR_TEXT,
  startedAt: null,
  completedAt: '2026-10-15T09:00:00.000Z',
  createdAt: '2026-10-15T08:00:00.000Z',
  updatedAt: '2026-10-15T09:00:00.000Z',
  repositoryId: null,
  cliProviderId: null,
  containerId: null,
  worktreePath: null,
  repository: null,
  voteScore: 0,
  ...over,
});

async function fakeFetch(input: unknown) {
  const path = new URL(String(input), 'http://localhost').pathname;
  if (path !== '/tasks') {
    net.unstubbed.push(path);
    return { ok: false, status: 404, json: async () => ({ error: `not stubbed: ${path}` }) };
  }
  const body = {
    tasks: net.tasks,
    total: net.tasks.length,
    page: 1,
    pageSize: 20,
    repositories: [],
    globalPause: false,
  };
  return { ok: true, status: 200, json: async () => structuredClone(body) };
}

beforeAll(() => vi.stubGlobal('fetch', fakeFetch));
afterAll(() => vi.unstubAllGlobals());

async function mount(tasks: unknown[]): Promise<Renderer> {
  net.tasks = tasks;
  net.unstubbed = [];
  const view = createRenderer(() => <TasksPage />);
  for (let i = 0; i < 5; i += 1) await view.flush();
  expect(net.unstubbed, 'requests the page made that this test does not stub').toEqual([]);
  return view;
}

const rowText = (view: Renderer, id: string): string => {
  const row = findAll(
    view.tree(),
    (host) => host.tag === 'a' && host.props.href === `/tasks/${id}`,
  )[0];
  if (!row) throw new Error(`the list has no row for task ${id}`);
  return textOf(row);
};

describe('tasks list: a task an urgent module deactivation stopped', () => {
  it('says why on its own row, beside the error text, and on no other row', async () => {
    const view = await mount([
      task('stopped', { stop: { reason: 'module_deactivated', moduleId: 'alpha' } }),
      task('plain', { errorMessage: 'It broke', stop: null }),
    ]);
    expect(rowText(view, 'stopped')).toContain(ERROR_TEXT);
    expect(rowText(view, 'stopped')).toContain(MODULE_STOP_SENTENCE);
    expect(rowText(view, 'plain')).toContain('It broke');
    expect(rowText(view, 'plain')).not.toContain('turned off');
  });

  it('names no module for a stop of any other reason', async () => {
    const view = await mount([task('t1', { stop: { reason: 'maintenance', moduleId: null } })]);
    expect(rowText(view, 't1')).toContain(ERROR_TEXT);
    expect(rowText(view, 't1')).not.toContain('turned off');
  });

  it('names no module on a task that has not failed, whatever stop record it carries', async () => {
    const view = await mount([
      task('t1', {
        status: 'running',
        errorMessage: null,
        stop: { reason: 'module_deactivated', moduleId: 'alpha' },
      }),
    ]);
    expect(rowText(view, 't1')).not.toContain('turned off');
  });
});
