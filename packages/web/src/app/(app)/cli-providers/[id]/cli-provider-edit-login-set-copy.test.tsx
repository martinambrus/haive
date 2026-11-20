import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import {
  buttons,
  createRenderer,
  findAll,
  norm,
  textOf,
  type Host,
} from '../../../../../test/render-tree';
import EditCliProviderPage from './page';
import { ClaudeUsageAuth } from '@/components/claude-usage-auth';

vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  ...(await import('../../../../../test/render-tree')).reactHooks,
}));
vi.mock('next/link', () => ({ default: ({ children }: { children: unknown }) => children }));
vi.mock('next/navigation', () => ({ useParams: () => ({ id: 'a' }) }));
vi.mock('@/lib/use-page-title', () => ({ usePageTitle() {} }));
vi.mock('@/components/cli-provider-form', () => ({ CliProviderForm: () => null }));
vi.mock('@/components/cli-provider-test', () => ({ CliProviderTest: () => null }));
const h = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), delete: vi.fn() }));
vi.mock('@/lib/api-client', async (original) => ({
  ...(await original<typeof import('@/lib/api-client')>()),
  api: h,
}));

const SENTENCE =
  'On a Claude Code row that does not isolate its auth, Log in, Sign out, a pasted or deleted token and Connect or Disconnect usage apply to every row that shares its login (your rows of the same CLI and authentication mode), and after a deleted token those rows keep their status until their next Test or run.';

function sentenceHosts(root: Host): Host[] {
  const want = norm(SENTENCE);
  const has = (host: Host) => norm(textOf(host)).includes(want);
  return findAll(
    root,
    (host) => has(host) && !host.kids.some((k) => typeof k !== 'string' && has(k)),
  );
}

function answer(name: string, usage: { connected: boolean; dead?: boolean }) {
  const provider = {
    id: 'a',
    userId: 'u',
    name,
    label: 'Row a',
    enabled: true,
    authMode: 'subscription',
    authStatus: 'ok',
    isolateAuth: false,
    envVars: {},
    cliArgs: [],
  };
  h.get.mockImplementation(async (path: string) => {
    if (path === '/cli-providers/a') return { provider };
    if (path === '/cli-providers/catalog')
      return { providers: [{ name, description: 'd', defaultExecutable: name }] };
    if (path === '/cli-providers') return { providers: [provider] };
    if (path === '/usage-window')
      return {
        snapshots: usage.dead ? [{ providerId: 'a', status: 'needs_reconnect' }] : [],
      };
    if (path === '/cli-providers/a/usage-auth')
      return { connected: usage.connected, connectedAt: null };
    return {};
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  h.get.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('login set copy on the edit page and the usage card', () => {
  it('shows the login-set sentence once on a claude-code row, in a readable colour', async () => {
    answer('claude-code', { connected: true });
    const view = createRenderer(() => createElement(EditCliProviderPage));
    await vi.advanceTimersByTimeAsync(0);
    view.draw();
    await vi.advanceTimersByTimeAsync(0);
    view.draw();
    const hosts = sentenceHosts(view.tree());
    expect(hosts).toHaveLength(1);
    const classes = String(hosts[0]!.props.className ?? '').split(/\s+/);
    expect(classes).toContain('text-neutral-400');
    expect(classes).not.toContain('text-neutral-600');
    expect(classes).not.toContain('text-neutral-700');
  });

  it('does not show the sentence on a codex row', async () => {
    answer('codex', { connected: false });
    const view = createRenderer(() => createElement(EditCliProviderPage));
    await vi.advanceTimersByTimeAsync(0);
    view.draw();
    await vi.advanceTimersByTimeAsync(0);
    view.draw();
    expect(textOf(view.tree())).toContain('Configuration');
    expect(sentenceHosts(view.tree())).toHaveLength(0);
  });

  it('says on a dead-token usage card that Disconnect removes the token from the whole login set', async () => {
    answer('claude-code', { connected: true, dead: true });
    const view = createRenderer(() => createElement(ClaudeUsageAuth, { providerId: 'a' }));
    await vi.advanceTimersByTimeAsync(0);
    view.draw();
    const text = textOf(view.tree());
    expect(text).toContain('Token expired');
    expect(text).not.toContain('duplicate');
    expect(norm(text)).toContain('every row that shares');
    expect(buttons(view.tree(), /^reconnect$/i)).toHaveLength(1);
    expect(buttons(view.tree(), /^disconnect$/i)).toHaveLength(1);
  });
});
