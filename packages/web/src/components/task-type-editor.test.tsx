import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { TEST_CATALOG } from '@/lib/composition-test-catalog';
import type { AdminTaskType } from '@/lib/api-client';
import { FormRenderer } from '@/components/form-renderer';
import { TaskTypeComposer } from '@/components/task-type-composer';
import { Button, FormError } from '@/components/ui';
import { draftStorageKey, TaskTypeCreatorPanel } from './task-type-creator-panel';
import { TaskTypeDeleteDialog } from './task-type-delete-dialog';
import { TaskTypeEditor } from './task-type-editor';

// No DOM environment in this package, and the editor's save path has to change state: its hooks
// run on a plain slot list, as in notifications/toast-stack.test.tsx. The form and the composer are
// never rendered; their props are read off the element tree and called the way they would call.
const hooks = vi.hoisted(() => ({ slots: [] as unknown[], next: 0, dirty: false, mounting: true }));
const api = vi.hoisted(() => ({
  getTaskTypeCatalog: vi.fn(),
  getAdminTaskType: vi.fn(),
  updateTaskType: vi.fn(),
  createTaskType: vi.fn(),
}));
const guard = vi.hoisted(() => ({ dirty: [] as boolean[] }));
const router = vi.hoisted(() => ({ push: vi.fn() }));

vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  useState: (initial: unknown) => {
    const at = hooks.next++;
    if (!(at in hooks.slots)) hooks.slots[at] = initial;
    const set = (update: unknown) => {
      const value = typeof update === 'function' ? update(hooks.slots[at]) : update;
      if (!Object.is(value, hooks.slots[at])) {
        hooks.slots[at] = value;
        hooks.dirty = true;
      }
    };
    return [hooks.slots[at], set];
  },
  useEffect: (effect: () => void) => {
    if (hooks.mounting) effect();
  },
  useCallback: (fn: unknown) => fn,
  useMemo: (fn: () => unknown) => fn(),
  useRef: (initial: unknown) => {
    const at = hooks.next++;
    if (!(at in hooks.slots)) hooks.slots[at] = { current: initial };
    return hooks.slots[at];
  },
}));
vi.mock('next/navigation', () => ({ useRouter: () => router }));
vi.mock('@/lib/use-page-title', () => ({ usePageTitle: () => {} }));
vi.mock('@/lib/use-unsaved-changes-guard', () => ({
  useUnsavedChangesGuard: (dirty: boolean) => {
    guard.dirty.push(dirty);
    return null;
  },
}));
vi.mock('@/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-client')>()),
  ...api,
}));

type El = ReactElement<{
  children?: ReactNode;
  role?: string;
  onClick?: () => void;
  tabIndex?: number;
  ref?: { current: unknown };
}>;

const flatten = (node: ReactNode): El[] =>
  Array.isArray(node)
    ? node.flatMap(flatten)
    : isValidElement<El['props']>(node)
      ? [node, ...flatten(node.props.children)]
      : [];

const textOf = (node: ReactNode): string =>
  Array.isArray(node)
    ? node.map(textOf).join('')
    : isValidElement<El['props']>(node)
      ? textOf(node.props.children)
      : typeof node === 'string' || typeof node === 'number'
        ? String(node)
        : '';

const IMPLEMENT = '07-phase-2-implement';
const VALIDATE = '07b-phase-4-validate';
const WORKTREE = '01-worktree-setup';
const FIELDS = [
  'displayName',
  'description',
  'stepIds',
  'preAnswerDefaults',
  'stepLoopLimitDefaults',
  'promptSteps',
  'requiresRepository',
  'selectable',
  'enabled',
  'sortOrder',
];
const ROW: AdminTaskType = {
  slug: 'tt-x',
  displayName: 'Type X',
  description: null,
  runListStrategy: 'static',
  stepIds: [WORKTREE, IMPLEMENT, VALIDATE],
  preAnswerDefaults: { [IMPLEMENT]: { depth: 1 }, [VALIDATE]: { depth: 2 } },
  stepLoopLimitDefaults: { [VALIDATE]: 3 },
  promptSteps: {},
  fixLoop: null,
  enabled: true,
  selectable: true,
  source: 'admin',
  requiresRepository: true,
  sortOrder: 0,
  contentHash: null,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-14T12:00:00.123Z',
  editableFields: FIELDS,
};
const THEIRS: AdminTaskType = {
  ...ROW,
  displayName: 'Theirs',
  stepIds: [WORKTREE, IMPLEMENT],
  preAnswerDefaults: { [IMPLEMENT]: { depth: 9 } },
  stepLoopLimitDefaults: {},
  updatedAt: '2026-10-14T12:30:00.456Z',
};
const FLAT = {
  displayName: 'Mine',
  description: '',
  requiresRepository: true,
  enabled: true,
  selectable: true,
  sortOrder: 0,
};
const AVAILABLE = { available: true } as const;

