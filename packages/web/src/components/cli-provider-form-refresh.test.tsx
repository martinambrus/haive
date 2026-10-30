import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import type { RefreshCliVersionsJobResult } from '@haive/shared/constants';
import type { CliPackageVersionsEntry, CliProviderCatalogEntry } from '@/lib/api-client';
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
const h = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
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

beforeEach(() => {
  vi.useFakeTimers();
  h.post.mockReset().mockResolvedValue({ jobId: '7' });
  h.get.mockReset().mockImplementation(async (path: string) => {
    if (path === POLL_PATH) return answer;
    throw new Error(`Unexpected GET ${path}`);
  });
});
afterEach(() => vi.useRealTimers());

type View = ReturnType<typeof createRenderer>;

async function settle(view: View) {
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
