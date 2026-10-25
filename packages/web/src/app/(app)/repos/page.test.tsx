import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement, type ReactNode } from 'react';
import ReposPage from './page';
import { buttons, createRenderer, fire, textOf } from '../../../../test/render-tree';
import type { ActionMenuItem } from '@/components/action-menu';

vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  ...(await import('../../../../test/render-tree')).reactHooks,
}));
vi.mock('next/link', () => ({ default: ({ children }: { children: ReactNode }) => children }));
vi.mock('@/lib/use-page-title', () => ({ usePageTitle: () => {} }));
vi.mock('@/components/markdown/markdown-view', () => ({
  MarkdownView: ({ body }: { body: string }) => body,
}));
vi.mock('@/components/action-menu', () => ({
  ActionMenu: ({ items }: { items: (ActionMenuItem | false | null | undefined)[] }) =>
    items
      .filter((item): item is ActionMenuItem => !!item)
      .map((item) => createElement('button', { key: item.key, onClick: item.onClick }, item.label)),
}));
const h = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('@/lib/api-client', () => ({ api: h, API_BASE_URL: '' }));

const UNAVAILABLE =
  'The uploaded archive is no longer available. Delete this repository and upload it again.';
let repo: Record<string, unknown>;
beforeEach(() => {
  vi.useFakeTimers();
  repo = {
    id: 'repo-1',
    name: 'Uploaded repo',
    source: 'upload',
    status: 'error',
    remoteUrl: null,
    statusMessage: 'Use Retry to start again.',
    scopeExcludeGlobs: null,
    openTaskCount: 0,
    activeTaskCount: 0,
  };
  h.get.mockReset().mockImplementation(async () => ({ repositories: [repo] }));
  h.post.mockReset().mockResolvedValue({ ok: true });
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});
async function mounted() {
  const view = createRenderer(() => createElement(ReposPage));
  await vi.advanceTimersByTimeAsync(0);
  view.draw();
  return view;
}
describe('repository upload retry', () => {
  it('replaces stale Retry copy with recovery instructions and hides Retry', async () => {
    repo.canRetry = false;
    repo.retryUnavailableReason = UNAVAILABLE;
    const view = await mounted();
    expect(textOf(view.tree())).toContain(UNAVAILABLE);
    expect(textOf(view.tree())).not.toContain('Use Retry to start again.');
    expect(buttons(view.tree(), /^retry$/i)).toHaveLength(0);
  });
  it('offers Retry when availability has not yet been checked, and displays an API refusal', async () => {
    const view = await mounted();
    h.post.mockRejectedValue(new Error(UNAVAILABLE));
    fire.click(buttons(view.tree(), /^retry$/i)[0]!);
    await vi.advanceTimersByTimeAsync(0);
    view.draw();
    expect(h.post).toHaveBeenCalledWith('/repos/repo-1/refresh-tree', {});
    expect(textOf(view.tree())).toContain(UNAVAILABLE);
  });
  it('keeps Retry for remote repositories', async () => {
    repo.source = 'git_https';
    repo.remoteUrl = 'https://example.com/r.git';
    repo.retryUnavailableReason = null;
    const view = await mounted();
    expect(buttons(view.tree(), /^retry$/i)).toHaveLength(1);
  });
});
