import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createRenderer,
  buttons,
  controls,
  findAll,
  fire,
  textOf,
} from '../../../../../test/render-tree';
import IntegrationsPage from './page';

const api = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn(), getIntegrationCategories: vi.fn() }));
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  ...(await import('../../../../../test/render-tree')).reactHooks,
}));
vi.mock('@/lib/api-client', async (original) => ({
  ...(await original<typeof import('@/lib/api-client')>()),
  api,
  getIntegrationCategories: api.getIntegrationCategories,
}));
vi.mock('@/lib/use-page-title', () => ({ usePageTitle: () => {} }));
vi.mock('@/lib/use-device-sign-in', () => ({
  useDeviceSignIn: () => ({ phase: { kind: 'idle' }, cancel: () => {}, start: vi.fn() }),
}));
vi.mock('@/components/markdown/markdown-view', () => ({
  MarkdownView: ({ body }: { body: string }) => body,
}));
vi.mock('@/components/integrations/github-client-card', () => ({ GithubClientCard: () => null }));
vi.mock('@/components/integrations/device-sign-in-dialog', () => ({
  DeviceSignInDialog: () => null,
}));
vi.mock('@/components/integrations/disconnect-dialog', () => ({ DisconnectDialog: () => null }));
vi.mock('next/link', () => ({ default: (props: Record<string, unknown>) => <a {...props} /> }));

const provider = {
  id: 'module.acme.docs',
  displayName: 'Acme Docs',
  categories: ['module.acme.crm'],
  selfHosted: false,
  enabled: true,
  state: 'enabled',
  module: { id: 'acme', name: 'Acme module' },
  writeEnabled: false,
  canWrite: true,
  writeScopes: {},
  connect: ['oauth2'],
};
const connection = {
  id: 'owned',
  providerId: provider.id,
  accountLabel: 'my account',
  authMethod: 'oauth2',
  grantedScopes: [],
  status: 'connected',
  lastError: null,
  refreshRefusedAt: null,
  repoCredentialId: null,
  expiresAt: null,
  createdAt: '2026-10-14T10:00:00.000Z',
  updatedAt: '2026-10-14T10:00:00.000Z',
};
const categories = {
  categories: [
    {
      id: 'module.acme.crm',
      label: 'Customer records',
      moduleId: 'acme',
      moduleName: 'Acme module',
    },
  ],
};
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
let shown: Record<string, unknown>[];
beforeEach(() => {
  Object.values(api).forEach((fn) => fn.mockReset());
  shown = [provider];
  api.get.mockImplementation(async (path: string) => {
    if (path === '/integrations/providers') return { providers: shown };
    if (path === '/integrations/connections') return { connections: [connection] };
    if (path === '/repo-credentials') return { credentials: [] };
    throw new Error(`Unexpected read ${path}`);
  });
  api.getIntegrationCategories.mockResolvedValue(categories);
});
describe('Settings integration module metadata', () => {
  it.each(['success', 'failure'])(
    'keeps the saved write switch and owned connection through late category %s',
    async (outcome) => {
      const pending = deferred<typeof categories>();
      void pending.promise.catch(() => {});
      api.getIntegrationCategories.mockReturnValue(pending.promise);
      const view = createRenderer(() => <IntegrationsPage />);
      await view.flush();
      expect(textOf(view.tree())).toContain('my account');
      expect(buttons(view.tree(), 'disconnect my account from acme docs')).toHaveLength(1);
      api.put.mockResolvedValue({ providerId: provider.id, writeEnabled: true });
      fire.check(controls(view.tree(), 'allow write access')[0]!, true);
      await view.flush();
      if (outcome === 'success') pending.resolve(categories);
      else pending.reject(new Error('Category metadata unavailable'));
      await view.flush();
      expect(controls(view.tree(), 'allow write access')[0]!.props.checked).toBe(true);
      expect(textOf(view.tree())).toContain(
        outcome === 'success' ? 'Customer records' : 'Category metadata unavailable',
      );
      expect(buttons(view.tree(), 'disconnect my account from acme docs')[0]!.props.disabled).toBe(
        false,
      );
    },
  );

  it.each([
    ['disabled', 'Provider disabled'],
    ['module-deactivated', 'Module deactivated'],
    ['unknown', 'Provider availability is unknown'],
  ])(
    'reports %s without changing the connected account status or offering sign-in',
    async (state, expected) => {
      shown = [{ ...provider, enabled: false, state, connect: [] }];
      const view = createRenderer(() => <IntegrationsPage />);
      await view.flush();
      expect(textOf(view.tree())).toContain(expected);
      expect(textOf(view.tree())).toContain('Connected');
      expect(buttons(view.tree(), /sign in/)).toHaveLength(0);
      expect(buttons(view.tree(), 'disconnect my account from acme docs')).toHaveLength(1);
    },
  );

  it('keeps an unavailable provider account visible and removable', async () => {
    shown = [];
    const view = createRenderer(() => <IntegrationsPage />);
    await view.flush();
    expect(textOf(view.tree())).toContain('Provider unavailable on this install');
    expect(findAll(view.tree(), (h) => h.props['data-connection-id'] === 'owned')).toHaveLength(1);
    expect(buttons(view.tree(), /disconnect my account/)).toHaveLength(1);
  });
});
