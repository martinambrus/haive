import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import {
  buttons,
  createRenderer,
  findAll,
  fire,
  isDisabled,
  textOf,
  type Host,
} from '../../../../test/render-tree';
import CliProvidersPage from './page';
import { IMAGE_BUILDING_REASON, IMAGE_FAILED_REASON } from '@/lib/cli-image-build';

vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  ...(await import('../../../../test/render-tree')).reactHooks,
}));
vi.mock('lucide-react', async (original) => ({
  ...(await original<typeof import('lucide-react')>()),
  LoaderCircle: () => createElement('svg'),
}));
vi.mock('next/link', () => ({ default: ({ children }: { children: unknown }) => children }));
vi.mock('@/lib/use-page-title', () => ({ usePageTitle() {} }));
vi.mock('@/lib/use-cli-login', () => ({ useCliLogin: () => ({ requireCliLogin() {} }) }));
vi.mock('@/components/markdown/markdown-view', () => ({ MarkdownView: () => null }));
vi.mock('@/components/cli-upgrade-all', () => ({
  CliUpgradeAll: ({ onUpgrade }: { onUpgrade: (ids: string[]) => void }) =>
    createElement('button', { onClick: () => onUpgrade(['p']) }, 'Upgrade everything'),
}));
vi.mock('@/components/action-menu', () => ({
  ActionMenu: ({
    items,
  }: {
    items: (
      | { key: string; label: string; onClick?: () => void; disabled?: boolean; title?: string }
      | false
      | null
    )[];
  }) =>
    items
      .filter(Boolean)
      .map(
        (item) =>
          item &&
          createElement(
            'button',
            { key: item.key, onClick: item.onClick, disabled: item.disabled, title: item.title },
            item.label,
          ),
      ),
}));
const h = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  probe: vi.fn(),
}));
vi.mock('@/lib/api-client', async (original) => ({
  ...(await original<typeof import('@/lib/api-client')>()),
  api: h,
}));
vi.mock('@/lib/cli-jobs', async (original) => ({
  ...(await original<typeof import('@/lib/cli-jobs')>()),
  runCliProbe: h.probe,
}));

type Status = 'idle' | 'building' | 'ready' | 'failed';
const state = { status: 'ready' as Status, error: null as string | null, authStatus: 'ok' };

function provider() {
  return {
    id: 'p',
    userId: 'u',
    name: 'codex',
    label: 'Codex',
    enabled: true,
    authMode: 'subscription',
    authStatus: state.authStatus,
    isolateAuth: false,
    envVars: {},
    cliArgs: [],
    cliVersion: '1.0',
    sandboxImageBuildStatus: state.status,
    sandboxImageBuildError: state.error,
  };
}

const catalog = {
  providers: [
    {
      name: 'codex',
      description: 'd',
      versionPinnable: true,
      versionCache: { versions: ['2.0', '1.0'] },
    },
  ],
};

const listCalls = () => h.get.mock.calls.filter(([path]) => path === '/cli-providers');
const pollCalls = () => listCalls().filter(([, signal]) => signal !== undefined);

function fakeDocument() {
  const doc = {
    hidden: false,
    listeners: [] as (() => void)[],
    addEventListener: (_: string, fn: () => void) => doc.listeners.push(fn),
    removeEventListener: (_: string, fn: () => void) => {
      doc.listeners = doc.listeners.filter((l) => l !== fn);
    },
  };
  vi.stubGlobal('document', doc);
  return doc;
}

async function mount() {
  const view = createRenderer(() => createElement(CliProvidersPage));
  await vi.advanceTimersByTimeAsync(0);
  view.draw();
  return view;
}

const menuButton = (root: Host, name: RegExp) => buttons(root, name)[0]!;
const inlineLogin = (root: Host) =>
  buttons(root, /^log in$/i).filter((b) => b.props.type === 'button');

