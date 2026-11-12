// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import type { RefreshCliVersionsJobResult } from '@haive/shared/constants';
import type {
  CliPackageVersionsEntry,
  CliProviderCatalogEntry,
  CliProvider,
} from '@/lib/api-client';
import { CliProviderForm } from './cli-provider-form';
import {
  buttons,
  contains,
  controls,
  createRenderer,
  findAll,
  fire,
  textOf,
} from '../../test/render-tree';

vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  ...(await import('../../test/render-tree')).reactHooks,
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, refresh: () => {}, back: () => {} }),
}));
const h = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() }));
vi.mock('@/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-client')>()),
  api: h,
}));

const POLL_PATH = '/cli-providers/catalog/claude-code/refresh-versions/7';
const metadata: CliProviderCatalogEntry = {
  name: 'claude-code',
  displayName: 'Claude Code',
  description: 'Anthropic CLI for Claude.',
  defaultExecutable: 'claude',
  supportsSubagents: true,
  supportsCliAuth: true,
  supportsMcp: true,
  supportsPlugins: true,
  supportsLsp: true,
  defaultAuthMode: 'subscription',
  apiKeyEnvName: 'ANTHROPIC_API_KEY',
  defaultModel: null,
  supportsModelSelection: false,
  authConfigPaths: [],
  effortScale: null,
  versionPinnable: true,
  installSupported: true,
  versionCache: null,
};
const entry: CliPackageVersionsEntry = {
  name: 'claude-code',
  versions: ['2.0.1', '2.0.0'],
  latestVersion: '2.0.1',
  fetchedAt: null,
  fetchError: null,
};
const refreshed = [{ name: 'claude-code', count: 2, latest: '2.0.1' }];
const OPENROUTER_FAILED: RefreshCliVersionsJobResult = {
  ok: false,
  refreshed,
  errors: [{ name: 'openrouter', error: 'models endpoint HTTP 503' }],
};

let answer: Record<string, unknown>;
let role: 'admin' | 'user' | null;

beforeEach(() => {
  vi.useFakeTimers();
  role = 'admin';
  h.post.mockReset().mockResolvedValue({ jobId: '7' });
  h.get.mockReset().mockImplementation(async (path: string) => {
    if (path === '/auth/me') return { user: role ? { role } : null };
    if (path.endsWith('/refresh-result')) return { run: null };
    if (path === POLL_PATH) return answer;
    throw new Error(`Unexpected GET ${path}`);
  });
});
afterEach(() => vi.useRealTimers());

type View = ReturnType<typeof createRenderer>;

async function settle(view: View) {
  await vi.advanceTimersByTimeAsync(0);
  view.draw();
  await vi.advanceTimersByTimeAsync(0);
  view.draw();
}
async function clickRefresh(view: View) {
  fire.click(buttons(view.tree(), /^refresh$/i)[0]!);
  await settle(view);
}
const alertsIn = (view: View) => findAll(view.tree(), (host) => host.props.role === 'alert');
const offeredVersions = (view: View) =>
  findAll(controls(view.tree(), /^cli version$/)[0]!, (host) => host.tag === 'option').map(
    (option) => textOf(option),
  );
const mount = () =>
  createRenderer(() => createElement(CliProviderForm, { mode: 'create', metadata }));

