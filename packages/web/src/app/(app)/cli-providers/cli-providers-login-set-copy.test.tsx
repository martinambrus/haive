import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import {
  buttons,
  createRenderer,
  findAll,
  fire,
  norm,
  textOf,
  type Host,
} from '../../../../test/render-tree';
import CliProvidersPage from './page';

vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  ...(await import('../../../../test/render-tree')).reactHooks,
}));
vi.mock('next/link', () => ({ default: ({ children }: { children: unknown }) => children }));
vi.mock('@/lib/use-page-title', () => ({ usePageTitle() {} }));
vi.mock('@/lib/use-cli-login', () => ({ useCliLogin: () => ({ requireCliLogin() {} }) }));
vi.mock('@/components/cli-upgrade-all', () => ({ CliUpgradeAll: () => null }));
vi.mock('@/components/markdown/markdown-view', () => ({ MarkdownView: () => null }));
vi.mock('@/components/action-menu', () => ({
  ActionMenu: ({
    items,
  }: {
    items: ({ key: string; label: string; title?: string; onClick?: () => void } | false)[];
  }) =>
    items
      .filter(Boolean)
      .map(
        (item) =>
          item &&
          createElement(
            'button',
            { key: item.key, onClick: item.onClick, title: item.title },
            item.label,
          ),
      ),
}));
const h = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), delete: vi.fn() }));
vi.mock('@/lib/api-client', async (original) => ({
  ...(await original<typeof import('@/lib/api-client')>()),
  api: h,
}));

const SENTENCE =
  'On a Claude Code row that does not isolate its auth, Log in, Sign out, a pasted or deleted token and Connect or Disconnect usage apply to every row that shares its login (your rows of the same CLI and authentication mode), and after a deleted token those rows keep their status until their next Test or run.';

const row = (id: string, name: string) => ({
  id,
  userId: 'u',
  name,
  label: `Row ${id}`,
  enabled: true,
  authMode: 'subscription',
  authStatus: 'ok',
  isolateAuth: false,
  envVars: {},
  cliArgs: [],
});

/** Hosts whose own text holds the sentence and no child host does (the element that carries it). */
function sentenceHosts(root: Host): Host[] {
  const want = norm(SENTENCE);
  const has = (host: Host) => norm(textOf(host)).includes(want);
  return findAll(
    root,
    (host) => has(host) && !host.kids.some((k) => typeof k !== 'string' && has(k)),
  );
}

function answer(rows: unknown[], reconnectIds: string[] = [], connected = true) {
  h.get.mockImplementation(async (path: string) => {
    if (path === '/cli-providers') return { providers: rows };
    if (path === '/cli-providers/catalog') return { providers: [] };
    if (path === '/usage-window')
      return {
        snapshots: reconnectIds.map((providerId) => ({ providerId, status: 'needs_reconnect' })),
      };
    if (path.endsWith('/usage-auth')) return { connected };
    return {};
  });
}

async function renderPage() {
  const view = createRenderer(() => createElement(CliProvidersPage));
  await vi.advanceTimersByTimeAsync(0);
  view.draw();
  return view;
}

