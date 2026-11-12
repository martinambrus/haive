import { afterEach, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { buttons, createRenderer, fire } from '../../../../test/render-tree';
import CliProvidersPage from './page';

vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  ...(await import('../../../../test/render-tree')).reactHooks,
}));
vi.mock('next/link', () => ({ default: ({ children }: { children: unknown }) => children }));
vi.mock('@/lib/use-page-title', () => ({ usePageTitle() {} }));
vi.mock('@/lib/use-cli-login', () => ({ useCliLogin: () => ({ requireCliLogin() {} }) }));
vi.mock('@/components/cli-upgrade-all', () => ({ CliUpgradeAll: () => null }));
vi.mock('@/components/markdown/markdown-view', () => ({ MarkdownView: () => null }));
vi.mock('@/components/action-menu', () => ({
  ActionMenu: ({
    items,
  }: {
    items: ({ key: string; label: string; onClick?: () => void } | false)[];
  }) =>
    items
      .filter(Boolean)
      .map(
        (item) =>
          item && createElement('button', { key: item.key, onClick: item.onClick }, item.label),
      ),
}));
const h = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('@/lib/api-client', async (original) => ({
  ...(await original<typeof import('@/lib/api-client')>()),
  api: h,
}));
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it('aborts sign-out polling when the providers page unmounts', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('confirm', () => true);
  h.post.mockResolvedValue({ jobId: '42' });
  h.get.mockImplementation(async (path: string) => {
    if (path === '/cli-providers')
      return {
        providers: [
          {
            id: 'p',
            name: 'codex',
            label: 'Codex',
            enabled: true,
            authStatus: 'ok',
            envVars: {},
            cliArgs: [],
          },
        ],
      };
    if (path === '/cli-providers/catalog') return { providers: [] };
    if (path === '/usage-window') return { snapshots: [] };
    return { status: 'pending', state: 'waiting' };
  });
  let mounted = true;
  const view = createRenderer(() => (mounted ? createElement(CliProvidersPage) : null));
  await vi.advanceTimersByTimeAsync(0);
  view.draw();
  fire.click(buttons(view.tree(), /^sign out$/i)[0]!);
  await vi.advanceTimersByTimeAsync(0);
  const signal = h.post.mock.calls[0]?.[2] as AbortSignal | undefined;
  mounted = false;
  view.draw();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(signal?.aborted).toBe(true);
  expect(h.get.mock.calls.filter(([path]) => path.includes('/sign-out/'))).toHaveLength(1);
  expect(vi.getTimerCount()).toBe(0);
});
