import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import MaintenancePage from './page';
import {
  createRenderer,
  findAll,
  fire,
  textOf,
  type Renderer,
} from '../../../../../test/render-tree';

// No DOM in this package: the page runs through test/render-tree.ts, and the network is a stub of fetch.
vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  ...(await import('../../../../../test/render-tree')).reactHooks,
}));
vi.mock('@/lib/use-page-title', () => ({ usePageTitle: () => {} }));
vi.mock('@/components/dialog', () => ({
  Dialog: () => null,
  DialogContent: () => null,
  DialogHeader: () => null,
  DialogTitle: () => null,
}));

const reply = (code: number, body: unknown) => ({
  ok: code < 400,
  status: code,
  json: async () => structuredClone(body),
});

let state = 'normal';
let holdState: { settle?: () => void } | null = null;
let runs: Array<Record<string, unknown>> = [];
let blockingTasks: Array<Record<string, unknown>> = [];
let parkedTasks: Array<Record<string, unknown>> = [];
let parkedCapped = false;
let predatesParked = false;
let actions: string[] = [];

const upgradeRun = (status: string) => ({
  id: '11111111-2222-4333-8444-555555555555',
  from_version: '8.8.8',
  to_version: '9.9.9',
  phase: 'migrating',
  status,
  error: null,
  started_at: '2026-10-01T10:00:00.000Z',
  ended_at: status === 'running' ? null : '2026-10-01T10:05:00.000Z',
});
const occurrences = (text: string, part: string) => text.split(part).length - 1;
const reasonNote = (view: Renderer) =>
  findAll(
    view.tree(),
    (h) => h.tag === 'p' && textOf(h).includes('9.9.9') && textOf(h).includes('migrating'),
  );

async function fakeFetch(input: unknown, init?: { method?: string; body?: string }) {
  const call = `${init?.method ?? 'GET'} ${new URL(String(input), 'http://localhost').pathname}`;
  if (call === 'GET /admin/maintenance') {
    const snapshot = state;
    const held = holdState?.settle ? null : holdState;
    if (held) {
      return new Promise((resolve) => {
        held.settle = () => resolve(reply(200, { state: snapshot }));
      });
    }
    return reply(200, { state: snapshot });
  }
  if (call === 'PUT /admin/maintenance') {
    const previous = state;
    state = (JSON.parse(init?.body ?? '{}') as { state: string }).state;
    return reply(200, { state, previous });
  }
  if (call === 'GET /admin/maintenance/blocking') {
    return reply(200, {
      tasks: structuredClone(blockingTasks),
      jobs: [],
      total: blockingTasks.length,
      capped: false,
      ...(predatesParked ? {} : { parked: structuredClone(parkedTasks), parkedCapped }),
      viewerId: 'u1',
    });
  }
  if (call.startsWith('POST /admin/maintenance/tasks/') && call.endsWith('/action')) {
    actions.push(`${call} ${init?.body}`);
    return reply(200, { ok: true });
  }
  if (call === 'GET /admin/maintenance/upgrade') {
    return reply(200, {
      version: '1.0.0',
      canUpgrade: false,
      devBuild: true,
      installDirConfigured: false,
      runs: structuredClone(runs),
    });
  }
  return reply(404, { error: `not stubbed: ${call}` });
}

beforeAll(() => vi.stubGlobal('fetch', fakeFetch));
afterAll(() => vi.unstubAllGlobals());
beforeEach(() => {
  state = 'normal';
  holdState = null;
  runs = [];
  blockingTasks = [];
  parkedTasks = [];
  parkedCapped = false;
  predatesParked = false;
  actions = [];
});
afterEach(() => vi.useRealTimers());

async function mount(): Promise<Renderer> {
  const view = createRenderer(() => <MaintenancePage />);
  for (let i = 0; i < 3; i += 1) await view.flush();
  return view;
}

const stateButton = (view: Renderer, label: string) =>
  findAll(view.tree(), (h) => h.tag === 'button' && textOf(h).startsWith(label))[0]!;