beforeEach(() => {
  vi.useFakeTimers();
  h.get.mockReset();
  h.post.mockReset();
  h.delete.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('login set copy on the providers list', () => {
  it('shows the login-set sentence once, in a readable colour, with a claude-code row', async () => {
    answer([row('a', 'claude-code')]);
    const view = await renderPage();
    const hosts = sentenceHosts(view.tree());
    expect(hosts).toHaveLength(1);
    const classes = String(hosts[0]!.props.className ?? '').split(/\s+/);
    expect(classes).toContain('text-neutral-400');
    expect(classes).not.toContain('text-neutral-600');
    expect(classes).not.toContain('text-neutral-700');
  });

  it('does not show the sentence when no row is claude-code', async () => {
    answer([row('c', 'codex')]);
    const view = await renderPage();
    expect(sentenceHosts(view.tree())).toHaveLength(0);
  });

  it('titles Disconnect usage with the shared-login wording, never "duplicate"', async () => {
    answer([row('a', 'claude-code')], ['a']);
    let view = await renderPage();
    const dead = buttons(view.tree(), /^disconnect usage$/i)[0]!;
    expect(dead.props.title).toBe(
      'Stop tracking usage and delete the stored usage token from every row that shares this login',
    );
    expect(String(dead.props.title)).not.toContain('duplicate');

    answer([row('a', 'claude-code')]);
    view = await renderPage();
    const live = buttons(view.tree(), /^disconnect usage$/i)[0]!;
    expect(live.props.title).toBe(
      "Stop tracking Claude's subscription usage and delete the stored usage token from every row that shares this login",
    );
    expect(String(live.props.title)).not.toContain('duplicate');
  });

  it('names the set in the Disconnect confirm text', async () => {
    answer([row('a', 'claude-code'), row('b', 'claude-code')]);
    const confirm = vi.fn((_message: string) => true);
    vi.stubGlobal('confirm', confirm);
    h.delete.mockResolvedValue({});
    const view = await renderPage();
    fire.click(buttons(view.tree(), /^disconnect usage$/i)[0]!);
    await vi.advanceTimersByTimeAsync(0);
    expect(String(confirm.mock.calls[0]?.[0])).toContain('every row that shares');
  });

  it('reloads the list and the sibling usage status after a successful Disconnect', async () => {
    answer([row('a', 'claude-code'), row('b', 'claude-code')]);
    vi.stubGlobal('confirm', () => true);
    h.delete.mockResolvedValue({});
    const view = await renderPage();
    const listCalls = () => h.get.mock.calls.filter(([p]) => p === '/cli-providers').length;
    const siblingCalls = () =>
      h.get.mock.calls.filter(([p]) => p === '/cli-providers/b/usage-auth').length;
    const listBefore = listCalls();
    const siblingBefore = siblingCalls();
    fire.click(buttons(view.tree(), /^disconnect usage$/i)[0]!);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.delete).toHaveBeenCalledTimes(1);
    expect(listCalls()).toBeGreaterThan(listBefore);
    expect(siblingCalls()).toBeGreaterThan(siblingBefore);
  });

  it('issues no delete and no reload when the Disconnect confirm is cancelled', async () => {
    answer([row('a', 'claude-code'), row('b', 'claude-code')]);
    vi.stubGlobal('confirm', () => false);
    const view = await renderPage();
    const getsBefore = h.get.mock.calls.length;
    fire.click(buttons(view.tree(), /^disconnect usage$/i)[0]!);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.delete).not.toHaveBeenCalled();
    expect(h.get.mock.calls.length).toBe(getsBefore);
  });
});

it.each([false, true])(
  'Disconnect describes the actual scope for an isolated row (reconnect=%s)',
  async (reconnect) => {
    answer([{ ...row('a', 'claude-code'), isolateAuth: true }], reconnect ? ['a'] : []);
    const confirm = vi.fn((_message: string) => true);
    vi.stubGlobal('confirm', confirm);
    h.delete.mockResolvedValue({});
    const view = await renderPage();
    const button = buttons(view.tree(), /^disconnect usage$/i)[0]!;
    expect(String(button.props.title)).toContain('this row');
    expect(String(button.props.title)).not.toContain('every row');
    fire.click(button);
    await vi.advanceTimersByTimeAsync(0);
    expect(String(confirm.mock.calls[0]?.[0])).toContain('Row a?');
    expect(String(confirm.mock.calls[0]?.[0])).not.toContain('every row');
    expect(h.delete).toHaveBeenCalledWith('/cli-providers/a/usage-auth');
  },
);

it.each([false, true])(
  'API-key rows hide usage authorization but retain legacy Disconnect (dead=%s)',
  async (dead) => {
    answer([{ ...row('a', 'claude-code'), authMode: 'api_key' }], dead ? ['a'] : [], dead);
    const view = await renderPage();
    expect(buttons(view.tree(), /^reconnect$/i)).toHaveLength(0);
    expect(buttons(view.tree(), /^connect usage$/i)).toHaveLength(0);
    expect(buttons(view.tree(), /^disconnect usage$/i)).toHaveLength(dead ? 1 : 0);
  },
);
