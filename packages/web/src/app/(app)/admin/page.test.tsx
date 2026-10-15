import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import AdminPage from './page';
import {
  buttons,
  createRenderer,
  findAll,
  fire,
  textOf,
  type Host,
  type Renderer,
} from '../../../../test/render-tree';

// No DOM in this package: the page runs through test/render-tree.ts, and the network is a stub of fetch.
vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  ...(await import('../../../../test/render-tree')).reactHooks,
}));
const nav = vi.hoisted(() => ({ search: '' }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({
    replace: (url: string) => {
      nav.search = url.includes('?') ? url.slice(url.indexOf('?')) : '';
    },
  }),
  useSearchParams: () => new URLSearchParams(nav.search),
}));
vi.mock('next/link', async () => {
  const { createElement } = await import('react');
  return {
    default: ({ href, children }: { href: string; children?: unknown }) =>
      createElement('a', { href }, children as never),
  };
});
vi.mock('@/lib/use-page-title', () => ({ usePageTitle: () => {} }));

const CUSTOM_TOOLS_PATH = '/admin/config/custom-tools';
const CUSTOM_TOOLS_CARD = /custom\s+(mcp\s+)?tools?/i;
const on = { enabled: true };

const GETS: Record<string, unknown> = {
  '/admin/health': {
    users: { total: 1, active: 1, deactivated: 0, admins: 1 },
    tasks: {},
    containers: {},
    recentFailures: [],
    timestamp: '2026-10-15T09:00:00.000Z',
  },
  '/admin/config/concurrency': { maxParallelAgents: 0 },
  '/admin/config/steering': on,
  '/admin/config/codex-app-server': { enabled: true, recentFailures: [] },
  '/admin/config/agent-isolation': on,
  '/admin/config/cli-soft-timeout': { enabled: true, percent: 80 },
  '/admin/config/cli-timeout-ladder': { baseMinutes: 30, ladder: '30,60', rungs: [30, 60] },
  '/admin/config/ide': on,
  '/admin/config/plan-canvas': on,
  '/admin/config/task-types': { customEnabled: false, moduleEnabled: false },
  '/admin/config/registration-mode': { mode: 'open' },
  '/admin/config/debug-mode': on,
  '/admin/config/browser-access': on,
  '/admin/config/db-access': on,
  '/admin/config/ddev-registry-cache': on,
  '/admin/config/allowance-watch': { mode: 'notify' },
  '/admin/config/ddev-control': on,
  '/admin/config/fair-scheduling': on,
  '/admin/config/model-identity-strict': on,
  '/admin/config/max-agents-per-task': { maxAgentsPerTask: 4 },
  '/admin/config/attachment-max-bytes': { maxBytes: 10_485_760 },
  '/admin/config/prompt-caching-1h': on,
  '/admin/config/cli-pricing': {
    autoUpdateEnabled: true,
    displayCurrency: 'USD',
    currencies: ['USD', 'EUR'],
  },
  '/admin/config/terseness': { level: 'off' },
  '/admin/config/spec-view': { mode: 'rendered' },
  '/admin/config/step-guidance': on,
  '/admin/config/review-refute': { enabled: true, lenses: 3 },
  '/admin/config/qa-verify': { enabled: true, lenses: 3 },
  '/admin/config/usage-window': on,
  '/admin/config/usage-alert': { enabled: true, thresholdPct: 10 },
  '/admin/config/pr-workflow': on,
  '/admin/config/runtime-limits': {
    enabled: true,
    memoryMb: 0,
    cpus: 0,
    maxConcurrent: 0,
    idleReapMinutes: 180,
    ddevWeightMb: 0,
    appWeightMb: 0,
    agentWeightMb: 0,
    browserWeightMb: 0,
    agentFloor: 0,
    agentPoolMeasuredEnabled: true,
    agentPoolSafetyMb: 0,
    agentReserveEnabled: true,
    agentReserveMaxHoldMinutes: 3,
    agentPreemptionEnabled: true,
    agentPreemptionMinRunMinutes: 5,
    runtimePreemptionEnabled: true,
    runtimePreemptionMaxWaitMinutes: 10,
    capacity: {
      budgetMb: 8192,
      ddevWeightMb: 1024,
      appWeightMb: 512,
      agentWeightMb: 512,
      browserWeightMb: 512,
      concurrentDdev: 8,
      concurrentDdevWithBrowser: 5,
      concurrentApp: 16,
      agentsIdle: 16,
      agentSafetyMb: 512,
      agentsMeasured: null,
    },
  },
  '/admin/config/cli-stream-log-retention': { retentionDays: 0 },
  '/admin/config/cli-prompt-retention': { retentionDays: 0 },
  '/admin/config/chrome-mcp-timeout': { timeoutMs: 0 },
  '/admin/config/rag-embedding': {
    embedTimeoutMs: 60_000,
    queryTimeoutMs: 10_000,
    warmupTimeoutMs: 120_000,
    batchSize: 16,
    strictEnabled: false,
  },
  '/admin/config/agent-rules-injection': on,
  '/admin/config/house-rules': on,
  '/admin/config/cli-retention-usage': {
    invocations: 0,
    withStreamLog: 0,
    withPrompt: 0,
    streamLogBytes: 0,
    promptBytes: 0,
    withDispatchPrompt: 0,
    dispatchPromptBytes: 0,
  },
};

