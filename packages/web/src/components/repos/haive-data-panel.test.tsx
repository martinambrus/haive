import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HaiveDataSaveResult, HaiveDataStatus } from '@haive/shared/haive-data';
import { api } from '@/lib/api-client';
import { HaiveDataPanel } from './haive-data-panel';
import {
  buttons,
  controls,
  createRenderer,
  fire,
  isDisabled,
  textOf,
  type Renderer,
} from '../../../test/render-tree';

vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  ...(await import('../../../test/render-tree')).reactHooks,
}));
vi.mock('next/link', () => ({ default: 'a' }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: h.push }) }));
vi.mock('@/components/dialog', async (original) => ({
  ...(await original<typeof import('@/components/dialog')>()),
  Dialog: ({ open, children }: { open: boolean; children: import('react').ReactNode }) =>
    open ? <div role="dialog">{children}</div> : null,
}));
vi.mock('@/components/project-state-conflicts-banner', () => ({
  ProjectStateConflictsBanner: () => null,
}));
vi.mock('@/components/markdown/markdown-view', () => ({
  MarkdownView: ({ body }: { body: string }) => <div data-markdown>{body}</div>,
}));
const h = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), push: vi.fn() }));

const clean = (): HaiveDataStatus => ({
  checkout: 'ready',
  branch: 'main',
  files: [{ path: '.haive-data/plan.json', change: 'unchanged', staged: false }],
  record: {
    dirty: false,
    writePending: false,
    lastError: 'old record error',
    syncError: 'old sync error',
    syncedHead: 'abc',
  },
  snapshot: { dirty: false, lastError: 'old snapshot error' },
  holds: { save: [], push: [] },
});
const saved = (overrides: Partial<HaiveDataSaveResult> = {}): HaiveDataSaveResult => ({
  outcome: 'saved',
  committed: true,
  commitSha: '123abc',
  files: ['.haive-data/plan.json'],
  skipped: [],
  pushed: false,
  branch: 'main',
  refusal: null,
  indexSynced: true,
  ...overrides,
});
const settle = async (view: Renderer) => {
  for (let i = 0; i < 3; i++) await view.flush();
};
const button = (view: Renderer, name: string) => buttons(view.tree(), name)[0]!;
const pushAndConfirm = async (view: Renderer) => {
  fire.click(button(view, 'save & push'));
  view.draw();
  fire.click(button(view, 'confirm save & push'));
  await settle(view);
};
beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(api, 'get').mockImplementation(h.get);
  vi.spyOn(api, 'post').mockImplementation(h.post);
  h.get.mockResolvedValue(clean());
  h.post.mockResolvedValue(saved());
});
afterEach(() => vi.restoreAllMocks());