beforeEach(() => {
  vi.useFakeTimers();
  h.get.mockReset();
  h.post.mockReset();
  h.patch.mockReset();
  h.probe.mockReset();
  state.status = 'ready';
  state.error = null;
  state.authStatus = 'ok';
  h.get.mockImplementation(async (path: string) => {
    if (path === '/cli-providers') return { providers: [provider()] };
    if (path === '/cli-providers/catalog') return catalog;
    if (path === '/usage-window') return { snapshots: [] };
    if (path.endsWith('/usage-auth')) return { connected: false };
    return {};
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('image build state on the providers list', () => {
  it('P1 shows the rebuilding badge with its version only on a building row', async () => {
    fakeDocument();
    state.status = 'building';
    let view = await mount();
    expect(textOf(view.tree())).toContain('Rebuilding sandbox image · 1.0');
    state.status = 'ready';
    view = await mount();
    expect(textOf(view.tree())).not.toContain('Rebuilding sandbox image');
  });

  it('P2 shows the stored error and Rebuild image, which posts the build and reloads', async () => {
    fakeDocument();
    state.status = 'failed';
    state.error = 'step 4 failed: npm ERR';
    let finish!: () => void;
    h.post.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = () => {
            state.status = 'building';
            resolve();
          };
        }),
    );
    const view = await mount();
    expect(textOf(view.tree())).toContain('Image build failed');
    expect(textOf(view.tree())).toContain('step 4 failed: npm ERR');
    fire.click(buttons(view.tree(), /^rebuild image$/i)[0]!);
    view.draw();
    expect(h.post.mock.calls[0]?.[0]).toBe('/cli-providers/p/sandbox-image/build');
    expect(isDisabled(buttons(view.tree(), /^starting\.\.\.$/i)[0]!)).toBe(true);
    finish();
    await vi.advanceTimersByTimeAsync(0);
    view.draw();
    expect(textOf(view.tree())).toContain('Rebuilding sandbox image');
    expect(textOf(view.tree())).not.toContain('step 4 failed');
  });

  it('P3 shows no failed block for a ready row holding stale error text', async () => {
    fakeDocument();
    state.error = 'old failure';
    const view = await mount();
    expect(textOf(view.tree())).not.toContain('old failure');
    expect(textOf(view.tree())).not.toContain('Image build failed');
    expect(buttons(view.tree(), /^rebuild image$/i)).toHaveLength(0);
  });

  it('P4 repeats only the provider list at the interval', async () => {
    fakeDocument();
    state.status = 'building';
    h.get.mockImplementation(async (path: string) => {
      if (path === '/cli-providers')
        return { providers: [{ ...provider(), name: 'claude-code', label: 'Claude' }] };
      if (path === '/cli-providers/catalog') return catalog;
      if (path === '/usage-window') return { snapshots: [] };
      if (path.endsWith('/usage-auth')) return { connected: false };
      return {};
    });
    await mount();
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(3000);
    await vi.advanceTimersByTimeAsync(3000);
    expect(pollCalls()).toHaveLength(2);
    const count = (path: string) => h.get.mock.calls.filter(([p]) => p === path).length;
    expect(count('/cli-providers/catalog')).toBe(1);
    expect(count('/usage-window')).toBe(1);
    expect(count('/cli-providers/p/usage-auth')).toBe(1);
  });

  it('P5 stops once the row is ready', async () => {
    fakeDocument();
    state.status = 'building';
    const view = await mount();
    expect(textOf(view.tree())).toContain('Rebuilding sandbox image');
    state.status = 'ready';
    await vi.advanceTimersByTimeAsync(3000);
    view.draw();
    expect(textOf(view.tree())).not.toContain('Rebuilding sandbox image');
    const before = listCalls().length;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(listCalls()).toHaveLength(before);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('P6 starts no poll when nothing is building', async () => {
    fakeDocument();
    await mount();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(listCalls()).toHaveLength(1);
  });

  it('P7 holds requests while the tab is hidden and reads at once on return', async () => {
    const doc = fakeDocument();
    state.status = 'building';
    doc.hidden = true;
    await mount();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(pollCalls()).toHaveLength(0);
    doc.hidden = false;
    for (const listener of doc.listeners) listener();
    await vi.advanceTimersByTimeAsync(0);
    expect(pollCalls()).toHaveLength(1);
  });

  it('P8 aborts and clears its timer on unmount', async () => {
    fakeDocument();
    state.status = 'building';
    let mounted = true;
    const view = createRenderer(() => (mounted ? createElement(CliProvidersPage) : null));
    await vi.advanceTimersByTimeAsync(0);
    view.draw();
    await vi.advanceTimersByTimeAsync(3000);
    const signal = pollCalls()[0]?.[1] as AbortSignal | undefined;
    expect(signal).toBeDefined();
    mounted = false;
    view.draw();
    expect(signal?.aborted).toBe(true);
    const before = listCalls().length;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(listCalls()).toHaveLength(before);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('P9 gates Test and both Log in entries by the build state', async () => {
    fakeDocument();
    state.authStatus = 'unknown';
    for (const [status, reason] of [
      ['building', IMAGE_BUILDING_REASON],
      ['failed', IMAGE_FAILED_REASON],
    ] as const) {
      state.status = status;
      const view = await mount();
      for (const name of [/^test$/i, /^log in$/i]) {
        const button = menuButton(view.tree(), name);
        expect(isDisabled(button)).toBe(true);
        expect(button.props.title).toBe(reason);
      }
    }
    state.status = 'ready';
    const ready = await mount();
    expect(isDisabled(menuButton(ready.tree(), /^test$/i))).toBe(false);
    expect(isDisabled(menuButton(ready.tree(), /^log in$/i))).toBe(false);
  });

  it('P9 gates the inline Log in of a test result the same way', async () => {
    fakeDocument();
    h.probe.mockImplementation(async () => {
      state.status = 'building';
      return { ok: false, cli: { ok: false, authStatus: 'auth_expired', error: 'login' } };
    });
    state.status = 'ready';
    const view = await mount();
    fire.click(menuButton(view.tree(), /^test$/i));
    await vi.advanceTimersByTimeAsync(0);
    view.draw();
    const inline = inlineLogin(view.tree());
    expect(inline).toHaveLength(1);
    expect(isDisabled(inline[0]!)).toBe(true);
    expect(inline[0]!.props.title).toBe(IMAGE_BUILDING_REASON);
  });

  it('P10 an Upgrade shows the rebuild without a manual reload', async () => {
    fakeDocument();
    h.patch.mockImplementation(async () => {
      state.status = 'building';
      return {};
    });
    const view = await mount();
    fire.click(menuButton(view.tree(), /^upgrade$/i));
    await vi.advanceTimersByTimeAsync(0);
    view.draw();
    expect(h.patch.mock.calls[0]).toEqual(['/cli-providers/p', { cliVersion: '2.0' }]);
    expect(textOf(view.tree())).toContain('Rebuilding sandbox image');
    const notice = findAll(view.tree(), (n) => n.props.role === 'status').map((n) => textOf(n));
    expect(notice).toEqual(['Codex is pinned to 2.0; its sandbox image rebuild has started.']);
  });

  it('P10 Upgrade All reports the started rebuilds', async () => {
    fakeDocument();
    h.patch.mockImplementation(async () => {
      state.status = 'building';
      return {};
    });
    const view = await mount();
    fire.click(buttons(view.tree(), /^upgrade everything$/i)[0]!);
    await vi.advanceTimersByTimeAsync(0);
    view.draw();
    expect(textOf(view.tree())).toContain('Rebuilding sandbox image');
    const notice = findAll(view.tree(), (n) => n.props.role === 'status').map((n) => textOf(n));
    expect(notice).toEqual(['1 sandbox image rebuild has started.']);
  });
});
