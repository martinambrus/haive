import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { TEST_CATALOG } from '@/lib/composition-test-catalog';
import type { AdminTaskType } from '@/lib/api-client';
import { FormRenderer } from '@/components/form-renderer';
import { TaskTypeComposer } from '@/components/task-type-composer';
import { Button } from '@/components/ui';
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
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
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

async function mount() {
  hooks.slots = [];
  hooks.mounting = true;
  guard.dirty = [];
  let tree: ReactNode = null;
  const draw = () => {
    for (let pass = 0; pass < 10; pass++) {
      hooks.next = 0;
      hooks.dirty = false;
      tree = TaskTypeEditor({ slug: 'tt-x' });
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
  const reload = () => flatten(tree).find((e) => e.type === Button && textOf(e) === 'Reload');
  const heading = () => flatten(tree).find((e) => e.type === 'h2');
  return {
    form,
    composer,
    notice,
    reload,
    heading,
    text: () => textOf(tree),
    draw,
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
