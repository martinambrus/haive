import { describe, expect, it, vi } from 'vitest';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { Badge } from '@/components/ui';
import { DefaultsByKind } from '@/components/integrations/defaults-by-kind';
import type { AdminIntegrationProvider } from '@/lib/admin-integrations';
import AdminIntegrationsPage from './page';

// No DOM in this package: hooks run on a plain slot list, as in repos/[id]/tooling/page.test.tsx.
const hooks = vi.hoisted(() => ({ slots: [] as unknown[], next: 0, dirty: false, mounting: true }));
const api = vi.hoisted(() => ({ get: vi.fn() }));

vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  useState: (initial: unknown) => {
    const at = hooks.next++;
    if (!(at in hooks.slots)) hooks.slots[at] = initial;
    const set = (update: unknown) => {
      const value = typeof update === 'function' ? update(hooks.slots[at]) : update;
      if (!Object.is(value, hooks.slots[at])) {
        hooks.slots[at] = value;
        hooks.dirty = true;
      }
    };
    return [hooks.slots[at], set];
  },
  useEffect: (effect: () => void) => {
    if (hooks.mounting) effect();
  },
  useCallback: (fn: unknown) => fn,
}));
vi.mock('@/lib/use-page-title', () => ({ usePageTitle: () => {} }));
vi.mock('@/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-client')>()),
  api,
}));

type El = ReactElement<{
  children?: ReactNode;
  variant?: string;
  provider?: AdminIntegrationProvider;
  providers?: AdminIntegrationProvider[];
}>;

const flatten = (node: ReactNode): El[] =>
  Array.isArray(node)
    ? node.flatMap(flatten)
    : isValidElement<El['props']>(node)
      ? [node, ...flatten(node.props.children)]
      : [];

const textOf = (node: ReactNode): string =>
  Array.isArray(node)
    ? node.map(textOf).join('')
    : isValidElement<El['props']>(node)
      ? textOf(node.props.children)
      : typeof node === 'string' || typeof node === 'number'
        ? String(node)
        : '';

const provider = (id: string, name: string, categories: string[]): AdminIntegrationProvider => ({
  id,
  name,
  categories,
  authKinds: ['token'],
  enabled: true,
  rowExists: true,
  oauthClientId: null,
  hasClientSecret: false,
  redirectUri: `https://haive.test/settings/integrations/callback/${id}`,
  precedence: null,
});

const PROVIDERS = [
  provider('github', 'GitHub', ['forge']),
  provider('module.acme.docs', 'Acme Docs', ['rich-documents', 'file-storage']),
];

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

async function mount(providers: AdminIntegrationProvider[] = PROVIDERS) {
  api.get.mockReset();
  api.get.mockResolvedValue({ providers });
  hooks.slots = [];
  hooks.mounting = true;
  let tree: ReactNode = null;
  const draw = () => {
    for (let pass = 0; pass < 10; pass++) {
      hooks.next = 0;
      hooks.dirty = false;
      tree = AdminIntegrationsPage();
      hooks.mounting = false;
      if (!hooks.dirty) return;
    }
    throw new Error('the page kept updating its own state');
  };
  draw();
  const beforeLoad = flatten(tree);
  await flush();
  draw();
  return { beforeLoad, all: () => flatten(tree) };
}

describe('the admin Integrations page', () => {
  it('shows Defaults by kind with the providers it loaded, and not before they are there', async () => {
    const view = await mount();
    expect(view.beforeLoad.find((e) => e.type === DefaultsByKind)).toBeUndefined();
    expect(view.all().find((e) => e.type === DefaultsByKind)?.props.providers).toEqual(PROVIDERS);
  });

  it('names the categories of each provider card by their labels, not their ids', async () => {
    const view = await mount();
    const card = view
      .all()
      .find(
        (e) =>
          typeof e.type === 'function' &&
          e.type.name === 'ProviderCard' &&
          e.props.provider?.id === 'module.acme.docs',
      );
    const render = card!.type as (props: unknown) => ReactNode;
    const badges = flatten(render(card!.props))
      .filter((e) => e.type === Badge && e.props.variant === 'info')
      .map(textOf);
    expect(badges).toEqual(['Documents', 'File storage']);
  });
});
