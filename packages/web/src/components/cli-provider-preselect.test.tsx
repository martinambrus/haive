import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRenderer, findAll, textOf } from '../../test/render-tree';
import RepoTerminalPage from '../app/(app)/repos/[id]/terminal/page';
import { PlanStarter } from './plan/plan-starter';
import { PlanChat } from './plan/plan-chat';

vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  ...(await import('../../test/render-tree')).reactHooks,
}));
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
vi.mock('next/navigation', () => ({ useParams: () => ({ id: 'repo' }) }));
vi.mock('@/lib/use-page-title', () => ({ usePageTitle: () => {} }));
vi.mock('@/components/terminal/InteractiveShell', () => ({ InteractiveShell: () => null }));
vi.mock('@/components/markdown/markdown-view', () => ({ MarkdownView: () => null }));
const net = vi.hoisted(() => ({
  providers: null as { id: string; enabled: boolean; label: string; name: string }[] | null,
  preferred: null as string | null,
  defaultProviderId: 'old' as string | null,
}));
vi.mock('@/lib/api-client', async (original) => ({
  ...(await original<typeof import('@/lib/api-client')>()),
  api: {
    get: async (path: string) =>
      path === '/cli-providers'
        ? {
            providers: net.providers ?? [
              { id: 'new', enabled: true, label: 'New', name: 'codex' },
              { id: 'old', enabled: true, label: 'Old', name: 'codex' },
            ],
            defaultProviderId: net.defaultProviderId,
          }
        : { repository: { id: 'repo', name: 'Repo', status: 'ready' } },
  },
  getPlanBuildClis: async () => ({
    plannerCliProviderId: net.preferred,
    questionerCliProviderId: net.preferred,
  }),
  getPlanMessages: async () => ({ messages: [], conversations: [] }),
  markPlanNodeRead: async () => undefined,
}));
afterEach(() => {
  net.providers = null;
  net.preferred = null;
  net.defaultProviderId = 'old';
  vi.unstubAllGlobals();
});

describe.each([
  ['repo terminal', () => <RepoTerminalPage />, 1],
  [
    'plan starter',
    () => (
      <PlanStarter
        repositoryId="repo"
        onboarded
        onNavigate={() => {}}
        onCreateRoot={async () => {}}
      />
    ),
    2,
  ],
  ['plan chat', () => <PlanChat repositoryId="repo" nodeId="node" onPatched={() => {}} />, 1],
] as const)('%s provider preselect', (_name, render, count) => {
  it('uses the server default even when a newer row is first', async () => {
    vi.stubGlobal('window', { addEventListener() {}, removeEventListener() {} });
    const view = createRenderer(render);
    for (let i = 0; i < 5; i++) await view.flush();
    expect(findAll(view.tree(), (h) => h.tag === 'select' && h.props.value === 'old')).toHaveLength(
      count,
    );
  });
});

describe.each([
  [
    'plan starter',
    () => (
      <PlanStarter
        repositoryId="repo"
        onboarded
        onNavigate={() => {}}
        onCreateRoot={async () => {}}
      />
    ),
    2,
  ],
  ['plan chat', () => <PlanChat repositoryId="repo" nodeId="node" onPatched={() => {}} />, 1],
] as const)('%s remembered provider', (_name, render, count) => {
  it('keeps the enabled planner choice ahead of the global default', async () => {
    net.preferred = 'new';
    const view = createRenderer(render);
    for (let i = 0; i < 5; i++) await view.flush();
    expect(findAll(view.tree(), (h) => h.tag === 'select' && h.props.value === 'new')).toHaveLength(
      count,
    );
  });
  it('uses the server default when the remembered provider is unavailable', async () => {
    net.preferred = 'missing';
    const view = createRenderer(render);
    for (let i = 0; i < 5; i++) await view.flush();
    expect(findAll(view.tree(), (h) => h.tag === 'select' && h.props.value === 'old')).toHaveLength(
      count,
    );
  });
});

it.each([
  [[], 'No CLI providers configured.'],
  [[{ id: 'off', enabled: false, label: 'Off', name: 'codex' }], 'Every CLI provider is disabled.'],
])('explains why the repo terminal has no usable CLI: %j', async (providers, message) => {
  net.providers = providers;
  net.defaultProviderId = null;
  const view = createRenderer(() => <RepoTerminalPage />);
  for (let i = 0; i < 5; i++) await view.flush();
  expect(findAll(view.tree(), (h) => h.tag === 'option')).toHaveLength(0);
  expect(textOf(view.tree())).toContain(message);
});
