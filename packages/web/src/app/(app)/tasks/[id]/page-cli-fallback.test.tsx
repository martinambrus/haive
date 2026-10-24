import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import TaskDetailPage from './page';
import {
  buttons,
  createRenderer,
  findAll,
  fire,
  textOf,
  type Renderer,
} from '../../../../../test/render-tree';

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
  providers: null as unknown[] | null,
  defaultProviderId: null as string | null,
}));

const NOW = '2026-10-15T09:00:00.000Z';
const NONE_PLAIN = '(none — use the default)';
const NONE_NAMED = '(none — use the default: Claude)';
const USAGE_TITLE = 'subscription usage';

const providerRow = (id: string, name: string, label: string) => ({
  id,
  name,
  label,
  enabled: true,
  effortScale: null,
  createdAt: NOW,
});

const snapshot = (providerId: string, providerName: string) => ({
  providerId,
  providerName,
  fiveHour: { usedPct: 40, resetsAt: null },
  fetchedAt: NOW,
  stale: false,
  status: 'ok',
});

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
  startedAt: NOW,
  completedAt: null,
  createdAt: NOW,
  updatedAt: NOW,
  repositoryId: null,
  cliProviderId: null,
  containerId: null,
  worktreePath: null,
  repository: null,
  voteScore: 0,
  pausedAt: null,
  pausedByAdmin: false,
  pauseLocked: false,
  ...over,
});

const upcoming = {
  stepId: '07-implement',
  title: 'Probe upcoming step',
  preferredCliProviderId: null,
  preferredEffortLevel: null,
};

const stepRow = () => ({
  id: 's1',
  taskId: 't1',
  stepId: '07-implement',
  stepIndex: 0,
  runSeq: 1,
  round: 0,
  title: 'Probe step',
  status: 'waiting_form',
  usesCli: true,
  detectOutput: null,
  formSchema: null,
  formValues: null,
  output: null,
  statusMessage: null,
  waitingStartedAt: NOW,
  createdAt: NOW,
  updatedAt: NOW,
  preferredCliProviderId: null,
  preferredEffortLevel: null,
  cliInvocationCount: 0,
});

async function fakeFetch(input: unknown) {
  const path = new URL(String(input), 'http://localhost').pathname;
  const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
  if (path === '/tasks/t1') return json(structuredClone(net.detail));
  if (path === '/cli-providers') {
    return json({
      defaultProviderId: net.defaultProviderId,
      providers: net.providers ?? [
        providerRow('p-claude', 'claude-code', 'Claude'),
        providerRow('p-codex', 'codex', 'Codex'),
      ],
    });
  }
  if (path === '/usage-window') {
    return json({ snapshots: [snapshot('p-claude', 'claude-code'), snapshot('p-codex', 'codex')] });
  }
  return json({ providers: [], events: [] });
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
  net.detail = { task: taskRow(task), steps, upcomingCliSteps: [upcoming] };
  const view = createRenderer(() => <TaskDetailPage />);
  for (let i = 0; i < 8; i += 1) await view.flush();
  return view;
}

async function cliTab(view: Renderer): Promise<void> {
  const tab = buttons(view.tree(), 'clis')[0];
  if (!tab) throw new Error('the page has no CLIs tab');
  fire.click(tab);
  await view.flush();
}

const upcomingPickerNone = (view: Renderer): string[] => {
  const select = findAll(
    view.tree(),
    (h) => h.tag === 'select' && h.props.id === 'upcoming-cli-07-implement',
  )[0];
  if (!select) throw new Error('the CLIs tab shows no picker for the upcoming step');
  return findAll(select, (h) => h.tag === 'option' && h.props.value === '').map((h) => textOf(h));
};

const usageTitles = (view: Renderer): string[] =>
  findAll(
    view.tree(),
    (h) => typeof h.props.title === 'string' && h.props.title.includes(USAGE_TITLE),
  ).map((h) => String(h.props.title));