const refusal = (taskType: AdminTaskType) =>
  Object.assign(new Error('The task type was changed since it was loaded'), {
    status: 409,
    code: 'task_type_changed',
    body: {
      error: 'The task type was changed since it was loaded',
      code: 'task_type_changed',
      taskType,
    },
  });

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

async function mount(slug: string | null = 'tt-x') {
  hooks.slots = [];
  hooks.mounting = true;
  guard.dirty = [];
  let tree: ReactNode = null;
  const draw = () => {
    for (let pass = 0; pass < 10; pass++) {
      hooks.next = 0;
      hooks.dirty = false;
      tree = TaskTypeEditor({ slug });
      hooks.mounting = false;
      if (!hooks.dirty) return;
    }
    throw new Error('the editor kept updating its own state');
  };
  draw();
  await flush();
  draw();

  const form = () => {
    const el = flatten(tree).find((e) => e.type === FormRenderer);
    if (!el) throw new Error('no form rendered');
    return el as unknown as ReactElement<{
      initialValues: Record<string, unknown>;
      errorMessage: string | null;
      submitDisabled: boolean;
      onSubmit: (values: Record<string, unknown>) => Promise<void>;
      onValuesChange: (values: Record<string, unknown>) => void;
      renderAfterField: (id: string) => ReactNode;
    }>;
  };
  const composer = () => {
    const el = flatten(form().props.renderAfterField('sortOrder')).find(
      (e) => e.type === TaskTypeComposer,
    );
    if (!el) throw new Error('no composer rendered');
    return el as unknown as ReactElement<{
      stepIds: string[];
      onStepIdsChange: (ids: string[]) => void;
      onLoopLimitsChange: (limits: Record<string, number>) => void;
    }>;
  };
  const notice = () => flatten(tree).find((e) => e.props.role === 'alert');
  const panel = () =>
    flatten(tree).find((e) => e.type === TaskTypeCreatorPanel) as unknown as
      | ReactElement<{
          slug: string | null;
          editorState: Record<string, unknown>;
          onLoad: (draft: Record<string, unknown>) => void;
        }>
      | undefined;
  const failure = () =>
    flatten(tree).find((e) => e.type === FormError)?.props as unknown as
      { message: string } | undefined;
  const reload = () => flatten(tree).find((e) => e.type === Button && textOf(e) === 'Reload');
  const heading = () => flatten(tree).find((e) => e.type === 'h2');
  const deleteDialog = () =>
    flatten(tree).find((e) => e.type === TaskTypeDeleteDialog) as unknown as ReactElement<{
      onDeleted: (slug: string) => void;
    }>;
  return {
    form,
    composer,
    notice,
    reload,
    heading,
    deleteDialog,
    panel,
    failure,
    text: () => textOf(tree),
    draw,
    load: (draft: Record<string, unknown>) => {
      const el = panel();
      if (!el) throw new Error('no creator panel rendered');
      el.props.onLoad(draft);
      draw();
    },
    save: async (values: Record<string, unknown> = FLAT) => {
      await form().props.onSubmit(values);
      draw();
    },
    edit: (values: Record<string, unknown>) => {
      form().props.onValuesChange(values);
      draw();
    },
    clickReload: async () => {
      const button = reload();
      if (!button?.props.onClick) throw new Error('no Reload button to click');
      button.props.onClick();
      await flush();
      draw();
    },
  };
}

beforeEach(() => {
  router.push.mockReset();
  for (const fn of Object.values(api)) fn.mockReset();
  api.getTaskTypeCatalog.mockResolvedValue(TEST_CATALOG);
  api.getAdminTaskType.mockResolvedValue({
    taskType: ROW,
    availability: AVAILABLE,
    compositionIssues: [],
  });
});

