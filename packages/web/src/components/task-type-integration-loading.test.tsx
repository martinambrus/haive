import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { TaskTypeEditor } from './task-type-editor';
import { TEST_CATALOG } from '@/lib/composition-test-catalog';
import { buttons, createRenderer, fire } from '../../test/render-tree';

const api = vi.hoisted(() => ({
  getTaskTypeCatalog: vi.fn(),
  getAdminTaskType: vi.fn(),
  getIntegrationCategories: vi.fn(),
  listIntegrationProviders: vi.fn(),
}));
const saved = vi.hoisted(() => ({ composer: {} as Record<string, unknown>, dirty: false }));
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  ...(await import('../../test/render-tree')).reactHooks,
}));
vi.mock('@/lib/api-client', async (original) => ({
  ...(await original<typeof import('@/lib/api-client')>()),
  ...api,
}));
vi.mock('next/link', () => ({
  default: ({ children, ...props }: { children: ReactNode }) => <a {...props}>{children}</a>,
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/lib/use-page-title', () => ({ usePageTitle: () => {} }));
vi.mock('@/lib/use-unsaved-changes-guard', () => ({
  useUnsavedChangesGuard: (dirty: boolean) => {
    saved.dirty = dirty;
    return null;
  },
}));
vi.mock('@/components/task-type-creator-panel', () => ({ TaskTypeCreatorPanel: () => null }));
vi.mock('@/components/task-type-delete-dialog', () => ({ TaskTypeDeleteDialog: () => null }));
vi.mock('@/components/form-renderer', () => ({
  FormRenderer: (props: { renderAfterField: (id: string) => ReactNode }) =>
    props.renderAfterField('sortOrder'),
}));
vi.mock('@/components/task-type-composer', () => ({
  TaskTypeComposer: (props: Record<string, unknown>) => {
    saved.composer = props;
    return (
      <button onClick={props.onRefreshIntegrationInfo as () => void}>Refresh providers</button>
    );
  },
}));
vi.mock('@/components/markdown/markdown-view', () => ({
  MarkdownView: ({ body }: { body: string }) => body,
}));
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const row = (slug: string) => ({
  slug,
  displayName: slug,
  source: 'admin',
  stepIds: [],
  promptSteps: {},
  preAnswerDefaults: {},
  stepLoopLimitDefaults: {},
  requiresRepository: false,
  enabled: true,
  selectable: true,
  sortOrder: 0,
  editableFields: ['stepIds', 'promptSteps', 'sortOrder'],
});
beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  api.getTaskTypeCatalog.mockResolvedValue(TEST_CATALOG);
  api.getAdminTaskType.mockImplementation(async (slug: string) => ({
    taskType: row(slug),
    availability: { available: true },
  }));
  api.getIntegrationCategories.mockResolvedValue({
    categories: [{ id: 'module.notes.docs', label: 'Notes documents' }],
  });
  api.listIntegrationProviders.mockResolvedValue({
    providers: [{ id: 'module.notes.cloud', enabled: true }],
  });
  saved.composer = {};
  saved.dirty = false;
});
afterEach(() => vi.useRealTimers());
describe('task type editor integration metadata loading', () => {
  it.each([null, 'existing'])(
    'loads independently of the %s draft and keeps draft/dirty state on late success',
    async (slug) => {
      const pending = deferred<{ providers: unknown[] }>();
      api.listIntegrationProviders.mockReturnValue(pending.promise);
      const view = createRenderer(() => <TaskTypeEditor slug={slug} />);
      await view.flush();
      expect(api.listIntegrationProviders).toHaveBeenCalledTimes(1);
      expect(saved.composer.integrationInfo).toMatchObject({ status: 'loading' });
      expect(saved.composer.integrationCategories).toEqual([
        { id: 'module.notes.docs', label: 'Notes documents' },
      ]);
      (saved.composer.onStepIdsChange as (ids: string[]) => void)(['draft-step']);
      view.draw();
      expect(saved.dirty).toBe(true);
      pending.resolve({ providers: [{ id: 'github', enabled: true }] });
      await view.flush();
      expect(saved.composer.integrationInfo).toMatchObject({
        status: 'current',
        providers: [{ id: 'github', enabled: true }],
      });
      expect(saved.composer.stepIds).toEqual(['draft-step']);
      expect(saved.dirty).toBe(true);
    },
  );
  it('hides old healthy data on refresh failure, retries without changing the draft', async () => {
    const view = createRenderer(() => <TaskTypeEditor slug="existing" />);
    await view.flush();
    (saved.composer.onStepIdsChange as (ids: string[]) => void)(['draft-step']);
    view.draw();
    api.listIntegrationProviders.mockRejectedValueOnce(new Error('unavailable'));
    const refresh = () => fire.click(buttons(view.tree(), /^refresh providers$/i)[0]!);
    refresh();
    await view.flush();
    expect(saved.composer.integrationInfo).toMatchObject({ status: 'error' });
    refresh();
    await view.flush();
    expect(saved.composer.integrationInfo).toMatchObject({ status: 'current' });
    expect(saved.composer.stepIds).toEqual(['draft-step']);
    expect(saved.dirty).toBe(true);
  });
  it('ignores old metadata and type loads after route changes and unmount', async () => {
    const oldProviders = deferred<{ providers: unknown[] }>();
    const oldRow = deferred<unknown>();
    api.listIntegrationProviders.mockReturnValueOnce(oldProviders.promise);
    api.getAdminTaskType.mockReturnValueOnce(oldRow.promise);
    let slug = 'old';
    let mounted = true;
    const view = createRenderer(() => (mounted ? <TaskTypeEditor slug={slug} /> : null));
    slug = 'new';
    view.draw();
    await view.flush();
    (saved.composer.onStepIdsChange as (ids: string[]) => void)(['new-draft']);
    view.draw();
    oldProviders.resolve({ providers: [{ id: 'old-provider', enabled: true }] });
    oldRow.resolve({ taskType: row('old'), availability: { available: true } });
    await view.flush();
    expect(saved.composer.stepIds).toEqual(['new-draft']);
    expect(saved.composer.integrationInfo).toMatchObject({
      status: 'current',
      providers: [{ id: 'module.notes.cloud' }],
    });
    const late = deferred<{ providers: unknown[] }>();
    api.listIntegrationProviders.mockReturnValueOnce(late.promise);
    fire.click(buttons(view.tree(), /^refresh providers$/i)[0]!);
    view.draw();
    mounted = false;
    view.draw();
    late.resolve({ providers: [] });
    await flush();
    expect(view.draw().kids).toEqual([]);
  });
  it('retains category authoring when providers fail, and refuses current state when categories fail', async () => {
    api.listIntegrationProviders.mockRejectedValueOnce(new Error('providers failed'));
    const view = createRenderer(() => <TaskTypeEditor slug="existing" />);
    await view.flush();
    expect(saved.composer.integrationCategories).toEqual([
      { id: 'module.notes.docs', label: 'Notes documents' },
    ]);
    expect(saved.composer.integrationInfo).toMatchObject({ status: 'error', providers: [] });
    api.getIntegrationCategories.mockRejectedValueOnce(new Error('categories failed'));
    fire.click(buttons(view.tree(), /^refresh providers$/i)[0]!);
    await view.flush();
    expect(saved.composer.integrationInfo).toMatchObject({ status: 'error', providers: [] });
  });
  it.each(['provider pending', 'provider failed and catalog pending'])(
    'times out when %s and permits a fresh attempt',
    async (scenario) => {
      vi.useFakeTimers();
      // Shared session recovery can still be pending even after fetch was aborted.
      if (scenario === 'provider pending') {
        api.listIntegrationProviders.mockImplementationOnce(() => new Promise(() => {}));
      } else {
        // An early failure must not remove the remaining reads' deadline.
        api.listIntegrationProviders.mockRejectedValueOnce(new Error('providers failed'));
        api.getTaskTypeCatalog.mockImplementationOnce(() => new Promise(() => {}));
      }
      const view = createRenderer(() => <TaskTypeEditor slug="existing" />);
      await vi.advanceTimersByTimeAsync(0);
      view.draw();
      expect(saved.composer.integrationInfo).toMatchObject({ status: 'loading' });
      await vi.advanceTimersByTimeAsync(15_000);
      view.draw();
      expect(saved.composer.integrationInfo).toMatchObject({ status: 'error', providers: [] });
      expect(api.listIntegrationProviders.mock.calls[0]![0].aborted).toBe(true);
      fire.click(buttons(view.tree(), /^refresh providers$/i)[0]!);
      await vi.advanceTimersByTimeAsync(0);
      view.draw();
      expect(saved.composer.integrationInfo).toMatchObject({ status: 'current' });
    },
  );
});
