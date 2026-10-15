import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { CORE_INTEGRATION_CATEGORY_SPECS } from '@haive/shared/modularity';
import { FormError } from '@/components/ui';
import type { AdminIntegrationProvider } from '@/lib/admin-integrations';
import { DefaultsByKind } from './defaults-by-kind';

// No DOM in this package: hooks run on a plain slot list, as in repos/[id]/tooling/page.test.tsx.
const hooks = vi.hoisted(() => ({ slots: [] as unknown[], next: 0, dirty: false, mounting: true }));
const api = vi.hoisted(() => ({
  listAdminIntegrationDefaults: vi.fn(),
  saveAdminIntegrationDefault: vi.fn(),
}));

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
}));
vi.mock('@/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-client')>()),
  ...api,
}));

type El = ReactElement<{
  children?: ReactNode;
  'aria-label'?: string;
  'data-category-id'?: string;
  value?: string;
  disabled?: boolean;
  message?: string | null;
  onClick?: () => void;
  onChange?: (event: { target: { value: string } }) => void;
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

const provider = (
  id: string,
  name: string,
  categories: string[],
  enabled = true,
): AdminIntegrationProvider => ({
  id,
  name,
  categories,
  authKinds: ['token'],
  enabled,
  rowExists: true,
  oauthClientId: null,
  hasClientSecret: false,
  redirectUri: `https://haive.test/settings/integrations/callback/${id}`,
  precedence: null,
});

const PROVIDERS = [
  provider('github', 'GitHub', ['forge']),
  provider('gitlab', 'GitLab', ['forge']),
  provider('gitea', 'Gitea', ['forge'], false),
  provider('module.acme.docs', 'Acme Docs', ['rich-documents', 'file-storage']),
];

const NAME = {
  provider: (label: string) => `${label} default provider`,
  clear: (label: string) => `Clear ${label} default`,
};
type Control = keyof typeof NAME;
const labelOf = (categoryId: string) =>
  CORE_INTEGRATION_CATEGORY_SPECS.find((spec) => spec.id === categoryId)!.label;
const refusal = (message: string, status: number) => Object.assign(new Error(message), { status });

interface Setup {
  defaults?: { categoryId: string; providerId: string }[];
  loadError?: string;
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

async function mount(providers: AdminIntegrationProvider[] = PROVIDERS, setup: Setup = {}) {
  if (setup.loadError) {
    api.listAdminIntegrationDefaults.mockRejectedValue(refusal(setup.loadError, 500));
  } else {
    api.listAdminIntegrationDefaults.mockResolvedValue({ defaults: setup.defaults ?? [] });
  }
  hooks.slots = [];
  hooks.mounting = true;
  let shown = providers;
  let tree: ReactNode = null;
  const draw = () => {
    for (let pass = 0; pass < 10; pass++) {
      hooks.next = 0;
      hooks.dirty = false;
      tree = DefaultsByKind({ providers: shown });
      hooks.mounting = false;
      if (!hooks.dirty) return;
    }
    throw new Error('the component kept updating its own state');
  };
  draw();
  await flush();
  draw();

  const all = () => flatten(tree);
  const row = (categoryId: string) => {
    const item = all().find((e) => e.props['data-category-id'] === categoryId);
    if (!item) throw new Error(`no ${categoryId} row`);
    return item;
  };
  const control = (categoryId: string, kind: Control) =>
    flatten(row(categoryId).props.children).find(
      (e) => e.props['aria-label'] === NAME[kind](labelOf(categoryId)),
    );
  const options = (categoryId: string) =>
    flatten(control(categoryId, 'provider')?.props.children).filter((e) => e.type === 'option');
  return {
    text: () => textOf(tree),
    rows: () =>
      all()
        .map((e) => e.props['data-category-id'])
        .filter((id) => id !== undefined),
    rowText: (categoryId: string) => textOf(row(categoryId)),
    rowError: (categoryId: string) =>
      flatten(row(categoryId).props.children).find((e) => e.type === FormError)?.props.message ??
      null,
    errors: () =>
      all()
        .filter((e) => e.type === FormError)
        .map((e) => e.props.message)
        .filter((message) => message),
    control,
    values: (categoryId: string) => options(categoryId).map((e) => e.props.value),
    labels: (categoryId: string) => options(categoryId).map(textOf),
    draw,
    show: (next: AdminIntegrationProvider[]) => {
      shown = next;
      draw();
    },
    choose: async (categoryId: string, value: string) => {
      control(categoryId, 'provider')!.props.onChange!({ target: { value } });
      await flush();
      draw();
    },
    clear: async (categoryId: string) => {
      const button = control(categoryId, 'clear');
      if (!button?.props.onClick) throw new Error(`no Clear button on ${categoryId}`);
      if (!button.props.disabled) button.props.onClick();
      await flush();
      draw();
    },
  };
}

beforeEach(() => {
  Object.values(api).forEach((fn) => fn.mockReset());
  api.saveAdminIntegrationDefault.mockImplementation(
    async (categoryId: string, providerId: string | null) => ({ categoryId, providerId }),
  );
});

describe('the rows of Defaults by kind', () => {
  it('shows one row per category under its label, never its id', async () => {
    const view = await mount();
    expect(view.rows()).toEqual(CORE_INTEGRATION_CATEGORY_SPECS.map((spec) => spec.id));
    for (const spec of CORE_INTEGRATION_CATEGORY_SPECS) {
      expect(view.rowText(spec.id)).toContain(spec.label);
    }
    for (const spec of CORE_INTEGRATION_CATEGORY_SPECS.filter((s) => s.id.includes('-'))) {
      expect(view.text()).not.toContain(spec.id);
    }
  });

  it('offers a row only the enabled providers that serve its category, by name', async () => {
    const view = await mount();
    expect(view.values('forge')).toEqual(['', 'github', 'gitlab']);
    expect(view.labels('forge')).toEqual(['No default', 'GitHub', 'GitLab']);
    expect(view.values('file-storage')).toEqual(['', 'module.acme.docs']);
    expect(view.values('rich-documents')).toEqual(['', 'module.acme.docs']);
  });

  it('has nothing to choose, and says so, where no enabled provider serves the category', async () => {
    const view = await mount();
    expect(view.values('mail')).toEqual(['']);
    expect(view.labels('mail')).toEqual(['No enabled provider']);
    expect(view.control('mail', 'provider')!.props.disabled).toBe(true);
    expect(view.control('forge', 'provider')!.props.disabled).toBe(false);
  });

  it('follows the providers it is given when one is switched off', async () => {
    const view = await mount();
    view.show(PROVIDERS.map((p) => (p.id === 'github' ? { ...p, enabled: false } : p)));
    expect(view.values('forge')).toEqual(['', 'gitlab']);
  });

  it('starts from the saved defaults', async () => {
    const view = await mount(PROVIDERS, {
      defaults: [{ categoryId: 'forge', providerId: 'gitlab' }],
    });
    expect(view.control('forge', 'provider')!.props.value).toBe('gitlab');
    expect(view.control('mail', 'provider')!.props.value).toBe('');
    expect(view.control('forge', 'clear')!.props.disabled).toBe(false);
    expect(view.control('mail', 'clear')!.props.disabled).toBe(true);
  });
});

describe('choosing a default', () => {
  it('sends the chosen provider for that category and nothing else', async () => {
    const view = await mount();
    await view.choose('forge', 'gitlab');
    expect(api.saveAdminIntegrationDefault.mock.calls).toStrictEqual([['forge', 'gitlab']]);
    expect(view.control('forge', 'provider')!.props.value).toBe('gitlab');
    expect(view.control('forge', 'clear')!.props.disabled).toBe(false);
    expect(view.control('rich-documents', 'provider')!.props.value).toBe('');
  });

  it('replaces the default of the category with the next one chosen', async () => {
    const view = await mount(PROVIDERS, {
      defaults: [{ categoryId: 'forge', providerId: 'gitlab' }],
    });
    await view.choose('forge', 'github');
    expect(api.saveAdminIntegrationDefault.mock.calls).toStrictEqual([['forge', 'github']]);
    expect(view.control('forge', 'provider')!.props.value).toBe('github');
  });

  it('shows a refusal on its own row and keeps the saved default', async () => {
    const view = await mount(PROVIDERS, {
      defaults: [{ categoryId: 'forge', providerId: 'gitlab' }],
    });
    api.saveAdminIntegrationDefault.mockRejectedValueOnce(
      refusal('GitHub is not enabled on this server', 409),
    );
    await view.choose('forge', 'github');
    expect(view.rowError('forge')).toBe('GitHub is not enabled on this server');
    expect(view.rowError('rich-documents')).toBeNull();
    expect(view.errors()).toEqual(['GitHub is not enabled on this server']);
    expect(view.control('forge', 'provider')!.props.value).toBe('gitlab');
  });

  it('shows a 400 the same way, and drops it on the next try', async () => {
    const view = await mount();
    api.saveAdminIntegrationDefault.mockRejectedValueOnce(
      refusal('GitLab does not serve this category', 400),
    );
    await view.choose('forge', 'gitlab');
    expect(view.rowError('forge')).toBe('GitLab does not serve this category');
    await view.choose('forge', 'gitlab');
    expect(view.errors()).toEqual([]);
    expect(view.control('forge', 'provider')!.props.value).toBe('gitlab');
  });

  it('holds the controls while a request is out', async () => {
    let finish!: () => void;
    api.saveAdminIntegrationDefault.mockReturnValueOnce(
      new Promise<void>((resolve) => (finish = resolve)),
    );
    const view = await mount();
    view.control('forge', 'provider')!.props.onChange!({ target: { value: 'gitlab' } });
    view.draw();
    expect(view.control('forge', 'provider')!.props.disabled).toBe(true);
    expect(view.control('mail', 'provider')!.props.disabled).toBe(true);
    finish();
    await flush();
    view.draw();
    expect(view.control('forge', 'provider')!.props.disabled).toBe(false);
  });
});

describe('clearing a default', () => {
  it('sends a null provider for that category and empties the row', async () => {
    const view = await mount(PROVIDERS, {
      defaults: [{ categoryId: 'forge', providerId: 'gitlab' }],
    });
    await view.clear('forge');
    expect(api.saveAdminIntegrationDefault.mock.calls).toStrictEqual([['forge', null]]);
    expect(view.control('forge', 'provider')!.props.value).toBe('');
    expect(view.control('forge', 'clear')!.props.disabled).toBe(true);
  });

  it('is not offered while the category has no default', async () => {
    const view = await mount();
    await view.clear('forge');
    expect(api.saveAdminIntegrationDefault).not.toHaveBeenCalled();
  });

  it('can clear a default whose provider is no longer enabled', async () => {
    const view = await mount(
      PROVIDERS.map((p) => (p.id === 'gitlab' ? { ...p, enabled: false } : p)),
      { defaults: [{ categoryId: 'forge', providerId: 'gitlab' }] },
    );
    expect(view.control('forge', 'provider')!.props.value).toBe('');
    await view.clear('forge');
    expect(api.saveAdminIntegrationDefault.mock.calls).toStrictEqual([['forge', null]]);
  });

  it('shows a refusal on its own row and keeps the default', async () => {
    const view = await mount(PROVIDERS, {
      defaults: [{ categoryId: 'forge', providerId: 'gitlab' }],
    });
    api.saveAdminIntegrationDefault.mockRejectedValueOnce(refusal('Could not clear', 500));
    await view.clear('forge');
    expect(view.rowError('forge')).toBe('Could not clear');
    expect(view.control('forge', 'provider')!.props.value).toBe('gitlab');
  });
});

describe('when the defaults cannot load', () => {
  it('shows the failure and no rows', async () => {
    const view = await mount(PROVIDERS, { loadError: 'Failed to load' });
    expect(view.errors()).toEqual(['Failed to load']);
    expect(view.rows()).toEqual([]);
  });
});