describe('TaskTypeEditor save', () => {
  it('sends the updatedAt of the row it loaded as the precondition', async () => {
    api.updateTaskType.mockResolvedValue({ taskType: { ...ROW, displayName: 'Mine' } });
    const view = await mount();
    expect(view.form().props.submitDisabled).toBe(false);
    await view.save();
    expect(api.updateTaskType).toHaveBeenCalledTimes(1);
    expect(api.updateTaskType).toHaveBeenCalledWith('tt-x', {
      displayName: 'Mine',
      expectedUpdatedAt: ROW.updatedAt,
    });
  });

  it('sends the updatedAt of the row the last save returned on the next save', async () => {
    const saved = { ...ROW, displayName: 'Mine', updatedAt: '2026-10-14T12:10:00.000Z' };
    api.updateTaskType.mockResolvedValue({ taskType: saved });
    const view = await mount();
    await view.save();
    await view.save({ ...FLAT, displayName: 'Mine again' });
    expect(api.updateTaskType.mock.calls.map(([, body]) => body.expectedUpdatedAt)).toEqual([
      ROW.updatedAt,
      saved.updatedAt,
    ]);
  });

  it('sends the step list alone for a removal, leaving the preset and loop-limit prune to the api', async () => {
    api.updateTaskType.mockResolvedValue({ taskType: ROW });
    const view = await mount();
    const kept = [WORKTREE, IMPLEMENT];
    view.composer().props.onStepIdsChange(kept);
    view.composer().props.onLoopLimitsChange({});
    view.draw();
    await view.save({ ...FLAT, displayName: 'Type X' });
    expect(api.updateTaskType).toHaveBeenCalledWith('tt-x', {
      stepIds: kept,
      expectedUpdatedAt: ROW.updatedAt,
    });
  });
});

describe('TaskTypeEditor when the type was changed elsewhere', () => {
  it('shows the notice with Reload instead of an error, disables Save, and does not retry', async () => {
    api.updateTaskType.mockRejectedValue(refusal(THEIRS));
    const view = await mount();
    view.edit(FLAT);
    await view.save();
    expect(api.updateTaskType).toHaveBeenCalledTimes(1);
    expect(view.notice()).toBeDefined();
    expect(textOf(view.notice())).toContain('This task type was changed elsewhere');
    expect(view.reload()).toBeDefined();
    expect(view.form().props.errorMessage).toBeNull();
    expect(view.form().props.submitDisabled).toBe(true);
    expect(view.text()).not.toContain('Saved.');
    expect(guard.dirty.at(-1)).toBe(true);
  });

  it('replaces the editor with the returned row on Reload, dropping the unsaved edits', async () => {
    api.updateTaskType.mockRejectedValue(refusal(THEIRS));
    const view = await mount();
    const before = view.form().key;
    view.edit(FLAT);
    await view.save();
    await view.clickReload();
    expect(view.notice()).toBeUndefined();
    expect(view.form().props.initialValues).toMatchObject({ displayName: 'Theirs' });
    expect(view.form().key).not.toBe(before);
    expect(view.composer().props.stepIds).toEqual(THEIRS.stepIds);
    expect(view.form().props.submitDisabled).toBe(false);
    expect(guard.dirty.at(-1)).toBe(false);
    expect(api.updateTaskType).toHaveBeenCalledTimes(1);
  });

  it('moves the focus to the heading on Reload, since the button that held it is gone', async () => {
    api.updateTaskType.mockRejectedValue(refusal(THEIRS));
    const view = await mount();
    view.edit(FLAT);
    await view.save();
    const focus = vi.fn();
    const heading = view.heading();
    expect(heading?.props.tabIndex).toBe(-1);
    heading!.props.ref!.current = { focus };
    await view.clickReload();
    expect(focus).toHaveBeenCalledTimes(1);
  });

  it('refreshes the availability on Reload and saves from the returned row afterwards', async () => {
    api.updateTaskType.mockRejectedValueOnce(refusal(THEIRS));
    api.updateTaskType.mockResolvedValueOnce({ taskType: { ...THEIRS, displayName: 'Mine' } });
    const view = await mount();
    view.edit(FLAT);
    await view.save();
    expect(api.getAdminTaskType).toHaveBeenCalledTimes(1);
    api.getAdminTaskType.mockResolvedValue({
      taskType: THEIRS,
      availability: { available: false, reason: 'disabled' },
      compositionIssues: [],
    });
    await view.clickReload();
    expect(api.getAdminTaskType).toHaveBeenCalledTimes(2);
    expect(view.text()).toContain('Unavailable: disabled');
    await view.save();
    expect(api.updateTaskType.mock.calls.at(-1)).toEqual([
      'tt-x',
      { displayName: 'Mine', expectedUpdatedAt: THEIRS.updatedAt },
    ]);
  });

  it('keeps showing an ordinary failure as an error, with no notice', async () => {
    api.updateTaskType.mockRejectedValue(
      Object.assign(new Error('Cannot change slug on this task type'), { status: 400, body: {} }),
    );
    const view = await mount();
    await view.save();
    expect(view.notice()).toBeUndefined();
    expect(view.form().props.errorMessage).toBe('Cannot change slug on this task type');
  });
});

