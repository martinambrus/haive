import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import TaskDetailPage from './page';
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
vi.mock('next/navigation', () => ({
  useParams: () => ({ id: 't1' }),
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
  unstubbed: [] as string[],
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

async function fakeFetch(input: unknown) {
  const path = new URL(String(input), 'http://localhost').pathname;
  if (path === '/tasks/t1/cancel-active-cli') {
    return { ok: true, status: 200, json: async () => net.stopResult };
  }
  if (path === '/tasks/t1') {
    return { ok: true, status: 200, json: async () => structuredClone(net.detail) };
  }
  if (path === '/tasks/t1/attachments') {
    return { ok: true, status: 200, json: async () => ({ attachments: [] }) };
  }
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

  it('shows the header Stop notice through polling and clears it on the next successful Stop', async () => {
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
    net.stopResult = { killed: 0, cancelled: 0, stopped: 1 };
    fire.click(buttons(view.tree(), 'stop')[0]!);
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
