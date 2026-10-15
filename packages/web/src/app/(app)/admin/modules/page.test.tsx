import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import type { ModuleDiffRow } from '@haive/shared/modularity';
import type { ModuleOpenTask, ModuleUrgentResponse } from '@/lib/api-client';
import { ModuleActiveCell } from '@/components/module-active-cell';
import { ModuleTasksOpenDialog } from '@/components/module-tasks-open-dialog';
import { FormError } from '@/components/ui';
import ModulesPage from './page';

// No DOM environment here: the page's hooks run on a plain slot list, as in task-type-editor.test.tsx.
const hooks = vi.hoisted(() => ({ slots: [] as unknown[], next: 0, dirty: false, mounting: true }));
const api = vi.hoisted(() => ({ getModulesLoaded: vi.fn(), patchModuleActive: vi.fn() }));
const router = vi.hoisted(() => ({ refresh: vi.fn() }));

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
}));
vi.mock('next/navigation', () => ({ useRouter: () => router }));
vi.mock('@/lib/use-page-title', () => ({ usePageTitle: () => {} }));
vi.mock('@/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-client')>()),
  ...api,
}));

type El = ReactElement<{
  children?: ReactNode;
  role?: string;
  row?: ModuleDiffRow;
  blocked?: unknown;
  message?: string | null;
  onToggle?: () => void;
  onClose?: () => void;
  onDone?: (result: ModuleUrgentResponse) => void;
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

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const row = (id: string, name: string | null): ModuleDiffRow => ({
  id,
  name,
  source: 'workspace',
  entitlementId: null,
  state: 'loaded',
  rowVersion: '1.0.0',
  apiVersion: '1.0.0',
  workerVersion: '1.0.0',
  versionDrift: false,
  lastLoadedAt: '2026-10-15T08:00:00.000Z',
  missingAt: null,
  deactivatedAt: null,
  tornDownAt: null,
  skippedSeeds: [],
});
const TASKS: ModuleOpenTask[] = [
  { id: 't1', title: 'Task t1', status: 'running', ownerId: 'u1', currentStepId: 'module.alpha.x' },
  { id: 't2', title: 'Task t2', status: 'running', ownerId: 'u1', currentStepId: '07-x' },
];
const RESULT: ModuleUrgentResponse = {
  moduleId: 'alpha',
  active: false,
  deactivatedAt: '2026-10-15T09:00:00.000Z',
  stopped: [{ id: 't1', title: 'Task t1', killed: 1, cancelled: 1, stopped: 1 }],
  left: [{ id: 't2', title: 'Task t2', status: 'running', currentStepId: '07-x' }],
  failed: [],
  capped: false,
};
const refusal = (body: Record<string, unknown>) =>
  Object.assign(new Error('Live tasks still use this module. Finish or cancel them first.'), {
    status: 409,
    code: 'module_tasks_open',
    body: { code: 'module_tasks_open', ...body },
  });

async function mount() {
  hooks.slots = [];
  hooks.mounting = true;
  let tree: ReactNode = null;
  const draw = () => {
    for (let pass = 0; pass < 10; pass++) {
      hooks.next = 0;
      hooks.dirty = false;
      tree = ModulesPage();
      hooks.mounting = false;
      if (!hooks.dirty) return;
    }
    throw new Error('the page kept updating its own state');
  };
  draw();
  await flush();
  draw();
  const dialog = () => flatten(tree).find((e) => e.type === ModuleTasksOpenDialog)!;
  return {
    dialog,
    draw,
    notice: () => flatten(tree).find((e) => e.props.role === 'status'),
    error: () => flatten(tree).find((e) => e.type === FormError)?.props.message,
    deactivate: async (id: string) => {
      flatten(tree).find((e) => e.type === ModuleActiveCell && e.props.row?.id === id)!.props
        .onToggle!();
      await flush();
      draw();
    },
  };
}

beforeEach(() => {
  for (const fn of [...Object.values(api), router.refresh]) fn.mockReset();
  api.getModulesLoaded.mockResolvedValue({
    intent: [],
    modules: { workerAt: null, rows: [row('alpha', 'Alpha Search'), row('beta', null)] },
  });
});

describe('Modules page when a deactivation is refused', () => {
  it('hands the dialog the module, its name, the tasks and whether the list was cut', async () => {
    api.patchModuleActive.mockRejectedValue(refusal({ tasks: TASKS, capped: true }));
    const page = await mount();
    expect(page.dialog().props.blocked).toBeNull();
    await page.deactivate('alpha');
    expect(page.dialog().props.blocked).toEqual({
      moduleId: 'alpha',
      name: 'Alpha Search',
      tasks: TASKS,
      capped: true,
    });
  });

  it('passes no name for a module without one, and not capped when the refusal does not say so', async () => {
    api.patchModuleActive.mockRejectedValue(refusal({ tasks: TASKS }));
    const page = await mount();
    await page.deactivate('beta');
    expect(page.dialog().props.blocked).toEqual({
      moduleId: 'beta',
      name: null,
      tasks: TASKS,
      capped: false,
    });
  });

  it('shows any other failure as an error and opens no dialog', async () => {
    api.patchModuleActive.mockRejectedValue(
      Object.assign(new Error('Module not found'), { status: 404, body: {} }),
    );
    const page = await mount();
    await page.deactivate('alpha');
    expect(page.dialog().props.blocked).toBeNull();
    expect(page.error()).toBe('Module not found');
  });

  it('closes on Cancel without turning anything off, reloading or refreshing', async () => {
    api.patchModuleActive.mockRejectedValue(refusal({ tasks: TASKS }));
    const page = await mount();
    await page.deactivate('alpha');
    page.dialog().props.onClose!();
    page.draw();
    expect(page.dialog().props.blocked).toBeNull();
    expect(api.patchModuleActive).toHaveBeenCalledTimes(1);
    expect(api.getModulesLoaded).toHaveBeenCalledTimes(1);
    expect(router.refresh).not.toHaveBeenCalled();
    expect(page.notice()).toBeUndefined();
  });
});

describe('Modules page after Turn off now', () => {
  const turnedOff = async (result: ModuleUrgentResponse) => {
    api.patchModuleActive.mockRejectedValue(refusal({ tasks: TASKS }));
    const page = await mount();
    await page.deactivate('alpha');
    page.dialog().props.onDone!(result);
    await flush();
    page.draw();
    return page;
  };

  it('closes the dialog, reloads the table and the app shell, and counts what happened', async () => {
    const page = await turnedOff(RESULT);
    expect(page.dialog().props.blocked).toBeNull();
    expect(api.getModulesLoaded).toHaveBeenCalledTimes(2);
    expect(router.refresh).toHaveBeenCalledTimes(1);
    expect(textOf(page.notice())).toBe(
      'Turned off Alpha Search: 1 task stopped, 1 left (they fail when they reach one of its steps), 0 could not be stopped.',
    );
  });

  it('lists the tasks it could not stop by the title the refusal gave them, with their error', async () => {
    const page = await turnedOff({
      ...RESULT,
      stopped: [],
      failed: [{ id: 't1', title: 'Task t1', error: 'sandbox refused to die' }],
    });
    expect(textOf(page.notice())).toBe(
      'Turned off Alpha Search: 0 tasks stopped, 1 left (they fail when they reach one of its steps), 1 could not be stopped.\n' +
        '- Task t1: sandbox refused to die',
    );
  });

  it('names a module without a name by its id', async () => {
    api.patchModuleActive.mockRejectedValue(refusal({ tasks: TASKS }));
    const page = await mount();
    await page.deactivate('beta');
    page.dialog().props.onDone!({ ...RESULT, moduleId: 'beta' });
    await flush();
    page.draw();
    expect(textOf(page.notice())).toContain('Turned off beta:');
  });
});