const tool = {
  name: 'repo_status',
  description: 'Fetches the status.',
  action: 'http-get' as const,
  url: 'https://example.com/status',
  query: [],
  params: [],
  timeoutMs: 10_000,
  maxResponseBytes: 20_000,
};
const LISTED = 'custom.tt-x.list';
const WITH_TOOLS: AdminTaskType = {
  ...ROW,
  stepIds: [LISTED],
  preAnswerDefaults: {},
  stepLoopLimitDefaults: {},
  promptSteps: {
    list: {
      slug: 'list',
      title: 'List',
      template: 'List TODOs.',
      capabilities: [],
      tools: [tool],
      timeoutMs: 600_000,
      description: 'Kept note',
    },
  },
};
const promptDraft = (slug: string, over: Record<string, unknown> = {}) => ({
  slug,
  displayName: 'Drafted name',
  description: 'Drafted description',
  requiresRepository: true,
  stepIds: [`custom.${slug}.list`],
  promptSteps: {
    list: {
      slug: 'list',
      title: 'Drafted step',
      template: 'List every TODO for {{task.title}}.',
      capabilities: ['tool_use'],
      timeoutMs: 300_000,
    },
  },
  ...over,
});

describe('TaskTypeEditor creator panel', () => {
  it('is offered on the create page, with the editor as the agent should read it', async () => {
    const view = await mount(null);
    const panel = view.panel();
    expect(panel?.props.slug).toBeNull();
    expect(panel?.props.editorState).toEqual({
      slug: '',
      displayName: '',
      description: '',
      requiresRepository: true,
      stepIds: [],
      stepLoopLimitDefaults: {},
      promptSteps: {},
    });
  });

  it('is offered on a custom type, which sends the slug of the type although the form holds none', async () => {
    const view = await mount();
    const panel = view.panel();
    expect(panel?.props.slug).toBe('tt-x');
    expect(panel?.props.editorState).toMatchObject({
      slug: 'tt-x',
      displayName: 'Type X',
      stepIds: ROW.stepIds,
      stepLoopLimitDefaults: { [VALIDATE]: 3 },
    });
  });

  it('keeps all but the draftable parts of a prompt step out of what the agent reads', async () => {
    api.getAdminTaskType.mockResolvedValue({
      taskType: WITH_TOOLS,
      availability: AVAILABLE,
      compositionIssues: [],
    });
    const view = await mount();
    const state = JSON.stringify(view.panel()?.props.editorState);
    expect(state).toContain('List TODOs.');
    expect(state).not.toContain('Kept note');
    expect(state).not.toContain('repo_status');
  });

  it('is not offered on a built-in type, a module type, or to someone the api refuses', async () => {
    for (const source of ['builtin', 'module:statistics']) {
      api.getAdminTaskType.mockResolvedValue({
        taskType: { ...ROW, source, editableFields: ['displayName', 'sortOrder'] },
        availability: AVAILABLE,
        compositionIssues: [],
      });
      expect((await mount()).panel()).toBeUndefined();
    }
    api.getTaskTypeCatalog.mockRejectedValue(
      Object.assign(new Error('Admin access required'), { status: 403 }),
    );
    const refused = await mount(null);
    expect(refused.panel()).toBeUndefined();
    expect(refused.failure()?.message).toBe('Admin access required');
  });
});