describe('maintenance page state', () => {
  it('keeps the state it set when an older poll read answers after its own re-read', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const view = await mount();
    expect(stateButton(view, 'Normal').props.disabled).toBe(true);
    holdState = {};
    vi.advanceTimersByTime(5000);
    await view.flush();
    expect(holdState.settle).toBeDefined();
    fire.click(stateButton(view, 'Draining'));
    for (let i = 0; i < 3; i += 1) await view.flush();
    expect(state).toBe('draining');
    expect(stateButton(view, 'Draining').props.disabled).toBe(true);
    expect(stateButton(view, 'Normal').props.disabled).toBe(false);
    holdState.settle!();
    for (let i = 0; i < 3; i += 1) await view.flush();
    expect(stateButton(view, 'Draining').props.disabled).toBe(true);
    expect(stateButton(view, 'Normal').props.disabled).toBe(false);
  });
});

describe('maintenance page while an upgrade run is live', () => {
  const LABELS = ['Normal', 'Draining', 'Maintenance'];

  it('disables all three state buttons and names the run as the reason', async () => {
    runs = [upgradeRun('running')];
    state = 'draining';
    const view = await mount();

    expect(LABELS.map((label) => stateButton(view, label).props.disabled)).toEqual([
      true,
      true,
      true,
    ]);
    const text = textOf(view.tree());
    expect(occurrences(text, '9.9.9')).toBeGreaterThanOrEqual(2);
    expect(occurrences(text, 'migrating')).toBeGreaterThanOrEqual(2);
    expect(reasonNote(view)).toHaveLength(1);
  });

  it('leaves the other states selectable and shows no reason when only finished runs exist', async () => {
    runs = [upgradeRun('done'), upgradeRun('rolled_back'), upgradeRun('failed')];
    const view = await mount();

    expect(LABELS.map((label) => stateButton(view, label).props.disabled)).toEqual([
      true,
      false,
      false,
    ]);
    expect(occurrences(textOf(view.tree()), '9.9.9')).toBe(3);
    expect(reasonNote(view)).toHaveLength(0);
  });

  it('enables the buttons again when a later poll reports the run finished', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    runs = [upgradeRun('running')];
    const view = await mount();
    expect(stateButton(view, 'Draining').props.disabled).toBe(true);

    runs = [upgradeRun('done')];
    vi.advanceTimersByTime(5000);
    for (let i = 0; i < 3; i += 1) await view.flush();

    expect(stateButton(view, 'Draining').props.disabled).toBe(false);
    expect(stateButton(view, 'Maintenance').props.disabled).toBe(false);
    expect(occurrences(textOf(view.tree()), '9.9.9')).toBe(1);
    expect(reasonNote(view)).toHaveLength(0);
  });
});

describe('maintenance page task pause controls', () => {
  const blockingTask = (over: Record<string, unknown>) => ({
    id: 'task-1',
    title: 'A task',
    type: 'workflow',
    status: 'running',
    pausedAt: null,
    pausedByAdmin: false,
    currentStepId: null,
    updatedAt: '2026-10-01T10:00:00.000Z',
    ownerId: 'u2',
    ownerName: 'Owner',
    ownerEmail: null,
    hasLiveCli: false,
    ...over,
  });
  const buttons = (view: Renderer) =>
    findAll(view.tree(), (h) => h.tag === 'button')
      .map((b) => textOf(b))
      .filter((t) => ['Pause', 'Resume', 'Take over pause'].includes(t));

  it('offers only Pause for a task nobody paused', async () => {
    blockingTasks = [blockingTask({})];
    const view = await mount();

    expect(buttons(view)).toEqual(['Pause']);
    expect(textOf(view.tree())).not.toContain('paused by');
  });

  it('marks an owner pause and offers Resume beside Take over pause', async () => {
    blockingTasks = [blockingTask({ pausedAt: '2026-10-01T09:00:00.000Z' })];
    const view = await mount();

    expect(textOf(view.tree())).toContain('paused by owner');
    expect(buttons(view)).toEqual(['Resume', 'Take over pause']);
  });

  it('marks an administrator pause and offers Resume only', async () => {
    blockingTasks = [blockingTask({ pausedAt: '2026-10-01T09:00:00.000Z', pausedByAdmin: true })];
    const view = await mount();

    expect(textOf(view.tree())).toContain('paused by admin');
    expect(buttons(view)).toEqual(['Resume']);
  });

  it('posts the pause action when Take over pause is clicked', async () => {
    blockingTasks = [blockingTask({ pausedAt: '2026-10-01T09:00:00.000Z' })];
    const view = await mount();
    const takeOver = findAll(
      view.tree(),
      (h) => h.tag === 'button' && textOf(h) === 'Take over pause',
    )[0]!;

    fire.click(takeOver);
    for (let i = 0; i < 3; i += 1) await view.flush();

    expect(actions).toEqual(['POST /admin/maintenance/tasks/task-1/action {"action":"pause"}']);
  });
});

