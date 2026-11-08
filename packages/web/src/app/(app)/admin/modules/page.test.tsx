import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isValidElement, type ComponentProps, type ReactElement, type ReactNode } from 'react';
import type { ModuleDiffRow } from '@haive/shared/modularity';
import type { ModuleOpenTask, ModuleUrgentResponse } from '@/lib/api-client';
import { ModuleSourceDialog } from '@/components/module-source-dialog';
import { ModulePurgeDialog } from '@/components/module-purge-dialog';
import { InlineMarkdown } from '@/components/markdown/inline-markdown';
import { ModuleActiveCell } from '@/components/module-active-cell';
import { ModuleTasksOpenDialog } from '@/components/module-tasks-open-dialog';
import { FormError } from '@/components/ui';
import ModulesPage from './page';

// No DOM environment here: the page's hooks run on a plain slot list, as in task-type-editor.test.tsx.
const hooks = vi.hoisted(() => ({ slots: [] as unknown[], next: 0, dirty: false, mounting: true }));
const api = vi.hoisted(() => ({
  getModulesLoaded: vi.fn(),
  getModuleSources: vi.fn(),
  fetchModuleSource: vi.fn(),
  patchModuleActive: vi.fn(),
  getModuleDependents: vi.fn(),
  cancelModuleDrain: vi.fn(),
  retryModule: vi.fn(),
}));
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
  useRef: (initial: unknown) => {
    const at = hooks.next++;
    if (!(at in hooks.slots)) hooks.slots[at] = { current: initial };
    return hooks.slots[at];
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
  body?: string;
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
      ? (node.props.body ?? textOf(node.props.children))
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
    purgeDialog: () =>
      flatten(tree).find((e) => e.type === ModulePurgeDialog) as unknown as ReactElement<
        ComponentProps<typeof ModulePurgeDialog>
      >,
    draw,
    text: () => textOf(tree),
    sourcesDialog: () =>
      flatten(tree).find((e) => e.type === ModuleSourceDialog) as unknown as
        ReactElement<ComponentProps<typeof ModuleSourceDialog>> | undefined,
    click: (label: string) => {
      const element = flatten(tree).find(
        (e) => textOf(e.props.children) === label && 'onClick' in e.props,
      )!;
      (element.props as { onClick: () => void }).onClick();
      draw();
    },
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
  api.getModuleSources.mockResolvedValue({ writable: false, sources: [] });
  api.getModuleDependents.mockImplementation(async (moduleId: string) => ({
    moduleId,
    tasks: TASKS,
    capped: false,
  }));
  api.getModulesLoaded.mockResolvedValue({
    intent: [],
    modules: { workerAt: null, rows: [row('alpha', 'Alpha Search'), row('beta', null)] },
  });
});

describe('Modules page preflight', () => {
  it('offers Fetch and Refresh and shows structural fetch status and SHA', async () => {
    api.getModuleSources.mockResolvedValue({
      writable: true,
      fetchConfigured: true,
      sources: [
        {
          id: 's1',
          moduleId: 'alpha',
          kind: 'git',
          url: 'https://example.com/a',
          ref: 'main',
          fetchStatus: 'pinned',
          resolvedSha: 'a'.repeat(40),
          lastError: 'stale failure',
        },
      ],
    });
    api.fetchModuleSource.mockResolvedValue({});
    const page = await mount();
    expect(page.text()).toContain('Fetch');
    expect(page.text()).toContain('Refresh');
    expect(page.text()).toContain('pinned');
    expect(page.text()).toContain('a'.repeat(40));
    expect(page.text()).not.toContain('stale failure');
    page.click('Refresh');
    await flush();
    expect(api.fetchModuleSource).toHaveBeenCalledWith('s1', true);
  });
  it.each([
    ['registry', true, 'Registry fetch requires rebuildable sources and is unavailable.'],
    ['git', false, 'Set HAIVE_OWN_MODULES_HOST_DIR to enable Fetch.'],
  ])('shows the %s fetch refusal as visible copy', async (kind, fetchConfigured, reason) => {
    api.getModuleSources.mockResolvedValue({
      writable: true,
      fetchConfigured,
      sources: [{ id: 's1', moduleId: 'alpha', kind }],
    });
    const page = await mount();
    expect(page.text()).toContain(reason);
  });
  it('hands the dialog the module, its name, the tasks and whether the list was cut', async () => {
    api.getModuleDependents.mockResolvedValue({ moduleId: 'alpha', tasks: TASKS, capped: true });
    const page = await mount();
    expect(page.dialog().props.blocked).toBeNull();
    await page.deactivate('alpha');
    expect(page.dialog().props.blocked).toEqual({
      moduleId: 'alpha',
      name: 'Alpha Search',
      tasks: TASKS,
      capped: true,
      draining: false,
    });
  });

  it('passes no name for a module without one, and not capped when the refusal does not say so', async () => {
    const page = await mount();
    await page.deactivate('beta');
    expect(page.dialog().props.blocked).toEqual({
      moduleId: 'beta',
      name: null,
      tasks: TASKS,
      capped: false,
      draining: false,
    });
  });

  it('shows any other failure as an error and opens no dialog', async () => {
    api.getModuleDependents.mockRejectedValue(
      Object.assign(new Error('Module not found'), { status: 404, body: {} }),
    );
    const page = await mount();
    await page.deactivate('alpha');
    expect(page.dialog().props.blocked).toBeNull();
    expect(page.error()).toBe('Module not found');
  });

  it('closes on Cancel without turning anything off, reloading or refreshing', async () => {
    const page = await mount();
    await page.deactivate('alpha');
    page.dialog().props.onClose!();
    page.draw();
    expect(page.dialog().props.blocked).toBeNull();
    expect(api.patchModuleActive).not.toHaveBeenCalled();
    expect(api.getModuleDependents).toHaveBeenCalledTimes(1);
    expect(api.getModulesLoaded).toHaveBeenCalledTimes(1);
    expect(router.refresh).not.toHaveBeenCalled();
    expect(page.notice()).toBeUndefined();
  });
});