describe('CLI version refresh in the provider form', () => {
  it('shows the stored scheduled failure after reopening the form', async () => {
    const original = h.get.getMockImplementation()!;
    h.get.mockImplementation((path: string) =>
      path.endsWith('/refresh-result')
        ? Promise.resolve({
            run: {
              trigger: 'scheduled',
              startedAt: '2026-11-01T00:00:00Z',
              finishedAt: '2026-11-01T00:01:00Z',
              result: OPENROUTER_FAILED,
            },
          })
        : original(path),
    );
    const view = mount();
    await settle(view);
    expect(textOf(view.tree())).toContain('models endpoint HTTP 503');
    expect(h.post).not.toHaveBeenCalled();
  });
  it('names the failed source and its reason where the version is picked, and still applies the versions', async () => {
    answer = { status: 'done', entry, result: OPENROUTER_FAILED };
    const view = mount();
    await clickRefresh(view);

    const shown = alertsIn(view);
    expect(shown).toHaveLength(1);
    const text = textOf(shown[0]!);
    expect(text.replaceAll('models endpoint HTTP 503', '')).toContain('openrouter');
    expect(text).toContain('models endpoint HTTP 503');
    const label = findAll(
      view.tree(),
      (host) => host.tag === 'label' && host.props.htmlFor === 'cliVersion',
    )[0]!;
    expect(contains(label.parent!, shown[0]!)).toBe(true);

    expect(offeredVersions(view)).toEqual(['2.0.1', '2.0.0']);
  });

  it('shows no notice when every source refreshed, and applies the versions', async () => {
    answer = { status: 'done', entry, result: { ok: true, refreshed, errors: [] } };
    const view = mount();
    await clickRefresh(view);

    expect(offeredVersions(view)).toEqual(['2.0.1', '2.0.0']);
    expect(alertsIn(view)).toHaveLength(0);
  });

  it('shows no notice when the answer carries no job result, and applies the versions', async () => {
    answer = { status: 'done', entry };
    const view = mount();
    await clickRefresh(view);

    expect(offeredVersions(view)).toEqual(['2.0.1', '2.0.0']);
    expect(alertsIn(view)).toHaveLength(0);
  });

  it('removes the earlier notice while another refresh is queued', async () => {
    answer = { status: 'done', entry, result: OPENROUTER_FAILED };
    const view = mount();
    await clickRefresh(view);
    expect(alertsIn(view)).toHaveLength(1);

    answer = { status: 'pending', state: 'waiting' };
    await clickRefresh(view);

    expect(buttons(view.tree(), /^queued\.\.\.$/i)).toHaveLength(1);
    expect(alertsIn(view)).toHaveLength(0);
  });
});

it.each(['user', null] as const)(
  'never polls or renders durable refresh results for role %s',
  async (viewerRole) => {
    role = viewerRole;
    const view = mount();
    await settle(view);
    await vi.advanceTimersByTimeAsync(30_000);
    view.draw();
    expect(h.get.mock.calls.filter(([path]) => path.endsWith('/refresh-result'))).toHaveLength(0);
    expect(alertsIn(view)).toHaveLength(0);
  },
);
it('does not poll while the viewer role is unresolved', async () => {
  const original = h.get.getMockImplementation()!;
  h.get.mockImplementation((path: string) =>
    path === '/auth/me' ? new Promise(() => {}) : original(path),
  );
  const view = mount();
  await settle(view);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(h.get.mock.calls.filter(([path]) => path.endsWith('/refresh-result'))).toHaveLength(0);
});
it('polls durable refresh results for admins', async () => {
  const view = mount();
  await settle(view);
  await settle(view);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(h.get.mock.calls.filter(([path]) => path.endsWith('/refresh-result'))).toHaveLength(4);
  expect(h.get.mock.calls.filter(([path]) => path === '/auth/me')).toHaveLength(1);
});
it('still names the failed sources of a manual refresh when the role read failed', async () => {
  const original = h.get.getMockImplementation()!;
  h.get.mockImplementation((path: string) =>
    path === '/auth/me' ? Promise.reject(new Error('network down')) : original(path),
  );
  answer = { status: 'done', entry, result: OPENROUTER_FAILED };
  const view = mount();
  await settle(view);
  await clickRefresh(view);
  const shown = alertsIn(view);
  expect(shown).toHaveLength(1);
  expect(textOf(shown[0]!)).toContain('models endpoint HTTP 503');
  expect(h.get.mock.calls.filter(([path]) => path.endsWith('/refresh-result'))).toHaveLength(0);
});