describe('TaskTypeEditor loading a draft', () => {
  it('shows it on the create page as unsaved changes, and writes nothing', async () => {
    const view = await mount(null);
    const before = view.form().key;
    view.load(promptDraft('todo-audit'));
    expect(view.form().key).not.toBe(before);
    expect(view.form().props.initialValues).toMatchObject({
      slug: 'todo-audit',
      displayName: 'Drafted name',
      description: 'Drafted description',
      requiresRepository: true,
    });
    expect(view.composer().props.stepIds).toEqual(['custom.todo-audit.list']);
    expect(view.form().props.submitDisabled).toBe(false);
    expect(guard.dirty.at(-1)).toBe(true);
    expect(api.createTaskType).not.toHaveBeenCalled();
    expect(api.updateTaskType).not.toHaveBeenCalled();
    expect(api.getAdminTaskType).not.toHaveBeenCalled();
  });

  it('hands the agent what is loaded on its next message', async () => {
    const view = await mount(null);
    view.load(promptDraft('todo-audit'));
    expect(view.panel()?.props.editorState).toMatchObject({
      slug: 'todo-audit',
      displayName: 'Drafted name',
      stepIds: ['custom.todo-audit.list'],
    });
  });

  it('saves a loaded draft, after an edit by hand, with the Save of the create page', async () => {
    api.createTaskType.mockResolvedValue({ taskType: ROW });
    const view = await mount(null);
    view.load(promptDraft('todo-audit'));
    view.edit({ displayName: 'Edited by hand' });
    await view.save({
      slug: 'todo-audit',
      displayName: 'Edited by hand',
      description: 'Drafted description',
      requiresRepository: true,
      enabled: true,
      selectable: true,
      sortOrder: 0,
    });
    expect(api.createTaskType).toHaveBeenCalledTimes(1);
    expect(api.createTaskType).toHaveBeenCalledWith({
      slug: 'todo-audit',
      displayName: 'Edited by hand',
      description: 'Drafted description',
      stepIds: ['custom.todo-audit.list'],
      promptSteps: {
        list: {
          slug: 'list',
          title: 'Drafted step',
          template: 'List every TODO for {{task.title}}.',
          capabilities: ['tool_use'],
          tools: [],
          timeoutMs: 300_000,
        },
      },
      requiresRepository: true,
      selectable: true,
      enabled: true,
      sortOrder: 0,
    });
  });

  it('stops the create page resuming its conversation once the type is created, and only then', async () => {
    const store = new Map([
      [draftStorageKey(null), 'task-new'],
      [draftStorageKey('other'), 'task-other'],
    ]);
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => void store.set(key, value),
        removeItem: (key: string) => void store.delete(key),
      },
    });
    const values = {
      slug: 'todo-audit',
      displayName: 'Drafted name',
      description: 'Drafted description',
      requiresRepository: true,
      enabled: true,
      selectable: true,
      sortOrder: 0,
    };
    try {
      api.createTaskType.mockRejectedValueOnce(new Error('Slug taken'));
      const failed = await mount(null);
      failed.load(promptDraft('todo-audit'));
      await failed.save(values);
      expect(store.get(draftStorageKey(null))).toBe('task-new');

      api.createTaskType.mockResolvedValueOnce({ taskType: ROW });
      const view = await mount(null);
      view.load(promptDraft('todo-audit'));
      await view.save(values);
      expect(api.createTaskType).toHaveBeenCalledTimes(2);
      expect(store.has(draftStorageKey(null))).toBe(false);
      expect(store.get(draftStorageKey('other'))).toBe('task-other');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('shows it on a saved type as unsaved changes against the saved row, under the saved slug', async () => {
    const view = await mount();
    const before = view.form().key;
    view.load(promptDraft('somebody-else'));
    expect(view.form().key).not.toBe(before);
    expect(view.form().props.initialValues).toMatchObject({ displayName: 'Drafted name' });
    expect(view.form().props.initialValues).not.toHaveProperty('slug');
    expect(view.panel()?.props.editorState).toMatchObject({ slug: 'tt-x' });
    expect(view.composer().props.stepIds).toEqual(['custom.tt-x.list']);
    expect(guard.dirty.at(-1)).toBe(true);
    expect(api.updateTaskType).not.toHaveBeenCalled();
  });

  it('saves a loaded draft to a saved type as the difference from the row, keeping the tools it had', async () => {
    api.getAdminTaskType.mockResolvedValue({
      taskType: WITH_TOOLS,
      availability: AVAILABLE,
      compositionIssues: [],
    });
    api.updateTaskType.mockResolvedValue({ taskType: WITH_TOOLS });
    const view = await mount();
    view.load(promptDraft('tt-x', { description: '' }));
    await view.save({ ...FLAT, displayName: 'Drafted name' });
    expect(api.updateTaskType).toHaveBeenCalledTimes(1);
    const [slug, body] = api.updateTaskType.mock.calls[0]!;
    expect(slug).toBe('tt-x');
    expect(body).toMatchObject({ displayName: 'Drafted name', expectedUpdatedAt: ROW.updatedAt });
    expect(body.stepIds).toBeUndefined();
    expect(body.promptSteps.list).toMatchObject({
      title: 'Drafted step',
      template: 'List every TODO for {{task.title}}.',
      tools: [tool],
      description: 'Kept note',
      timeoutMs: 300_000,
    });
  });

  it('is replaced by the row a Reload brings in', async () => {
    api.updateTaskType.mockRejectedValue(refusal(THEIRS));
    const view = await mount();
    view.load(promptDraft('tt-x'));
    await view.save({ ...FLAT, displayName: 'Drafted name' });
    await view.clickReload();
    expect(view.form().props.initialValues).toMatchObject({ displayName: 'Theirs' });
    expect(view.composer().props.stepIds).toEqual(THEIRS.stepIds);
    expect(guard.dirty.at(-1)).toBe(false);
  });

  it('is replaced by what the next load brings', async () => {
    const view = await mount(null);
    view.load(promptDraft('first-draft'));
    const key = view.form().key;
    view.load(promptDraft('second-draft', { displayName: 'Second' }));
    expect(view.form().key).not.toBe(key);
    expect(view.form().props.initialValues).toMatchObject({
      slug: 'second-draft',
      displayName: 'Second',
    });
    expect(view.composer().props.stepIds).toEqual(['custom.second-draft.list']);
  });
});