describe('preflight response ownership', () => {
  it('keeps another module usable, prevents duplicate requests, and discards an older target reply', async () => {
    let finishAlpha!: (value: unknown) => void;
    api.getModuleDependents.mockImplementation((id: string) =>
      id === 'alpha'
        ? new Promise((resolve) => {
            finishAlpha = resolve;
          })
        : Promise.resolve({ moduleId: id, tasks: [], capped: false }),
    );
    const page = await mount();
    await page.deactivate('alpha');
    await page.deactivate('alpha');
    expect(api.getModuleDependents).toHaveBeenCalledTimes(1);
    expect(page.dialog().props.blocked).toBeNull();
    await page.deactivate('beta');
    expect(page.dialog().props.blocked).toMatchObject({ moduleId: 'beta', tasks: [] });
    finishAlpha({ moduleId: 'alpha', tasks: TASKS, capped: false });
    await flush();
    page.draw();
    expect(page.dialog().props.blocked).toMatchObject({ moduleId: 'beta', tasks: [] });
    expect(api.patchModuleActive).not.toHaveBeenCalled();
  });

  it('does not enable actions from a response naming another module', async () => {
    api.getModuleDependents.mockResolvedValue({ moduleId: 'beta', tasks: TASKS, capped: false });
    const page = await mount();
    await page.deactivate('alpha');
    expect(page.dialog().props.blocked).toBeNull();
    expect(api.patchModuleActive).not.toHaveBeenCalled();
  });
});

describe('Modules page after Turn off now', () => {
  const turnedOff = async (result: ModuleUrgentResponse) => {
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
    const page = await mount();
    await page.deactivate('beta');
    page.dialog().props.onDone!({ ...RESULT, moduleId: 'beta' });
    await flush();
    page.draw();
    expect(textOf(page.notice())).toContain('Turned off beta:');
  });
});

describe('Modules page after purge', () => {
  it('renders the actual deletion counts through the Markdown renderer', async () => {
    const page = await mount();
    page.purgeDialog().props.onDone({
      moduleId: 'alpha',
      database: 'haive_module_alpha',
      configKeysDeleted: 2,
      taskTypesDeleted: ['alpha__unused'],
      taskTypesKept: ['alpha__used'],
      integrationsDeleted: {
        providerConfigs: 1,
        connections: 7,
        userSettings: 2,
        preferences: 3,
        taskChoices: 4,
        grants: 5,
      },
    });
    await flush();
    page.draw();
    expect(textOf(page.notice())).toContain('7 connected accounts');
    expect(textOf(page.notice())).toContain('5 task or repository account grants');
    expect(textOf(page.notice())).toContain('kept 1 task type');
    expect(flatten(page.notice()).some((e) => e.type === InlineMarkdown)).toBe(true);
  });
});

describe('module install sources', () => {
  it('shows the Install sources section and source-checkout instructions', async () => {
    const page = await mount();
    expect(page.text()).toContain('Install sources');
    expect(page.text()).toContain('pnpm module add');
    expect(page.text()).toContain('read-only');
    expect(page.text()).not.toContain('Add source');
    expect(page.sourcesDialog()).toBeUndefined();
  });
});

describe('editable install sources', () => {
  it('lists saved sources, opens add/edit/delete targets and discards an old close callback', async () => {
    const source = {
      id: 'source-one',
      moduleId: 'alpha',
      kind: 'git',
      url: 'https://example.com/a.git',
      ref: 'main',
      hasToken: true,
    };
    api.getModuleSources.mockResolvedValue({ writable: true, sources: [source] });
    const page = await mount();
    expect(page.text()).toContain(source.url);
    expect(page.text()).toContain('Stored');
    expect(page.text()).not.toContain('read-only');
    page.click('Add source');
    const oldClose = page.sourcesDialog()!.props.onClose;
    expect(page.sourcesDialog()!.props.target.mode).toBe('add');
    oldClose();
    page.draw();
    page.click('Edit');
    expect(page.sourcesDialog()!.props.target).toEqual({ mode: 'edit', source });
    oldClose();
    page.draw();
    expect(page.sourcesDialog()!.props.target.mode).toBe('edit');
    page.sourcesDialog()!.props.onClose();
    page.draw();
    page.click('Delete');
    expect(page.sourcesDialog()!.props.target).toEqual({ mode: 'delete', source });
  });
});

