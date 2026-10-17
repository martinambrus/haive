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
    return reply(200, { tasks: [], jobs: [], total: 0, capped: false, viewerId: 'u1' });
  }
  if (call === 'GET /admin/maintenance/upgrade') {
    return reply(200, {
      version: '1.0.0',
      canUpgrade: false,
      devBuild: true,
      installDirConfigured: false,
      runs: [],
    });
  }
  return reply(404, { error: `not stubbed: ${call}` });
}

beforeAll(() => vi.stubGlobal('fetch', fakeFetch));
afterAll(() => vi.unstubAllGlobals());
beforeEach(() => {
  state = 'normal';
  holdState = null;
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