const net = vi.hoisted(() => ({
  gets: {} as Record<string, unknown>,
  calls: [] as Array<{ method: string; path: string; body: unknown }>,
  unstubbed: [] as string[],
}));

const reply = (status: number, body: unknown) => ({
  ok: status < 400,
  status,
  json: async () => structuredClone(body),
});

async function fakeFetch(input: unknown, init?: { method?: string; body?: string }) {
  const path = new URL(String(input), 'http://localhost').pathname;
  const method = init?.method ?? 'GET';
  const body: unknown = init?.body === undefined ? undefined : JSON.parse(init.body);
  net.calls.push({ method, path, body });
  if (method === 'GET' && path in net.gets) return reply(200, net.gets[path]);
  if (method === 'PUT' && path.startsWith('/admin/config/')) return reply(200, body);
  net.unstubbed.push(`${method} ${path}`);
  return reply(404, { error: `not stubbed: ${method} ${path}` });
}

beforeAll(() => vi.stubGlobal('fetch', fakeFetch));
afterAll(() => vi.unstubAllGlobals());
beforeEach(() => {
  nav.search = '';
  net.calls = [];
  net.unstubbed = [];
});

async function mount(customTools: unknown): Promise<Renderer> {
  net.gets = { ...GETS, [CUSTOM_TOOLS_PATH]: customTools };
  const view = createRenderer(() => <AdminPage />);
  for (let i = 0; i < 5; i += 1) await view.flush();
  expect(net.unstubbed, 'requests the page made that this test does not stub').toEqual([]);
  return view;
}

const checkboxes = (root: Host) =>
  findAll(root, (host) => host.tag === 'input' && host.props.type === 'checkbox');

function switchOf(root: Host, card: RegExp): Host | undefined {
  for (const box of checkboxes(root)) {
    for (let at = box.parent; at; at = at.parent) {
      if (checkboxes(at).length > 1) break;
      if (card.test(textOf(at))) return box;
    }
  }
  return undefined;
}

function findSwitch(view: Renderer, card: RegExp): Host {
  const bar = findAll(view.tree(), (host) => host.tag === 'nav')[0];
  const tabs = bar ? buttons(view.tree(), /./, bar) : [];
  for (const tab of [undefined, ...tabs]) {
    if (tab) {
      fire.click(tab);
      view.draw();
    }
    const found = switchOf(view.tree(), card);
    if (found) return found;
  }
  throw new Error(`no switch on any tab of the admin page sits in a card matching ${card}`);
}

describe('admin page: custom tools switch', () => {
  it('H9 finds the DDEV control switch of the page as it is today', async () => {
    const view = await mount({ enabled: true });
    expect(findSwitch(view, /ddev control/i).props.checked).toBe(true);
  });

  it('W9 shows the custom tools switch as GET reads it and PUTs the flipped value', async () => {
    const enabled = await mount({ enabled: true });
    expect(findSwitch(enabled, CUSTOM_TOOLS_CARD).props.checked).toBe(true);
    expect(net.calls).toContainEqual({ method: 'GET', path: CUSTOM_TOOLS_PATH, body: undefined });

    const disabled = await mount({ enabled: false });
    expect(findSwitch(disabled, CUSTOM_TOOLS_CARD).props.checked).toBe(false);

    net.calls = [];
    fire.check(findSwitch(disabled, CUSTOM_TOOLS_CARD), true);
    disabled.draw();
    await disabled.flush();
    expect(net.calls.filter((call) => call.method === 'PUT')).toEqual([
      { method: 'PUT', path: CUSTOM_TOOLS_PATH, body: { enabled: true } },
    ]);
    expect(findSwitch(disabled, CUSTOM_TOOLS_CARD).props.checked).toBe(true);

    net.calls = [];
    fire.check(findSwitch(disabled, CUSTOM_TOOLS_CARD), false);
    disabled.draw();
    await disabled.flush();
    expect(net.calls.filter((call) => call.method === 'PUT')).toEqual([
      { method: 'PUT', path: CUSTOM_TOOLS_PATH, body: { enabled: false } },
    ]);
    expect(findSwitch(disabled, CUSTOM_TOOLS_CARD).props.checked).toBe(false);
  });
});