describe('Haive data actions and status', () => {
  it('sends an explicit JSON object, waits for the worker, then refreshes status', async () => {
    let finish!: (result: HaiveDataSaveResult) => void;
    h.post.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const view = createRenderer(() => <HaiveDataPanel repositoryId="repo" />);
    expect(isDisabled(button(view, 'save'))).toBe(true);
    await settle(view);
    const saveButton = button(view, 'save');
    const pending = fire.click(saveButton);
    // A second click before React paints the disabled state must not enqueue another save.
    fire.click(saveButton);
    view.draw();
    expect(h.post).toHaveBeenCalledOnce();
    expect(h.get).toHaveBeenCalledWith('/repositories/repo/haive-data', expect.any(AbortSignal));
    expect(h.post).toHaveBeenCalledWith('/repositories/repo/haive-data/save', {});
    expect(textOf(view.tree())).toContain('Saving');
    expect(isDisabled(button(view, 'save & push'))).toBe(true);
    finish(saved());
    await pending;
    await settle(view);
    expect(h.get.mock.calls.length).toBeGreaterThan(1);
    expect(textOf(view.tree())).toContain('123abc');
    expect(textOf(view.tree())).toContain('Not pushed');
  });

  it('keeps stale diagnostics quiet and permits dirty projections to be saved', async () => {
    const status = clean();
    status.record.dirty = true;
    status.snapshot.dirty = true;
    h.get.mockResolvedValueOnce(clean()).mockResolvedValue(status);
    const view = createRenderer(() => <HaiveDataPanel repositoryId="repo" />);
    await settle(view);
    expect(textOf(view.tree())).not.toContain('old record error');
    expect(textOf(view.tree())).not.toContain('old snapshot error');
    await fire.click(button(view, 'refresh'));
    await settle(view);
    expect(textOf(view.tree())).toContain('old record error');
    expect(textOf(view.tree())).toContain('old snapshot error');
    expect(isDisabled(button(view, 'save'))).toBe(false);
  });

  it('uses separate action holds and shows successful HTTP refusal codes', async () => {
    const status = clean();
    status.holds.push = [{ code: 'no_origin' }];
    h.get.mockResolvedValue(status);
    h.post.mockResolvedValue(
      saved({
        outcome: 'refused',
        committed: false,
        commitSha: null,
        refusal: { code: 'record_absent' },
      }),
    );
    const view = createRenderer(() => <HaiveDataPanel repositoryId="repo" />);
    await settle(view);
    expect(isDisabled(button(view, 'save'))).toBe(false);
    expect(isDisabled(button(view, 'save & push'))).toBe(true);
    expect(isDisabled(controls(view.tree(), 'commit message')[0]!)).toBe(false);
    await fire.click(button(view, 'save'));
    await settle(view);
    expect(textOf(view.tree())).toContain('record_absent');
    expect(textOf(view.tree())).toContain('Save refused');
  });

  it('shows pending recovery structurally and holds both actions', async () => {
    const status = clean();
    status.record.writePending = true;
    status.holds.save = status.holds.push = [{ code: 'write_pending' }];
    h.get.mockResolvedValue(status);
    const view = createRenderer(() => <HaiveDataPanel repositoryId="repo" />);
    await settle(view);
    expect(isDisabled(button(view, 'save'))).toBe(true);
    expect(isDisabled(button(view, 'save & push'))).toBe(true);
    expect(textOf(view.tree())).toContain('Write pending recovery');
    expect(isDisabled(controls(view.tree(), 'commit message')[0]!)).toBe(true);
    expect(textOf(view.tree())).toContain('old sync error');
  });

  it('reports an unchanged save that successfully pushes existing commits', async () => {
    h.post.mockResolvedValue(
      saved({ outcome: 'unchanged', committed: false, commitSha: null, files: [], pushed: true }),
    );
    const view = createRenderer(() => <HaiveDataPanel repositoryId="repo" />);
    await settle(view);
    await pushAndConfirm(view);
    expect(textOf(view.tree())).toContain('No new commit needed');
    expect(textOf(view.tree())).toContain('Pushed to origin.');
  });

  it('preserves a committed result when push fails and lists skipped files', async () => {
    h.post.mockResolvedValue(
      saved({
        outcome: 'failed',
        failure: { code: 'push_failed' },
        skipped: ['.haive-data/state/future.json'],
        indexSynced: false,
      }),
    );
    const view = createRenderer(() => <HaiveDataPanel repositoryId="repo" />);
    await settle(view);
    await pushAndConfirm(view);
    expect(h.post).toHaveBeenCalledWith('/repositories/repo/haive-data/save', { push: true });
    const text = textOf(view.tree());
    for (const value of ['push_failed', '123abc', 'Not pushed', 'future.json', 'index'])
      expect(text).toContain(value);
  });

  it('shows merge conflicts and keeps request errors visible through refresh', async () => {
    h.post
      .mockResolvedValueOnce(
        saved({
          outcome: 'conflict',
          conflict: { paths: ['app.ts'], autoResolved: [], unrelated: true },
        }),
      )
      .mockRejectedValueOnce(new Error('Request failed'));
    const view = createRenderer(() => <HaiveDataPanel repositoryId="repo" />);
    await settle(view);
    await pushAndConfirm(view);
    expect(textOf(view.tree())).toContain('app.ts');
    expect(textOf(view.tree())).toContain('unrelated');
    await fire.click(button(view, 'save'));
    await settle(view);
    expect(textOf(view.tree())).toContain('Request failed');
    expect(textOf(view.tree())).not.toContain('app.ts');
  });

  it('reports an unread listing neutrally and retries failed reads', async () => {
    h.get.mockRejectedValueOnce(new Error('Status unavailable'));
    const view = createRenderer(() => <HaiveDataPanel repositoryId="repo" />);
    await settle(view);
    expect(isDisabled(button(view, 'save'))).toBe(true);
    expect(textOf(view.tree())).toContain('Status unavailable');
    h.get.mockResolvedValue({ ...clean(), files: null });
    await fire.click(button(view, 'refresh'));
    await settle(view);
    expect(textOf(view.tree())).toContain('File status unavailable');
    expect(textOf(view.tree())).not.toContain('Status unavailable');
  });

  it('explicitly starts a merge without plan nodes and navigates to the task using the real API helper', async () => {
    h.get.mockResolvedValue({ ...clean(), files: [] });
    let finish!: (value: { taskId: string }) => void;
    h.post
      .mockResolvedValueOnce(
        saved({
          outcome: 'conflict',
          conflict: { paths: ['app.ts'], autoResolved: [], unrelated: false },
        }),
      )
      .mockReturnValueOnce(
        new Promise((resolve) => {
          finish = resolve;
        }),
      );
    const view = createRenderer(() => <HaiveDataPanel repositoryId="repo" />);
    await settle(view);
    await pushAndConfirm(view);
    // Receiving the conflict or refreshing must never spend tokens automatically.
    expect(h.post).toHaveBeenCalledTimes(1);
    const staleResolve = button(view, 'resolve with an agent');
    fire.click(button(view, 'refresh'));
    fire.click(staleResolve);
    expect(h.post).toHaveBeenCalledTimes(1);
    await settle(view);
    const resolve = button(view, 'resolve with an agent');
    expect(resolve).toBeDefined();
    const save = button(view, 'save');
    const refresh = button(view, 'refresh');
    const pending = fire.click(resolve);
    fire.click(resolve);
    fire.click(save);
    fire.click(refresh);
    view.draw();
    expect(h.post).toHaveBeenCalledTimes(2);
    expect(h.post).toHaveBeenLastCalledWith('/repositories/repo/plan/merge', {});
    expect(isDisabled(button(view, 'save'))).toBe(true);
    expect(isDisabled(button(view, 'refresh'))).toBe(true);
    expect(textOf(view.tree())).toContain('Starting merge');
    finish({ taskId: 'merge-task' });
    await pending;
    await settle(view);
    expect(h.push).toHaveBeenCalledExactlyOnceWith('/tasks/merge-task');
  });

  it('shows a rejected merge start and permits an explicit retry', async () => {
    h.post
      .mockResolvedValueOnce(
        saved({
          outcome: 'conflict',
          conflict: { paths: ['app.ts'], autoResolved: [], unrelated: false },
        }),
      )
      .mockRejectedValueOnce(new Error('No CLI provider available'))
      .mockResolvedValueOnce({ taskId: 'retry-task' });
    const view = createRenderer(() => <HaiveDataPanel repositoryId="repo" />);
    await settle(view);
    await pushAndConfirm(view);
    expect(button(view, 'resolve with an agent')).toBeDefined();
    await fire.click(button(view, 'resolve with an agent'));
    await settle(view);
    expect(textOf(view.tree())).toContain('No CLI provider available');
    expect(h.push).not.toHaveBeenCalled();
    expect(isDisabled(button(view, 'resolve with an agent'))).toBe(false);
    await fire.click(button(view, 'resolve with an agent'));
    await settle(view);
    expect(h.push).toHaveBeenCalledExactlyOnceWith('/tasks/retry-task');
    expect(textOf(view.tree())).not.toContain('No CLI provider available');
  });

  it('does not navigate back to a merge after the person leaves the page', async () => {
    let finish!: (value: { taskId: string }) => void;
    h.post
      .mockResolvedValueOnce(
        saved({
          outcome: 'conflict',
          conflict: { paths: ['app.ts'], autoResolved: [], unrelated: false },
        }),
      )
      .mockReturnValueOnce(
        new Promise((resolve) => {
          finish = resolve;
        }),
      );
    let visible = true;
    const view = createRenderer(() => (visible ? <HaiveDataPanel repositoryId="repo" /> : null));
    await settle(view);
    await pushAndConfirm(view);
    fire.click(button(view, 'resolve with an agent'));
    visible = false;
    view.draw();
    finish({ taskId: 'late-task' });
    await settle(view);
    expect(h.push).not.toHaveBeenCalled();
  });

  it.each([false, true])('sends an edited, trimmed commit message with push=%s', async (push) => {
    const view = createRenderer(() => <HaiveDataPanel repositoryId="repo" />);
    await settle(view);
    const input = controls(view.tree(), 'commit message')[0];
    expect(input).toBeDefined();
    fire.type(input!, '  chore: share updated project settings  ');
    view.draw();
    fire.click(button(view, push ? 'save & push' : 'save'));
    view.draw();
    if (push) fire.click(button(view, 'confirm save & push'));
    await settle(view);
    expect(h.post).toHaveBeenCalledExactlyOnceWith('/repositories/repo/haive-data/save', {
      ...(push ? { push: true } : {}),
      commitMessage: 'chore: share updated project settings',
    });
  });

  it('confirms pushing existing commits, sends nothing on cancel, and guards duplicate confirmation', async () => {
    let finish!: (value: HaiveDataSaveResult) => void;
    h.post.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const view = createRenderer(() => <HaiveDataPanel repositoryId="repo" />);
    await settle(view);
    fire.click(button(view, 'save & push'));
    view.draw();
    expect(h.post).not.toHaveBeenCalled();
    expect(textOf(view.tree())).toContain('existing commits');
    const staleConfirm = button(view, 'confirm save & push');
    fire.click(button(view, 'cancel'));
    view.draw();
    fire.click(staleConfirm);
    expect(h.post).not.toHaveBeenCalled();
    fire.click(button(view, 'save & push'));
    view.draw();
    const confirm = button(view, 'confirm save & push');
    fire.click(confirm);
    fire.click(confirm);
    view.draw();
    expect(h.post).toHaveBeenCalledExactlyOnceWith('/repositories/repo/haive-data/save', {
      push: true,
    });
    finish(saved({ pushed: true }));
    await settle(view);
  });

  it.each(['', '   ', 'chore(haive): save Haive data'])(
    'uses the default request for message %j',
    async (message) => {
      const view = createRenderer(() => <HaiveDataPanel repositoryId="repo" />);
      await settle(view);
      fire.type(controls(view.tree(), 'commit message')[0]!, message);
      view.draw();
      fire.click(button(view, 'save'));
      await settle(view);
      expect(h.post).toHaveBeenCalledExactlyOnceWith('/repositories/repo/haive-data/save', {});
    },
  );

  it.each(['x'.repeat(501), 'message\0suffix'])(
    'refuses messages outside the API limits',
    async (message) => {
      const view = createRenderer(() => <HaiveDataPanel repositoryId="repo" />);
      await settle(view);
      fire.type(controls(view.tree(), 'commit message')[0]!, message);
      view.draw();
      expect(isDisabled(button(view, 'save'))).toBe(true);
      expect(isDisabled(button(view, 'save & push'))).toBe(true);
      expect(h.post).not.toHaveBeenCalled();
      // Invalid input remains editable so the person can correct it.
      expect(isDisabled(controls(view.tree(), 'commit message')[0]!)).toBe(false);
    },
  );

  it('rechecks holds that arrive while the confirmation is open', async () => {
    vi.useFakeTimers();
    try {
      const view = createRenderer(() => <HaiveDataPanel repositoryId="repo" />);
      await vi.advanceTimersByTimeAsync(0);
      view.draw();
      fire.click(button(view, 'save & push'));
      view.draw();
      const staleConfirm = button(view, 'confirm save & push');
      const held = clean();
      held.holds.push = [{ code: 'no_origin' }];
      h.get.mockResolvedValue(held);
      await vi.advanceTimersByTimeAsync(5000);
      view.draw();
      expect(isDisabled(button(view, 'confirm save & push'))).toBe(true);
      fire.click(staleConfirm);
      expect(h.post).not.toHaveBeenCalled();
      fire.click(button(view, 'cancel'));
      view.draw();
      expect(isDisabled(button(view, 'save & push'))).toBe(true);
      expect(isDisabled(button(view, 'save'))).toBe(false);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
});