describe('TaskTypeEditor leaving the page it saved or deleted from', () => {
  const NEW_VALUES = {
    slug: 'todo-audit',
    displayName: 'Drafted name',
    description: 'Drafted description',
    requiresRepository: true,
    enabled: true,
    selectable: true,
    sortOrder: 0,
  };
  // What the editor last asked of the guard when the router was told to go, once the page had drawn.
  function guardWhenSent(view: Awaited<ReturnType<typeof mount>>) {
    const seen: Array<boolean | undefined> = [];
    router.push.mockImplementation(() => {
      view.draw();
      seen.push(guard.dirty.at(-1));
    });
    return seen;
  }

  it('lets go of the unsaved-changes guard before it goes to the type it created', async () => {
    api.createTaskType.mockResolvedValue({ taskType: ROW });
    const view = await mount(null);
    view.load(promptDraft('todo-audit'));
    expect(guard.dirty.at(-1)).toBe(true);
    const seen = guardWhenSent(view);
    await view.save(NEW_VALUES);
    expect(router.push).toHaveBeenCalledTimes(1);
    expect(router.push).toHaveBeenCalledWith('/admin/task-types/todo-audit');
    expect(seen).toEqual([false]);
  });

  it('lets go of the guard before it goes back to the list after a delete', async () => {
    const view = await mount();
    view.edit(FLAT);
    expect(guard.dirty.at(-1)).toBe(true);
    const seen = guardWhenSent(view);
    view.deleteDialog().props.onDeleted('tt-x');
    expect(router.push).toHaveBeenCalledTimes(1);
    expect(router.push).toHaveBeenCalledWith('/admin/task-types');
    expect(seen).toEqual([false]);
  });

  it('keeps the guard when the create fails, and goes nowhere', async () => {
    api.createTaskType.mockRejectedValue(new Error('Slug taken'));
    const view = await mount(null);
    view.load(promptDraft('todo-audit'));
    await view.save(NEW_VALUES);
    expect(router.push).not.toHaveBeenCalled();
    expect(guard.dirty.at(-1)).toBe(true);
  });
});

describe('TaskTypeEditor stored tool problems', () => {
  const stale = {
    kind: 'tool-no-longer-valid',
    stepId: LISTED,
    index: 0,
    raw: 'stale_tool',
    start: 0,
    message: 'The tool `stale_tool` no longer passes its checks; fix it or remove it.',
  };
  const shown = (view: Awaited<ReturnType<typeof mount>>) =>
    (view.composer().props as { serverPromptIssues?: unknown }).serverPromptIssues;

  it('W8 hands the composer the problems GET names on a stored tool, before any edit', async () => {
    api.getAdminTaskType.mockResolvedValue({
      taskType: WITH_TOOLS,
      availability: AVAILABLE,
      compositionIssues: [],
      promptStepIssues: [stale],
    });
    const view = await mount();
    expect(shown(view)).toEqual([
      expect.objectContaining({ kind: stale.kind, stepId: LISTED, raw: stale.raw }),
    ]);
    expect(guard.dirty.at(-1)).toBe(false);

    api.getAdminTaskType.mockResolvedValue({
      taskType: WITH_TOOLS,
      availability: AVAILABLE,
      compositionIssues: [],
    });
    expect(shown(await mount())).toEqual([]);
  });
});
