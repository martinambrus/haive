import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement, type ReactNode } from 'react';
import ReposPage from './page';
import { LinkOriginDialog } from '@/components/repos/link-origin-dialog';
import { buttons, createRenderer, fire, textOf } from '../../../../test/render-tree';
import type { ActionMenuItem } from '@/components/action-menu';

vi.mock('@/components/dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) => (open ? children : null),
}));
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
vi.mock('@/components/repos/link-origin-dialog', () => ({ LinkOriginDialog: vi.fn(() => null) }));
const h = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('@/lib/api-client', () => ({ api: h, API_BASE_URL: '' }));

const UNAVAILABLE =
  'The uploaded archive is no longer available. Delete this repository and upload it again.';
let repo: Record<string, unknown>;
beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(LinkOriginDialog).mockClear();
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
    view.draw();
    fire.click(buttons(view.tree(), /^continue$/i)[0]!);
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

describe('repository retry confirmation ownership', () => {
  async function pendingRetry(nextRepo = 1) {
    h.get.mockResolvedValue({ repositories: [repo, { ...repo, id: 'repo-2', name: 'Repo B' }] });
    let finish!: () => void;
    h.post.mockImplementationOnce(() => new Promise<void>((resolve) => (finish = resolve)));
    const view = await mounted();
    await fire.click(buttons(view.tree(), /^retry$/i)[0]!);
    view.draw();
    fire.click(buttons(view.tree(), /^continue$/i)[0]!);
    view.draw();
    expect(buttons(view.tree(), /^starting…$/i)[0]!.props.disabled).toBe(true);
    fire.click(buttons(view.tree(), /^cancel$/i)[0]!);
    view.draw();
    await fire.click(buttons(view.tree(), /^retry$/i)[nextRepo]!);
    view.draw();
    return { view, finish };
  }

  it('keeps B enabled and open when dismissed A finishes', async () => {
    const { view, finish } = await pendingRetry();
    expect(buttons(view.tree(), /^continue$/i)).toHaveLength(1);
    expect(buttons(view.tree(), /^continue$/i)[0]!.props.disabled).toBe(false);
    finish();
    await vi.advanceTimersByTimeAsync(0);
    view.draw();
    expect(buttons(view.tree(), /^continue$/i)).toHaveLength(1);
    expect(h.post).toHaveBeenCalledTimes(1);
    fire.click(buttons(view.tree(), /^continue$/i)[0]!);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.post).toHaveBeenLastCalledWith('/repos/repo-2/refresh-tree', {});
  });

  it.each([0, 1])(
    'does not close a new unsent dialog for repo index %s when A finishes',
    async (nextRepo) => {
      const { view, finish } = await pendingRetry(nextRepo);
      finish();
      await vi.advanceTimersByTimeAsync(0);
      view.draw();
      expect(buttons(view.tree(), /^cancel$/i)).toHaveLength(1);
      expect(h.post).toHaveBeenCalledTimes(1);
    },
  );

  it('does not clear B sending state or close B when A finishes', async () => {
    const { view, finish } = await pendingRetry();
    let finishB!: () => void;
    h.post.mockImplementationOnce(() => new Promise<void>((resolve) => (finishB = resolve)));
    expect(buttons(view.tree(), /^continue$/i)).toHaveLength(1);
    fire.click(buttons(view.tree(), /^continue$/i)[0]!);
    view.draw();
    finish();
    await vi.advanceTimersByTimeAsync(0);
    view.draw();
    expect(buttons(view.tree(), /^starting…$/i)[0]!.props.disabled).toBe(true);
    expect(buttons(view.tree(), /^cancel$/i)).toHaveLength(1);
    finishB();
    await vi.advanceTimersByTimeAsync(0);
    view.draw();
    expect(buttons(view.tree(), /^cancel$/i)).toHaveLength(0);
    expect(h.post).toHaveBeenCalledTimes(2);
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
    expect(buttons(view.tree(), /^check repair$/i)).toHaveLength(1);
    const recovery = buttons(view.tree(), /^rebuild checkout$/i);
    expect(recovery).toHaveLength(1);
    fire.click(recovery[0]!);
    view.draw();
    expect(textOf(view.tree())).toContain('running commands');
    expect(h.post).not.toHaveBeenCalled();
    fire.click(buttons(view.tree(), /^continue$/i)[0]!);
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

it.each(['git_https', 'local_path'])(
  'offers rebuild after source repair for %s',
  async (source) => {
    repo.source = source;
    repo.localPath = '/source/repo';
    repo.remoteUrl = 'https://example.com/r.git';
    repo.writable = true;
    repo.errorCode = 'source_repair_needed';
    vi.stubGlobal(
      'confirm',
      vi.fn(() => true),
    );
    const view = await mounted();
    expect(buttons(view.tree(), /^retry$/i)).toHaveLength(0);
    fire.click(buttons(view.tree(), /^rebuild checkout$/i)[0]!);
    view.draw();
    fire.click(buttons(view.tree(), /^continue$/i)[0]!);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.post).toHaveBeenCalledWith('/repos/repo-1/recover-checkout', {});
    vi.unstubAllGlobals();
  },
);
it('checks an in-place checkout repair without rebuilding', async () => {
  repo.source = 'git_https';
  repo.remoteUrl = 'https://example.com/r.git';
  repo.errorCode = 'checkout_repair_needed';
  const view = await mounted();
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

describe('repository remote actions', () => {
  it.each([null, 'https://example.com/r.git'])(
    'opens the remote dialog with the saved URL %s',
    async (remoteUrl) => {
      repo.status = 'ready';
      repo.remoteUrl = remoteUrl;
      repo.credentialsSecretId = 'saved-credential';
      const view = await mounted();
      const label = remoteUrl ? 'Change remote' : 'Link to origin';
      const otherLabel = remoteUrl ? 'Link to origin' : 'Change remote';
      expect(buttons(view.tree(), new RegExp('^' + otherLabel + '$', 'i'))).toHaveLength(0);
      const action = buttons(view.tree(), new RegExp('^' + label + '$', 'i'));
      expect(action).toHaveLength(1);
      expect(LinkOriginDialog).not.toHaveBeenCalled();
      fire.click(action[0]!);
      view.draw();
      expect(LinkOriginDialog).toHaveBeenCalledWith(
        expect.objectContaining({
          repositoryId: 'repo-1',
          currentUrl: remoteUrl,
          currentCredentialsId: 'saved-credential',
        }),
      );
    },
  );

  it.each(['cloning', 'error'])(
    'hides remote actions while the repository is %s',
    async (status) => {
      repo.status = status;
      repo.remoteUrl = 'https://example.com/r.git';
      const view = await mounted();
      expect(buttons(view.tree(), /^change remote$/i)).toHaveLength(0);
      expect(buttons(view.tree(), /^link to origin$/i)).toHaveLength(0);
    },
  );
});
