import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HaiveDataSaveResult, HaiveDataStatus } from '@haive/shared/haive-data';
import { HaiveDataPanel } from './haive-data-panel';
import {
  buttons,
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
vi.mock('@/components/project-state-conflicts-banner', () => ({
  ProjectStateConflictsBanner: () => null,
}));
vi.mock('@/components/markdown/markdown-view', () => ({
  MarkdownView: ({ body }: { body: string }) => <div data-markdown>{body}</div>,
}));
const h = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('@/lib/api-client', () => ({ api: { get: h.get, post: h.post } }));

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
beforeEach(() => {
  vi.resetAllMocks();
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
    expect(h.post).toHaveBeenCalledWith('/repos/repo/haive-data/save', {});
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
    expect(textOf(view.tree())).toContain('old sync error');
  });

  it('reports an unchanged save that successfully pushes existing commits', async () => {
    h.post.mockResolvedValue(
      saved({ outcome: 'unchanged', committed: false, commitSha: null, files: [], pushed: true }),
    );
    const view = createRenderer(() => <HaiveDataPanel repositoryId="repo" />);
    await settle(view);
    await fire.click(button(view, 'save & push'));
    await settle(view);
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
    await fire.click(button(view, 'save & push'));
    await settle(view);
    expect(h.post).toHaveBeenCalledWith('/repos/repo/haive-data/save', { push: true });
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
    await fire.click(button(view, 'save & push'));
    await settle(view);
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
});