describe('maintenance page parked list', () => {
  const parkedTask = (over: Record<string, unknown>) => ({
    id: 'parked-1',
    title: 'A parked task',
    type: 'workflow',
    status: 'waiting_user',
    pausedAt: null,
    pausedByAdmin: false,
    currentStepId: null,
    updatedAt: '2026-10-01T10:00:00.000Z',
    ownerId: 'u2',
    ownerName: 'Owner',
    ownerEmail: null,
    hasLiveCli: false,
    ...over,
  });
  const buttons = (view: Renderer) =>
    findAll(view.tree(), (h) => h.tag === 'button')
      .map((b) => textOf(b))
      .filter((t) => ['Pause', 'Resume', 'Take over pause'].includes(t));
  const headings = (view: Renderer) =>
    findAll(view.tree(), (h) => h.tag === 'h3').map((h) => textOf(h));

  it('renders the blocking list when the api sends no parked field', async () => {
    predatesParked = true;
    blockingTasks = [parkedTask({ title: 'Still running', status: 'running' })];
    const view = await mount();

    expect(textOf(view.tree())).toContain('Still running');
    expect(headings(view)).not.toContain('Parked');
  });

  it('shows no Parked heading when nothing is parked', async () => {
    const view = await mount();

    expect(headings(view)).not.toContain('Parked');
  });

  it('lists parked rows under a Parked heading with the actions each state needs', async () => {
    parkedTasks = [
      parkedTask({ id: 'p-none' }),
      parkedTask({ id: 'p-owner', pausedAt: '2026-10-01T09:00:00.000Z' }),
      parkedTask({ id: 'p-admin', pausedAt: '2026-10-01T09:00:00.000Z', pausedByAdmin: true }),
    ];
    const view = await mount();

    expect(headings(view)).toContain('Parked');
    expect(buttons(view)).toEqual(['Pause', 'Resume', 'Take over pause', 'Resume']);
  });

  it('posts a parked row action to the task action route', async () => {
    parkedTasks = [parkedTask({ pausedAt: '2026-10-01T09:00:00.000Z', pausedByAdmin: true })];
    const view = await mount();
    const resume = findAll(view.tree(), (h) => h.tag === 'button' && textOf(h) === 'Resume')[0]!;

    fire.click(resume);
    for (let i = 0; i < 3; i += 1) await view.flush();

    expect(actions).toEqual(['POST /admin/maintenance/tasks/parked-1/action {"action":"resume"}']);
  });

  it('still says nothing is running when only parked rows exist', async () => {
    parkedTasks = [parkedTask({})];
    const view = await mount();

    expect(textOf(view.tree())).toContain('Nothing is running. It is safe to upgrade.');
  });

  it('says so when the parked list is capped', async () => {
    parkedTasks = [parkedTask({})];
    parkedCapped = true;
    const view = await mount();

    expect(textOf(view.tree())).toContain('Showing the first 1 parked tasks. There are more.');
  });
});