it('retries a transient role read and reveals the stored result without reloading', async () => {
  const original = h.get.getMockImplementation()!;
  let attempts = 0;
  h.get.mockImplementation((path: string) => {
    if (path === '/auth/me' && ++attempts === 1) return Promise.reject(new Error('offline'));
    return original(path);
  });
  const view = mount();
  await settle(view);
  expect(h.get.mock.calls.filter(([path]) => path.endsWith('/refresh-result'))).toHaveLength(0);
  await vi.advanceTimersByTimeAsync(10_000);
  await settle(view);
  expect(h.get.mock.calls.filter(([path]) => path === '/auth/me')).toHaveLength(2);
  expect(h.get.mock.calls.filter(([path]) => path.endsWith('/refresh-result'))).toHaveLength(1);
});

it('cancels a pending role retry when the form unmounts', async () => {
  h.get.mockRejectedValue(new Error('offline'));
  let mounted = true;
  const view = createRenderer(() =>
    mounted ? createElement(CliProviderForm, { mode: 'create', metadata }) : null,
  );
  await settle(view);
  mounted = false;
  view.draw();
  await vi.advanceTimersByTimeAsync(30_000);
  expect(h.get).toHaveBeenCalledOnce();
});

it.each([401, 403])('does not retry a role read refused with %s', async (status) => {
  h.get.mockRejectedValue(Object.assign(new Error('refused'), { status }));
  const view = mount();
  await settle(view);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(h.get).toHaveBeenCalledOnce();
});

it('does not retry when an in-flight role read fails after unmount', async () => {
  let reject!: (error: Error) => void;
  h.get.mockImplementation(
    () =>
      new Promise((_resolve, fail) => {
        reject = fail;
      }),
  );
  let mounted = true;
  const view = createRenderer(() =>
    mounted ? createElement(CliProviderForm, { mode: 'create', metadata }) : null,
  );
  mounted = false;
  view.draw();
  reject(new Error('offline'));
  await vi.advanceTimersByTimeAsync(30_000);
  expect(h.get).toHaveBeenCalledOnce();
});

it('retries a partial secret removal without deleting the already removed name again', async () => {
  const secrets = [{ secretName: 'FIRST' }, { secretName: 'SECOND' }];
  const deleted = new Set<string>();
  let busy = true;
  const original = h.get.getMockImplementation()!;
  h.get.mockImplementation((path: string) =>
    path === '/cli-providers/p/secrets'
      ? Promise.resolve({ secrets: secrets.filter((s) => !deleted.has(s.secretName)) })
      : original(path),
  );
  h.patch.mockResolvedValue({});
  h.delete.mockImplementation(async (path: string) => {
    const name = path.split('/').at(-1)!;
    if (deleted.has(name)) throw Object.assign(new Error('Not found'), { status: 404 });
    if (name === 'SECOND' && busy) {
      busy = false;
      throw Object.assign(new Error('Authentication busy'), { status: 409, code: 'cli_auth_busy' });
    }
    deleted.add(name);
  });
  const provider = {
    id: 'p',
    name: 'claude-code',
    label: 'Claude',
    envVars: {},
    cliArgs: [],
    networkPolicy: { mode: 'unrestricted' },
    egressDomains: [],
  } as unknown as CliProvider;
  const view = createRenderer(() =>
    createElement(CliProviderForm, { mode: 'edit', metadata, provider }),
  );
  await settle(view);
  fire.type(controls(view.tree(), /^secrets$/)[0]!, '');
  view.draw();
  const submit = () =>
    (
      findAll(view.tree(), (h) => h.tag === 'form')[0]!.props.onSubmit as (
        e: unknown,
      ) => Promise<void>
    )({ preventDefault() {} });
  await submit();
  await settle(view);
  expect(deleted).toEqual(new Set(['FIRST']));
  await submit();
  await settle(view);
  expect(deleted).toEqual(new Set(['FIRST', 'SECOND']));
  expect(h.delete.mock.calls.filter(([path]) => path.endsWith('/FIRST'))).toHaveLength(1);
});