describe('Modules page retry and runtime state', () => {
  type Runtime = NonNullable<ModuleDiffRow['runtime']>;
  type CellProps = { onRetry?: () => void; busy?: boolean };
  const runtimeOf = (state: Runtime['state']): Runtime => ({
    state,
    schema: state === 'ready' ? 'ready' : 'failed',
    jobs: state === 'ready' ? 'running' : 'none',
    attempts: 2,
    reason: state === 'ready' ? null : 'schema migration refused',
  });
  const serve = (...rows: ModuleDiffRow[]) =>
    api.getModulesLoaded.mockResolvedValue({ intent: [], modules: { workerAt: null, rows } });
  const failedAlpha = (): ModuleDiffRow => ({
    ...row('alpha', 'Alpha Search'),
    runtime: runtimeOf('failed'),
  });

  async function mountTree() {
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
    const cell = (id: string) =>
      flatten(tree).find((e) => e.type === ModuleActiveCell && e.props.row?.id === id)!;
    return {
      draw,
      cell,
      onRetry: (id: string) => {
        const handler = (cell(id).props as CellProps).onRetry;
        expect(typeof handler).toBe('function');
        return handler!;
      },
      busy: (id: string) => (cell(id).props as CellProps).busy,
      notice: () => flatten(tree).find((e) => e.props.role === 'status'),
      error: () => flatten(tree).find((e) => e.type === FormError)?.props.message,
    };
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it('U7 retries a failed row once, reloads the table and names the module in the notice', async () => {
    serve(failedAlpha(), row('beta', null));
    api.retryModule.mockResolvedValue({ moduleId: 'alpha' });
    const page = await mountTree();
    page.onRetry('alpha')();
    await flush();
    page.draw();
    expect(api.retryModule).toHaveBeenCalledTimes(1);
    expect(api.retryModule).toHaveBeenCalledWith('alpha');
    expect(api.getModulesLoaded).toHaveBeenCalledTimes(2);
    expect(textOf(page.notice())).toContain('Alpha Search');
    expect(flatten(page.notice()).some((e) => e.type === InlineMarkdown)).toBe(true);
    expect(page.error()).toBeFalsy();
    expect(page.busy('alpha')).toBe(false);
  });

  it('U8 shows a rejected retry through FormError, no notice, and frees the cell, never reading the body', async () => {
    serve(failedAlpha());
    let touched = false;
    const body = new Proxy(
      {},
      {
        get: () => {
          touched = true;
          return undefined;
        },
      },
    );
    api.retryModule.mockRejectedValue(
      Object.assign(new Error('Another lifecycle action is changing this module'), {
        status: 503,
        body,
      }),
    );
    const page = await mountTree();
    page.onRetry('alpha')();
    await flush();
    page.draw();
    expect(page.error()).toBe('Another lifecycle action is changing this module');
    expect(page.notice()).toBeUndefined();
    expect(page.busy('alpha')).toBe(false);
    expect(touched).toBe(false);
  });

  it('U9 sends one request for two calls while the first is pending, with the cell busy meanwhile', async () => {
    serve(failedAlpha());
    let finish!: (value: unknown) => void;
    api.retryModule.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const page = await mountTree();
    const first = page.onRetry('alpha');
    first();
    page.draw();
    expect(page.busy('alpha')).toBe(true);
    first();
    page.onRetry('alpha')();
    page.draw();
    expect(api.retryModule).toHaveBeenCalledTimes(1);
    finish({ moduleId: 'alpha' });
    await flush();
    page.draw();
    expect(page.busy('alpha')).toBe(false);
  });

  const polled = async (...rows: ModuleDiffRow[]) => {
    serve(...rows);
    const page = await mountTree();
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    hooks.mounting = true;
    page.draw();
    return page;
  };

  it.each([
    ['U10a a failed active row', 'failed' as const],
    ['U10b a pending active row', 'pending' as const],
  ])('%s keeps the 5 s poll running', async (_name, state) => {
    await polled({ ...row('alpha', 'Alpha Search'), runtime: runtimeOf(state) });
    expect(vi.getTimerCount()).toBe(1);
    api.getModulesLoaded.mockClear();
    vi.advanceTimersByTime(5000);
    expect(api.getModulesLoaded).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['ready rows', [{ ...row('alpha', 'Alpha Search'), runtime: runtimeOf('ready') }]],
    ['rows without runtime', [row('alpha', 'Alpha Search'), row('beta', null)]],
    [
      'a deactivated row whose runtime is failed',
      [
        {
          ...row('alpha', 'Alpha Search'),
          deactivatedAt: '2026-10-15T09:00:00.000Z',
          runtime: runtimeOf('failed'),
        },
      ],
    ],
  ])('U10c guard: %s schedule no poll', async (_name, rows) => {
    await polled(...(rows as ModuleDiffRow[]));
    expect(vi.getTimerCount()).toBe(0);
  });
});
