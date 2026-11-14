import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import TaskDetailPage from './page';
import { useActiveTime } from '@/lib/active-time/use-active-time';
import {
  buttons,
  createRenderer,
  findAll,
  fire,
  textOf,
  type Host,
  type Renderer,
} from '../../../../../test/render-tree';

// No DOM in this package: the page runs through test/render-tree.ts, and the network is a stub of fetch.
vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  ...(await import('../../../../../test/render-tree')).reactHooks,
}));
vi.mock('@/lib/active-time/use-active-time', async (original) => {
  const mod = await original<typeof import('@/lib/active-time/use-active-time')>();
  return { ...mod, useActiveTime: vi.fn(mod.useActiveTime) };
});
vi.mock('next/navigation', () => ({
  useParams: () => ({ id: net.routeId }),
  useRouter: () => ({ replace: () => {}, push: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('next/link', async () => {
  const { createElement } = await import('react');
  return {
    default: ({ href, children }: { href: string; children?: unknown }) =>
      createElement('a', { href }, children as never),
  };
});

vi.mock('lucide-react', async (importOriginal) =>
  Object.fromEntries(Object.keys(await importOriginal<object>()).map((name) => [name, () => null])),
);
vi.mock('@/lib/use-page-title', () => ({ usePageTitle: () => {} }));
// The dialog's request/outcome behavior has its own DOM controls. Exercise the
// page's notice lifecycle through its real callback without opening a portal.
vi.mock('@/components/ddev-rebuild-dialog', async (original) => ({
  ...(await original<typeof import('@/components/ddev-rebuild-dialog')>()),
  DdevRebuildDialog: ({
    taskId,
    onQueued,
  }: {
    taskId: string | null;
    onQueued: (notice: string, forTaskId: string) => void;
  }) =>
    taskId ? (
      <>
        <button onClick={() => onQueued('DDEV rebuild requested for this test.', taskId)}>
          Confirm test rebuild
        </button>
        <button onClick={() => onQueued('DDEV rebuild requested for this test.', 'other-task')}>
          Confirm stale rebuild
        </button>
      </>
    ) : null,
}));
vi.mock('@/lib/use-cli-login', () => ({
  useCliLogin: () => ({ requireCliLogin: () => {}, closeCliLogin: () => {}, request: null }),
}));
vi.mock('@/components/editor/editor-tab', () => ({ EditorTab: () => null }));
vi.mock('@/components/terminal/StepTerminal', () => ({ StepTerminal: () => null }));
vi.mock('@/components/terminal/BrowserVncPanel', () => ({ BrowserVncPanel: () => null }));
vi.mock('@/components/terminal/BrowserDirectPanel', () => ({ BrowserDirectPanel: () => null }));
vi.mock('@/components/terminal/DatabaseAccessPanel', () => ({ DatabaseAccessPanel: () => null }));
vi.mock('@/components/terminal/InteractiveShell', () => ({
  InteractiveShell: () => null,
  ShellUnavailable: () => null,
}));

const net = vi.hoisted(() => ({
  detail: {} as Record<string, unknown>,
  routeId: 't1',
  missing: false,
  heldDetail: null as Promise<unknown> | null,
  integrationSnapshot: { categories: [], choices: [], grants: [] } as Record<string, unknown>,
  actions: [] as Record<string, unknown>[],
  attachmentFetches: [] as string[],
  unstubbed: [] as string[],
  patchError: null as string | null,
  actionError: null as string | null,
  stopResult: { killed: 0, cancelled: 0, stopped: 0 },
}));

const PAUSED_AT = '2026-10-15T09:00:00.000Z';
const STORED_LINE = 'Paused — resume this task to continue';
const PAUSED_WAIT = 'Paused — execution is paused, so this will not start until it resumes.';

const taskRow = (over: Record<string, unknown> = {}) => ({
  id: 't1',
  userId: 'u1',
  type: 'workflow',
  title: 'Task t1',
  description: null,
  status: 'running',
  autoContinue: false,
  currentStepId: null,
  currentStepIndex: 0,
  errorMessage: null,
  startedAt: PAUSED_AT,
  completedAt: null,
  createdAt: PAUSED_AT,
  updatedAt: PAUSED_AT,
  repositoryId: null,
  cliProviderId: null,
  containerId: null,
  worktreePath: null,
  repository: null,
  voteScore: 0,
  pausedAt: PAUSED_AT,
  pausedByAdmin: false,
  pauseLocked: false,
  ...over,
});

async function fakeFetch(input: unknown, init?: { body?: string; method?: string }) {
  const path = new URL(String(input), 'http://localhost').pathname;
  if (path === '/tasks/t1/action') {
    const body = JSON.parse(init?.body ?? '{}') as Record<string, unknown>;
    net.actions.push(body);
    if (net.actionError)
      return {
        ok: false,
        status: 409,
        json: async () => ({ error: net.actionError, code: 'task_repository_deleted' }),
      };
    if (net.missing && !body.confirmMissingAttachments)
      return {
        ok: false,
        status: 409,
        json: async () => ({
          error: 'arbitrary copy',
          code: 'task_attachments_missing',
          landed: 1,
          expected: 3,
        }),
      };
    (net.detail.task as Record<string, unknown>).status = 'queued';
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, started: true, status: 'queued' }),
    };
  }
  if (path === '/tasks/t1/cancel-active-cli') {
    return { ok: true, status: 200, json: async () => net.stopResult };
  }
  if (path === '/tasks/t1' && init?.method === 'PATCH') {
    return {
      ok: !net.patchError,
      status: net.patchError ? 500 : 200,
      json: async () => (net.patchError ? { error: net.patchError } : {}),
    };
  }
  if (path === '/tasks/t1' || path === '/tasks/t2') {
    if (net.heldDetail) {
      const held = net.heldDetail;
      net.heldDetail = null;
      return held;
    }
    return { ok: true, status: 200, json: async () => structuredClone(net.detail) };
  }
  if (path === '/tasks/t1/attachments') {
    net.attachmentFetches.push(path);
    return { ok: true, status: 200, json: async () => ({ attachments: [] }) };
  }
  if (path === '/tasks/t1/integrations' || path === '/tasks/t2/integrations')
    return {
      ok: true,
      status: 200,
      json: async () => net.integrationSnapshot,
    };
  if (path === '/integrations/connections')
    return { ok: true, status: 200, json: async () => ({ connections: [] }) };
  if (path === '/integrations/categories')
    return { ok: true, status: 200, json: async () => ({ categories: [] }) };
  net.unstubbed.push(path);
  return { ok: true, status: 200, json: async () => ({ providers: [], events: [] }) };
}

const eventTarget = () => ({
  addEventListener: () => {},
  removeEventListener: () => {},
  innerHeight: 800,
  innerWidth: 1200,
  cookie: '',
});

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  vi.stubGlobal('fetch', fakeFetch);
  vi.stubGlobal('window', eventTarget());
  vi.stubGlobal('document', eventTarget());
  vi.stubGlobal('requestAnimationFrame', () => 0);
  vi.stubGlobal('cancelAnimationFrame', () => {});
});
beforeEach(() => {
  vi.clearAllTimers();
  net.patchError = null;
  net.actionError = null;
  net.routeId = 't1';
  net.heldDetail = null;
  net.integrationSnapshot = { categories: [], choices: [], grants: [] };
});
afterAll(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function mount(task: Record<string, unknown>, steps: unknown[] = []): Promise<Renderer> {
  net.detail = { task: taskRow(task), steps };
  net.unstubbed = [];
  const view = createRenderer(() => <TaskDetailPage />);
  for (let i = 0; i < 5; i += 1) await view.flush();
  return view;
}

const STEP_TITLE = 'Probe step';

const stepRow = () => ({
  id: 's1',
  taskId: 't1',
  stepId: '07-implement',
  stepIndex: 0,
  runSeq: 1,
  round: 0,
  title: STEP_TITLE,
  status: 'pending',
  detectOutput: null,
  formSchema: null,
  formValues: null,
  output: null,
  statusMessage: STORED_LINE,
  waitingStartedAt: PAUSED_AT,
  warningMessage: null,
  summary: null,
  summaryError: null,
  errorMessage: null,
  errorHint: null,
  degradedNote: null,
  contextLeftPercent: null,
  contextTokens: null,
  contextWindowSize: null,
  usageFiveHourPct: null,
  usageSevenDayPct: null,
  usageDailyPct: null,
  startedAt: null,
  endedAt: null,
  createdAt: PAUSED_AT,
  updatedAt: PAUSED_AT,
  preferredCliProviderId: null,
  preferredEffortLevel: null,
  cliInvocationCount: 0,
});

it.each([null, PAUSED_AT])(
  'counts human time only while the form awaits input (%s)',
  async (waitingStartedAt) => {
    await mount({ pausedAt: null }, [{ ...stepRow(), status: 'waiting_form', waitingStartedAt }]);
    expect(vi.mocked(useActiveTime).mock.lastCall?.[0].enabled).toBe(waitingStartedAt !== null);
  },
);

const smallest = (hosts: Host[]): Host | undefined =>
  [...hosts].sort((a, b) => textOf(a).length - textOf(b).length)[0];

const banner = (view: Renderer): string => {
  const host = smallest(
    findAll(view.tree(), (h) => h.tag === 'div' && textOf(h).includes('Any CLI run that was')),
  );
  if (!host) throw new Error('the page shows no task-scoped pause banner');
  return textOf(host);
};

/** The Actions menu rows after opening it by its trigger; a lone action has no menu, so it is the page's buttons. */
async function menuLabels(view: Renderer): Promise<string[]> {
  const trigger = buttons(view.tree(), 'actions')[0];
  if (!trigger) {
    return findAll(view.tree(), (h) => h.tag === 'button').map((h) => textOf(h).trim());
  }
  fire.click(trigger);
  await view.flush();
  const menu = findAll(view.tree(), (h) => h.props.role === 'menu')[0];
  if (!menu) throw new Error('the Actions menu did not open');
  return findAll(menu, (h) => h.props.role === 'menuitem').map((h) => textOf(h).trim());
}

const stepCardText = (view: Renderer): string[] =>
  findAll(view.tree(), (h) => h.tag === 'div' && textOf(h).includes(STEP_TITLE)).map((h) =>
    textOf(h),
  );

describe('task page: DDEV rebuild notice', () => {
  async function requested() {
    const view = await mount({ status: 'failed', pausedAt: null }, [
      {
        ...stepRow(),
        stepId: '01c-ddev-env',
        status: 'failed',
        detectOutput: { ddevConfigured: true },
      },
    ]);
    await menuLabels(view);
    const action = findAll(
      view.tree(),
      (h) => h.props.role === 'menuitem' && textOf(h).trim() === 'Rebuild DDEV',
    )[0];
    expect(action).toBeDefined();
    fire.click(action!);
    await view.flush();
    fire.click(buttons(view.tree(), /confirm test rebuild/i)[0]!);
    await view.flush();
    expect(textOf(view.tree())).toContain('DDEV rebuild requested');
    return view;
  }
  async function poll(view: Renderer) {
    vi.advanceTimersByTime(2000);
    for (let i = 0; i < 5; i++) await view.flush();
  }
  it('keeps the notice across unchanged polls and copy-only changes', async () => {
    const view = await requested();
    (net.detail.steps as Record<string, unknown>[])[0]!.statusMessage = 'unrelated display copy';
    await poll(view);
    expect(textOf(view.tree())).toContain('DDEV rebuild requested');
  });
  it.each(['task', 'step', 'route'])(
    'clears the notice on the next %s state change',
    async (kind) => {
      const view = await requested();
      if (kind === 'task') (net.detail.task as Record<string, unknown>).status = 'running';
      if (kind === 'step') (net.detail.steps as Record<string, unknown>[])[0]!.status = 'running';
      if (kind === 'route') {
        net.routeId = 't2';
        (net.detail.task as Record<string, unknown>).id = 't2';
        view.tree();
      }
      await poll(view);
      expect(textOf(view.tree())).not.toContain('DDEV rebuild requested');
    },
  );
  it('ignores a rebuild result that belongs to another task', async () => {
    const view = await mount({ status: 'failed', pausedAt: null }, [
      {
        ...stepRow(),
        stepId: '01c-ddev-env',
        status: 'failed',
        detectOutput: { ddevConfigured: true },
      },
    ]);
    await menuLabels(view);
    fire.click(
      findAll(
        view.tree(),
        (h) => h.props.role === 'menuitem' && textOf(h).trim() === 'Rebuild DDEV',
      )[0]!,
    );
    await view.flush();
    fire.click(buttons(view.tree(), /confirm stale rebuild/i)[0]!);
    await view.flush();
    expect(textOf(view.tree())).not.toContain('DDEV rebuild requested');
  });

  it('lets the user dismiss the notice', async () => {
    const view = await requested();
    const dismiss = findAll(
      view.tree(),
      (h) => h.tag === 'button' && h.props['aria-label'] === 'Dismiss DDEV rebuild notice',
    )[0];
    expect(dismiss).toBeDefined();
    fire.click(dismiss!);
    await view.flush();
    expect(textOf(view.tree())).not.toContain('DDEV rebuild requested');
    await poll(view);
    expect(textOf(view.tree())).not.toContain('DDEV rebuild requested');
  });
});

describe('task page: an administrator pause', () => {
  it('P3 owner own pause: banner says Paused by you and Press Resume, and the menu offers Resume', async () => {
    const view = await mount({ pausedByAdmin: false, pauseLocked: false });
    expect(banner(view)).toContain('Paused by you');
    expect(banner(view)).toContain('Press Resume to continue where it stopped.');
    expect(await menuLabels(view)).toContain('Resume');
  });

  it('P1 locked: banner says only an administrator can resume, and the menu has no Resume or Pause', async () => {
    const view = await mount({ pausedByAdmin: true, pauseLocked: true });
    expect(banner(view)).toContain('Paused by an administrator');
    expect(banner(view)).toContain('Only an administrator can resume it.');
    expect(banner(view)).not.toContain('Press Resume');
    const labels = await menuLabels(view);
    expect(labels).toContain('Cancel');
    expect(labels).not.toContain('Resume');
    expect(labels).not.toContain('Pause');
  });

  it('P2 unlocked admin pause (viewer is an administrator): Press Resume and a Resume row', async () => {
    const view = await mount({ pausedByAdmin: true, pauseLocked: false });
    expect(banner(view)).toContain('Paused by an administrator');
    expect(banner(view)).toContain('Press Resume to continue where it stopped.');
    expect(await menuLabels(view)).toContain('Resume');
  });

  it('P4 failed and locked: the menu has Retry and Cancel and no Resume', async () => {
    const view = await mount({
      status: 'failed',
      errorMessage: 'It broke',
      pausedByAdmin: true,
      pauseLocked: true,
    });
    const labels = await menuLabels(view);
    expect(labels).toContain('Retry');
    expect(labels).toContain('Cancel');
    expect(labels).not.toContain('Resume');
  });

  it('P5 step card: a locked pause reads the neutral line, an owner pause the stored one', async () => {
    const locked = await mount({ pausedByAdmin: true, pauseLocked: true, currentStepId: 's1' }, [
      stepRow(),
    ]);
    expect(stepCardText(locked).some((t) => t.includes(PAUSED_WAIT))).toBe(true);
    expect(stepCardText(locked).some((t) => t.includes('resume this task to continue'))).toBe(
      false,
    );

    const own = await mount({ pausedByAdmin: false, pauseLocked: false, currentStepId: 's1' }, [
      stepRow(),
    ]);
    expect(stepCardText(own).some((t) => t.includes(STORED_LINE))).toBe(true);
    expect(stepCardText(own).some((t) => t.includes(PAUSED_WAIT))).toBe(false);
  });
});

describe('task page: the Attachments tab', () => {
  const NOTE = 'This repository is imported read-only, so files cannot be attached.';
  const fileInputs = (view: Renderer) =>
    findAll(view.tree(), (h) => h.tag === 'input' && h.props.type === 'file');
  const openTab = async (task: Record<string, unknown>) => {
    const view = await mount(task);
    fire.click(buttons(view.tree(), 'attachments')[0]!);
    for (let i = 0; i < 3; i += 1) await view.flush();
    return view;
  };

  it('W1 names a read-only local repository and offers no picker', async () => {
    const view = await openTab({
      repository: { id: 'r1', name: 'Local', source: 'local_path', writable: false },
    });
    expect(textOf(view.tree())).toContain(NOTE);
    expect(fileInputs(view)).toHaveLength(0);
  });

  it.each([
    ['a writable local repository', 'local_path', true],
    ['a read-only repository that is not local', 'git_https', false],
  ])('W2 offers both pickers for %s', async (_name, source, writable) => {
    const view = await openTab({ repository: { id: 'r1', name: 'Local', source, writable } });
    expect(fileInputs(view)).toHaveLength(2);
    expect(textOf(view.tree())).not.toContain(NOTE);
  });

  it('W3 names a task with no repository and offers no picker', async () => {
    const view = await openTab({ repositoryId: null, repository: null });
    expect(textOf(view.tree())).toContain(
      'This task has no repository, so files cannot be attached.',
    );
    expect(fileInputs(view)).toHaveLength(0);
  });
});

describe('task page Stop controls (#395)', () => {
  it('offers Stop in the header and only the pending current row, at its round', async () => {
    const view = await mount({ pausedAt: null, currentStepId: '07-implement', currentRound: 1 }, [
      { ...stepRow(), id: 'old', round: 0, waitingStartedAt: null },
      { ...stepRow(), round: 1, waitingStartedAt: null },
      { ...stepRow(), id: 'future', stepId: '08-verify', round: 1, waitingStartedAt: null },
    ]);
    expect(await menuLabels(view)).toContain('Stop');
    const rows = findAll(view.tree(), (h) => !!h.props['data-step-id']);
    expect(rows.map((row) => buttons(row, 'stop').length)).toEqual([0, 1, 0]);
  });

  it.each([
    { killed: 0, cancelled: 0, stopped: 0, notice: true },
    { killed: 1, cancelled: 0, stopped: 0, notice: false },
    { killed: 0, cancelled: 1, stopped: 0, notice: false },
    { killed: 0, cancelled: 0, stopped: 1, notice: false },
  ])('shows a notice only for an empty Stop result: %j', async ({ notice, ...result }) => {
    vi.stubGlobal('confirm', () => true);
    net.stopResult = result;
    const view = await mount({ pausedAt: null }, [{ ...stepRow(), status: 'running' }]);
    const stop = buttons(view.tree(), 'stop')[0]!;
    fire.click(stop);
    for (let i = 0; i < 5; i += 1) await view.flush();
    expect(textOf(view.tree()).includes('Nothing was running to stop.')).toBe(notice);
  });

  it('shows the header Stop notice through polling and clears it on the next step Retry', async () => {
    vi.stubGlobal('confirm', () => true);
    net.stopResult = { killed: 0, cancelled: 0, stopped: 0 };
    const view = await mount({ pausedAt: null }, [{ ...stepRow(), status: 'running' }]);
    await menuLabels(view);
    const stop = findAll(
      view.tree(),
      (h) => h.props.role === 'menuitem' && textOf(h).trim() === 'Stop',
    )[0]!;
    fire.click(stop);
    for (let i = 0; i < 5; i += 1) await view.flush();
    const notices = () =>
      findAll(
        view.tree(),
        (h) => h.props.role === 'status' && textOf(h).includes('Nothing was running to stop.'),
      );
    expect(notices()).toHaveLength(1);
    expect(notices()[0]!.props.className).toContain('text-neutral-400');
    vi.advanceTimersByTime(2000);
    for (let i = 0; i < 5; i += 1) await view.flush();
    expect(notices()).toHaveLength(1);
    const row = findAll(view.tree(), (h) => h.props['data-step-id'] === 's1')[0]!;
    const retry = findAll(row, (h) => h.tag === 'button' && h.props['data-action'] === 'retry')[0]!;
    fire.click(retry);
    for (let i = 0; i < 5; i += 1) await view.flush();
    expect(notices()).toHaveLength(0);
  });
});

describe('task page: step usage stamp', () => {
  it('hides the finished attempt stamp when that row is reopened', async () => {
    const step = {
      ...stepRow(),
      status: 'done',
      endedAt: PAUSED_AT as string | null,
      contextLeftPercent: 40,
      contextTokens: 120000,
      contextWindowSize: 200000,
      usageFiveHourPct: 25,
      usageSevenDayPct: 50,
      usageDailyPct: 75,
    };
    const stamps = (view: Renderer) =>
      findAll(view.tree(), (h) => String(h.props.title).includes('when this step finished'));
    expect(stamps(await mount({ pausedAt: null }, [step]))).toHaveLength(4);
    for (const status of ['pending', 'running', 'waiting_cli', 'waiting_form']) {
      step.status = status;
      step.endedAt = null;
      expect(stamps(await mount({ pausedAt: null }, [step])), status).toHaveLength(0);
    }
  });
});

describe('task page missing attachment confirmation', () => {
  it.each([true, false])('starts only with explicit confirmation: %s', async (yes) => {
    const confirm = vi.fn(() => yes);
    vi.stubGlobal('window', { ...eventTarget(), confirm });
    net.actions = [];
    net.attachmentFetches = [];
    net.missing = true;
    const view = await mount({ status: 'created', pausedAt: null });
    fire.click(buttons(view.tree(), /^start$/)[0]!);
    await view.flush();
    expect(confirm).toHaveBeenCalledWith('2 of 3 attachments are missing. Start anyway?');
    expect(net.actions).toEqual(
      yes
        ? [{ action: 'start' }, { action: 'start', confirmMissingAttachments: true }]
        : [{ action: 'start' }],
    );
    expect((net.detail.task as Record<string, unknown>).status).toBe(yes ? 'queued' : 'created');
    expect(net.attachmentFetches).toEqual(yes ? [] : ['/tasks/t1/attachments']);
    net.missing = false;
  });
});

describe('task page auto-continue action lifecycle (#395)', () => {
  const toggle = (view: Renderer) =>
    findAll(view.tree(), (h) => h.props['data-action'] === 'auto-continue')[0]!;

  it('clears an empty Stop notice when toggling auto-continue', async () => {
    vi.stubGlobal('confirm', () => true);
    net.stopResult = { killed: 0, cancelled: 0, stopped: 0 };
    const view = await mount({ pausedAt: null, currentStepId: '07-implement' }, [
      { ...stepRow(), status: 'running' },
    ]);
    await menuLabels(view);
    fire.click(
      findAll(view.tree(), (h) => h.props.role === 'menuitem' && textOf(h).trim() === 'Stop')[0]!,
    );
    for (let i = 0; i < 5; i += 1) await view.flush();
    expect(findAll(view.tree(), (h) => h.props.role === 'status')).toHaveLength(1);
    fire.check(toggle(view), true);
    for (let i = 0; i < 5; i += 1) await view.flush();
    expect(findAll(view.tree(), (h) => h.props.role === 'status')).toHaveLength(0);
  });

  it('clears an earlier toggle error on the next toggle', async () => {
    const view = await mount({ pausedAt: null, currentStepId: '07-implement' }, [
      { ...stepRow(), status: 'running' },
    ]);
    net.patchError = 'toggle failed probe';
    fire.check(toggle(view), true);
    for (let i = 0; i < 5; i += 1) await view.flush();
    expect(textOf(view.tree())).toContain('toggle failed probe');
    net.patchError = null;
    fire.check(toggle(view), true);
    for (let i = 0; i < 5; i += 1) await view.flush();
    expect(textOf(view.tree())).not.toContain('toggle failed probe');
  });
});

describe('task Integrations entry point', () => {
  it('opens account controls from the actual task page', async () => {
    const view = await mount({});
    const tab = buttons(view.tree(), 'integrations')[0];
    expect(tab, 'task page must expose its Integrations tab').toBeDefined();
    fire.click(tab!);
    await view.flush();
    expect(textOf(view.tree())).toContain('next dispatch');
  });
});

it('keeps task integrations read-only when an older running poll finishes after a completed poll', async () => {
  net.integrationSnapshot = {
    categories: [
      {
        categoryId: 'forge',
        status: 'resolved',
        providerId: 'github',
        connectionId: 'a',
        source: 'task',
        candidates: ['a'],
        skipped: [],
      },
    ],
    choices: [{ categoryId: 'forge', providerId: 'github', connectionId: 'a' }],
    grants: [],
  };
  const view = await mount({});
  fire.click(buttons(view.tree(), 'integrations')[0]!);
  for (let i = 0; i < 5; i++) await view.flush();
  const save = () => buttons(view.tree(), 'save forge override')[0]!;
  expect(save().props.disabled).toBe(false);
  const stale = structuredClone(net.detail);
  let finish!: (value: unknown) => void;
  net.heldDetail = new Promise((resolve) => {
    finish = resolve;
  });
  vi.advanceTimersByTime(2000);
  (net.detail.task as Record<string, unknown>).status = 'completed';
  vi.advanceTimersByTime(2000);
  await view.flush();
  expect(save().props.disabled).toBe(true);
  finish({ ok: true, status: 200, json: async () => stale });
  await view.flush();
  expect(save().props.disabled).toBe(true);
});

it('does not restore another route’s task after its late detail reply', async () => {
  const view = await mount({ title: 'Old route task' });
  const stale = structuredClone(net.detail);
  let finish!: (value: unknown) => void;
  net.heldDetail = new Promise((resolve) => {
    finish = resolve;
  });
  vi.advanceTimersByTime(2000);
  net.routeId = 't2';
  net.detail = { task: taskRow({ id: 't2', title: 'Current route task' }), steps: [] };
  view.draw();
  await view.flush();
  expect(textOf(view.tree())).toContain('Current route task');
  finish({ ok: true, status: 200, json: async () => stale });
  await view.flush();
  expect(textOf(view.tree())).toContain('Current route task');
  expect(textOf(view.tree())).not.toContain('Old route task');
});

it('accepts a slow task poll while a newer poll is still pending', async () => {
  const view = await mount({});
  let first!: (value: unknown) => void;
  let second!: (value: unknown) => void;
  net.heldDetail = new Promise((resolve) => {
    first = resolve;
  });
  vi.advanceTimersByTime(2000);
  net.heldDetail = new Promise((resolve) => {
    second = resolve;
  });
  vi.advanceTimersByTime(2000);
  const updated = { task: taskRow({ title: 'Accepted slow response' }), steps: [] };
  first({ ok: true, status: 200, json: async () => updated });
  await view.flush();
  expect(textOf(view.tree())).toContain('Accepted slow response');
  second({ ok: true, status: 200, json: async () => updated });
  await view.flush();
});

it('shows the API explanation when Retry refuses a deleted repository', async () => {
  const sentence = 'The repository of this task was deleted; it cannot be retried.';
  net.actionError = sentence;
  const view = await mount({ status: 'failed', pausedAt: null });
  await menuLabels(view);
  const retry =
    findAll(view.tree(), (h) => h.props.role === 'menuitem' && textOf(h).trim() === 'Retry')[0] ??
    buttons(view.tree(), /^retry$/i)[0];
  expect(retry).toBeDefined();
  fire.click(retry!);
  await view.flush();
  expect(textOf(view.tree())).toContain(sentence);
});

describe('task page: round labels', () => {
  it('labels revalidation distinctly without shifting real fix-loop numbering', async () => {
    const steps = [
      { ...stepRow(), id: 'r0', stepId: '07-phase-2-implement', round: 0, status: 'done' },
      { ...stepRow(), id: 'r1', stepId: '07c-ddev-reconcile', round: 1, status: 'done' },
      { ...stepRow(), id: 'r2', stepId: '07-phase-2-implement', round: 2, status: 'done' },
      { ...stepRow(), id: 'r3', stepId: '07b-phase-4-validate', round: 3, status: 'done' },
      { ...stepRow(), id: 'r4', stepId: '07-phase-2-implement', round: 4, status: 'running' },
    ];
    const view = await mount({ currentStepId: '07-phase-2-implement', currentRound: 4 }, steps);
    const text = textOf(view.tree());
    expect(text).toContain('Revalidation #1');
    expect(text).toContain('Revalidation #2');
    expect(text).toContain('Fix loop #1');
    expect(text).toContain('Fix loop #2');
    expect(text).not.toContain('Fix loop #3');
  });
});

describe('saved mining reply recovery', () => {
  it.each([null, [{ id: 'generator', label: 'Generator' }]])(
    'keeps loop recovery copy with roles %j when a fan-out loop has saved replies',
    async (cliRoles) => {
      const confirmResume = vi.fn(() => false);
      vi.stubGlobal('confirm', confirmResume);
      const view = await mount(
        { status: 'failed', pausedAt: null, currentStepId: '09_5-skill-generation' },
        [
          {
            ...stepRow(),
            stepId: '09_5-skill-generation',
            status: 'failed',
            cliRoles,
            iterationCount: 2,
            agentCounts: { done: 2, failed: 0, inFlight: 0 },
          },
        ],
      );
      const resume = buttons(view.tree(), 'resume (keep 2 passes)');
      expect(resume).toHaveLength(1);
      expect(buttons(view.tree(), 'resume (apply saved replies)')).toHaveLength(0);
      fire.click(resume[0]!);
      expect(confirmResume).toHaveBeenCalledWith(
        'Resume this step from the last completed pass (2 kept) with the currently-selected CLI?',
      );
    },
  );

  it('offers Resume for a failed apply with only done agents', async () => {
    const view = await mount({ status: 'failed', pausedAt: null, currentStepId: '07-implement' }, [
      {
        ...stepRow(),
        status: 'failed',
        iterationCount: 0,
        agentCounts: { done: 2, failed: 0, inFlight: 0 },
      },
    ]);
    expect(buttons(view.tree(), 'resume (apply saved replies)')).toHaveLength(1);
  });

  it.each([
    { status: 'done', done: 2, inFlight: 0 },
    { status: 'failed', done: 0, inFlight: 0 },
    { status: 'failed', done: 2, inFlight: 1 },
  ])('hides saved-reply Resume for %j regardless of stale error copy', async (state) => {
    const view = await mount({ status: 'failed', pausedAt: null, currentStepId: '07-implement' }, [
      {
        ...stepRow(),
        status: state.status,
        iterationCount: 0,
        errorMessage: 'Apply failed after all replies were saved',
        agentCounts: { done: state.done, failed: 0, inFlight: state.inFlight },
      },
    ]);
    expect(buttons(view.tree(), 'resume (apply saved replies)')).toHaveLength(0);
  });
});