describe('task page: a task with no CLI of its own runs on the default provider', () => {
  it('CLIs tab: a none task whose effective provider is Claude names it in the empty option', async () => {
    const view = await mount({ cliProviderId: null, effectiveCliProviderId: 'p-claude' });
    await cliTab(view);
    expect(upcomingPickerNone(view)).toContain(NONE_NAMED);
  });

  it('CLIs tab GUARD: an old api that omits the field keeps the generic text', async () => {
    const view = await mount({ cliProviderId: null });
    await cliTab(view);
    expect(upcomingPickerNone(view)).toContain(NONE_PLAIN);
  });

  it('CLIs tab GUARD: a task with its own CLI names that CLI as before', async () => {
    const view = await mount({ cliProviderId: 'p-codex', effectiveCliProviderId: 'p-codex' });
    await cliTab(view);
    const select = findAll(
      view.tree(),
      (h) => h.tag === 'select' && h.props.id === 'upcoming-cli-07-implement',
    )[0];
    expect(select?.props.value).toBe('p-codex');
  });

  it('header chip: a none task shows the effective provider usage window', async () => {
    const view = await mount({ cliProviderId: null, effectiveCliProviderId: 'p-claude' });
    const titles = usageTitles(view);
    expect(titles.length).toBeGreaterThan(0);
    expect(titles.every((t) => t.startsWith('Claude'))).toBe(true);
  });

  it('header chip GUARD: an old api that omits the field shows no chip for a none task', async () => {
    const view = await mount({ cliProviderId: null });
    expect(usageTitles(view)).toEqual([]);
  });

  it('header chip GUARD: a task with its own CLI shows that CLI usage window', async () => {
    const view = await mount({ cliProviderId: 'p-codex', effectiveCliProviderId: 'p-codex' });
    const titles = usageTitles(view);
    expect(titles.length).toBeGreaterThan(0);
    expect(titles.every((t) => t.startsWith('Codex'))).toBe(true);
  });

  it('step card: a none task whose effective provider is Claude names it in the empty option', async () => {
    const view = await mount(
      { cliProviderId: null, effectiveCliProviderId: 'p-claude', currentStepId: 's1' },
      [stepRow()],
    );
    const select = findAll(
      view.tree(),
      (h) => h.tag === 'select' && h.props.id === 'cli-07-implement',
    )[0];
    if (!select) throw new Error('the step card shows no CLI picker');
    const texts = findAll(select, (h) => h.tag === 'option' && h.props.value === '').map((h) =>
      textOf(h),
    );
    expect(texts).toContain(NONE_NAMED);
  });

  it('step card GUARD: an old api that omits the field keeps the generic text', async () => {
    const view = await mount({ cliProviderId: null, currentStepId: 's1' }, [stepRow()]);
    const select = findAll(
      view.tree(),
      (h) => h.tag === 'select' && h.props.id === 'cli-07-implement',
    )[0];
    if (!select) throw new Error('the step card shows no CLI picker');
    const texts = findAll(select, (h) => h.tag === 'option' && h.props.value === '').map((h) =>
      textOf(h),
    );
    expect(texts).toContain(NONE_PLAIN);
  });
});

describe('terminal provider preselect', () => {
  it.each([
    [
      'newest inserted last',
      [
        { id: 'new', enabled: true, createdAt: '2026-10-20T00:00:00.000Z' },
        { id: 'old', enabled: true, createdAt: '2026-10-01T00:00:00.000Z' },
      ],
      'old',
    ],
    [
      'createdAt tie',
      [
        { id: 'z', enabled: true, createdAt: NOW },
        { id: 'a', enabled: true, createdAt: NOW },
      ],
      'a',
    ],
    [
      'disabled oldest',
      [
        { id: 'disabled', enabled: false, createdAt: '2026-09-01T00:00:00.000Z' },
        { id: 'new', enabled: true, createdAt: '2026-10-20T00:00:00.000Z' },
        { id: 'old', enabled: true, createdAt: '2026-10-01T00:00:00.000Z' },
      ],
      'old',
    ],
    ['no enabled provider', [{ id: 'disabled', enabled: false, createdAt: NOW }], null],
    ['no configured provider', [], null],
  ])('uses the server default: %s', async (_name, providers, expected) => {
    net.providers = providers.map((p) => ({ ...providerRow(p.id, 'codex', p.id), ...p }));
    net.defaultProviderId = expected;
    try {
      const view = await mount({ cliProviderId: null, type: 'onboarding' });
      fire.click(buttons(view.tree(), 'terminal')[0]!);
      await view.flush();
      const select = findAll(view.tree(), (h) => h.tag === 'select' && h.props.value === expected);
      if (expected) expect(select).toHaveLength(1);
      else {
        expect(
          findAll(view.tree(), (h) => h.tag === 'select' && h.props.value === 'disabled'),
        ).toHaveLength(0);
        expect(textOf(view.tree())).toContain(
          providers.length > 0 ? 'Every CLI provider is disabled.' : 'No CLI providers configured.',
        );
      }
    } finally {
      net.providers = null;
      net.defaultProviderId = null;
    }
  });
});

it('keeps a disabled CLI already bound to the task in its terminal', async () => {
  net.providers = [
    { ...providerRow('disabled', 'codex', 'Disabled'), enabled: false },
    providerRow('enabled', 'codex', 'Enabled'),
  ];
  net.defaultProviderId = 'enabled';
  try {
    const view = await mount({ type: 'onboarding', cliProviderId: 'disabled' });
    fire.click(buttons(view.tree(), 'terminal')[0]!);
    await view.flush();
    const select = findAll(
      view.tree(),
      (h) => h.tag === 'select' && h.props.value === 'disabled',
    )[0];
    expect(select).toBeDefined();
    expect(
      findAll(select!, (h) => h.tag === 'option' && h.props.value === 'disabled'),
    ).toHaveLength(1);
  } finally {
    net.providers = null;
    net.defaultProviderId = null;
  }
});
