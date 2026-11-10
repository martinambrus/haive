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
vi.mock('@/components/upgrade-available-banner', () => ({ UpgradeAvailableBanner: () => null }));
vi.mock('@/components/project-state-conflicts-banner', () => ({
  ProjectStateConflictsBanner: () => null,
}));
vi.mock('@/components/tooling-upgrade-banner', () => ({ ToolingUpgradeBanner: () => null }));
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
  it.each(['upload', 'blank', 'git_https', 'github_https', 'github_oauth', 'gitlab_https'])(
    'replaces stale Retry copy with recovery instructions and hides Retry for %s',
    async (source) => {
      repo.source = source;
      const recovery =
        source === 'upload'
          ? UNAVAILABLE
          : 'This repository has no remote. Delete this repository and create it again from a repository URL or local folder.';
      repo.canRetry = false;
      repo.retryUnavailableReason = recovery;
      const view = await mounted();
      expect(textOf(view.tree())).toContain(recovery);
      expect(textOf(view.tree())).not.toContain('Use Retry to start again.');
      expect(buttons(view.tree(), /^retry$/i)).toHaveLength(0);
    },
  );
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
    repo.canRetry = true;
    repo.source = 'git_https';
    repo.remoteUrl = 'https://example.com/r.git';
    repo.retryUnavailableReason = null;
    const view = await mounted();
    expect(buttons(view.tree(), /^retry$/i)).toHaveLength(1);
  });
});

describe('repair-needed repository errors', () => {
  it('hides Retry and offers recovery by code, regardless of the message', async () => {
    repo.source = 'git_https';
    repo.remoteUrl = 'https://example.com/r.git';
    repo.canRetry = true;
    repo.errorCode = 'checkout_repair_needed';
    repo.statusMessage = 'Arbitrary display copy';
    vi.stubGlobal(
      'confirm',
      vi.fn(() => true),
    );
    const view = await mounted();
    expect(buttons(view.tree(), /^retry$/i)).toHaveLength(0);
    const recovery = buttons(view.tree(), /^rebuild checkout$/i);
    expect(recovery).toHaveLength(1);
    fire.click(recovery[0]!);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.post).toHaveBeenCalledWith('/repos/repo-1/recover-checkout', {});
    vi.unstubAllGlobals();
  });
  it('keeps Retry for an ordinary error even when its message mentions repair', async () => {
    repo.errorCode = null;
    repo.statusMessage = 'Retry cannot help until the checkout is repaired.';
    const view = await mounted();
    expect(buttons(view.tree(), /^retry$/i)).toHaveLength(1);
    expect(buttons(view.tree(), /^rebuild checkout$/i)).toHaveLength(0);
  });
  it('ignores a stale repair code on a ready repository', async () => {
    repo.status = 'ready';
    repo.errorCode = 'checkout_repair_needed';
    const view = await mounted();
    expect(buttons(view.tree(), /^rebuild checkout$/i)).toHaveLength(0);
  });
});

it('offers repair guidance and a repair check for an unusable source', async () => {
  repo.source = 'local_path';
  repo.localPath = '/source/repo';
  repo.writable = true;
  repo.errorCode = 'source_repair_needed';
  const view = await mounted();
  expect(buttons(view.tree(), /^retry$/i)).toHaveLength(0);
  expect(buttons(view.tree(), /^rebuild checkout$/i)).toHaveLength(0);
  fire.click(buttons(view.tree(), /^repair checkout$/i)[0]!);
  view.draw();
  expect(textOf(view.tree())).toContain('Keep the repository registered');
  fire.click(buttons(view.tree(), /^check repair$/i)[0]!);
  await vi.advanceTimersByTimeAsync(0);
  expect(h.post).toHaveBeenCalledWith('/repos/repo-1/refresh-tree', {});
});

it('clears open repair guidance when polling observes the repository ready', async () => {
  repo.source = 'local_path';
  repo.localPath = '/source/repo';
  repo.errorCode = 'source_repair_needed';
  const view = await mounted();
  fire.click(buttons(view.tree(), /^repair checkout$/i)[0]!);
  view.draw();
  expect(textOf(view.tree())).toContain('Repair the Git metadata');
  repo = { ...repo, status: 'ready', errorCode: null };
  await vi.advanceTimersByTimeAsync(5000);
  view.draw();
  expect(textOf(view.tree())).not.toContain('Repair the Git metadata');
});

it('offers repair guidance for a read-only folder even if the repository has a remote', async () => {
  repo.source = 'local_path';
  repo.localPath = '/source/repo';
  repo.writable = false;
  repo.remoteUrl = 'https://example.com/r.git';
  repo.errorCode = 'checkout_repair_needed';
  const view = await mounted();
  expect(buttons(view.tree(), /^rebuild checkout$/i)).toHaveLength(0);
  expect(buttons(view.tree(), /^repair checkout$/i)).toHaveLength(1);
});
