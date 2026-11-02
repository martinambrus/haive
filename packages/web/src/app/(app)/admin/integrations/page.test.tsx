import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createRenderer,
  controls,
  buttons,
  findAll,
  fire,
  textOf,
} from '../../../../../test/render-tree';
import AdminIntegrationsPage from './page';

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
vi.mock('@/components/markdown/markdown-view', () => ({
  MarkdownView: ({ body }: { body: string }) => body,
}));
vi.mock('@/components/integrations/defaults-by-kind', () => ({
  DefaultsByKind: ({ providers }: { providers: { id: string }[] }) => (
    <section data-default-providers={providers.map((p) => p.id).join(',')}>
      Defaults by kind
    </section>
  ),
}));

const provider = {
  id: 'module.acme.docs',
  name: 'Acme Docs',
  categories: ['module.acme.crm'],
  authKinds: ['oauth2'],
  enabled: true,
  rowExists: true,
  oauthClientId: 'saved-client',
  hasClientSecret: true,
  redirectUri: 'https://haive.test/callback',
  precedence: null,
  state: 'module-deactivated',
  module: { id: 'acme', name: 'Acme module' },
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
beforeEach(() => {
  Object.values(api).forEach((fn) => fn.mockReset());
  api.get.mockResolvedValue({ providers: [provider] });
  api.getIntegrationCategories.mockResolvedValue(categories);
});

describe('the admin Integrations page', () => {
  it('shows defaults after providers load, module category labels and contributing module/state', async () => {
    const view = createRenderer(() => <AdminIntegrationsPage />);
    expect(textOf(view.tree())).not.toContain('Defaults by kind');
    await view.flush();
    expect(
      findAll(view.tree(), (h) => h.props['data-default-providers'] === provider.id),
    ).toHaveLength(1);
    const text = textOf(view.tree());
    expect(text).toContain('Customer records');
    expect(text).toContain('Acme module');
    expect(text).toContain('Module deactivated');
    expect(controls(view.tree(), 'enabled')[0]!.props.checked).toBe(true);
  });

  it.each(['success', 'failure'])(
    'keeps edited OAuth fields through late category %s',
    async (outcome) => {
      const pending = deferred<typeof categories>();
      void pending.promise.catch(() => {});
      api.getIntegrationCategories.mockReturnValue(pending.promise);
      const view = createRenderer(() => <AdminIntegrationsPage />);
      await view.flush();
      fire.type(controls(view.tree(), 'client id')[0]!, 'my-current-client');
      fire.type(controls(view.tree(), 'client secret')[0]!, 'my-current-secret');
      view.draw();
      if (outcome === 'success') pending.resolve(categories);
      else pending.reject(new Error('Category metadata unavailable'));
      await view.flush();
      expect(controls(view.tree(), 'client id')[0]!.props.value).toBe('my-current-client');
      expect(controls(view.tree(), 'client secret')[0]!.props.value).toBe('my-current-secret');
      if (outcome === 'success') expect(textOf(view.tree())).toContain('Customer records');
      else expect(textOf(view.tree())).toContain('Category metadata unavailable');
      api.put.mockRejectedValueOnce(new Error('Save refused'));
      fire.click(buttons(view.tree(), 'save client')[0]!);
      await view.flush();
      expect(api.put).toHaveBeenCalledWith('/admin/integrations/providers/module.acme.docs', {
        oauthClientId: 'my-current-client',
        oauthClientSecret: 'my-current-secret',
      });
      expect(controls(view.tree(), 'client secret')[0]!.props.value).toBe('my-current-secret');
    },
  );
});
