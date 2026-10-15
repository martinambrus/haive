import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { CORE_INTEGRATION_CATEGORY_SPECS } from '@haive/shared/modularity';
import { FormError } from '@/components/ui';
import type { IntegrationConnection, IntegrationProvider } from '@/lib/integrations';
import { PreferredByKind } from './preferred-by-kind';

// No DOM in this package: hooks run on a plain slot list, as in repos/[id]/tooling/page.test.tsx.
const hooks = vi.hoisted(() => ({ slots: [] as unknown[], next: 0, dirty: false, mounting: true }));
const api = vi.hoisted(() => ({
  listIntegrationProviders: vi.fn(),
  listIntegrationConnections: vi.fn(),
  listIntegrationPreferences: vi.fn(),
  listIntegrationDefaults: vi.fn(),
  saveIntegrationPreference: vi.fn(),
  clearIntegrationPreference: vi.fn(),
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
  displayName: string,
  categories: string[],
  enabled = true,
): IntegrationProvider => ({
  id,
  displayName,
  categories,
  selfHosted: false,
  enabled,
  writeEnabled: false,
  canWrite: true,
  writeScopes: {},
  connect: [],
});

const connection = (
  id: string,
  providerId: string,
  accountLabel: string,
): IntegrationConnection => ({
  id,
  providerId,
  accountLabel,
  authMethod: 'oauth2',
  grantedScopes: [],
  status: 'connected',
  lastError: null,
  repoCredentialId: null,
  expiresAt: null,
  createdAt: '2026-10-14T10:00:00.000Z',
  updatedAt: '2026-10-14T10:00:00.000Z',
});

const PROVIDERS = [
  provider('github', 'GitHub', ['forge']),
  provider('gitlab', 'GitLab', ['forge']),
  provider('gitea', 'Gitea', ['forge'], false),
  provider('module.acme.docs', 'Acme Docs', ['rich-documents', 'file-storage']),
];
const CONNECTIONS = [
  connection('c-gitlab-1', 'gitlab', 'work'),
  connection('c-gitlab-2', 'gitlab', 'personal'),
  connection('c-github-1', 'github', 'octocat'),
];
const GITLAB_WORK = { categoryId: 'forge', providerId: 'gitlab', connectionId: 'c-gitlab-1' };
const FORGE_ERROR = 'GitLab does not serve this category';

const NAME = {
  provider: (label: string) => `${label} provider`,
  account: (label: string) => `${label} account`,
  save: (label: string) => `Save ${label}`,
  clear: (label: string) => `Clear ${label}`,
};
type Control = keyof typeof NAME;
const labelOf = (categoryId: string) =>
  CORE_INTEGRATION_CATEGORY_SPECS.find((spec) => spec.id === categoryId)!.label;
const refusal = (message: string, status: number) => Object.assign(new Error(message), { status });

interface Setup {
  providers?: IntegrationProvider[];
  connections?: IntegrationConnection[];
  preferences?: { categoryId: string; providerId: string; connectionId: string | null }[];
  defaults?: { categoryId: string; providerId: string }[];
  loadError?: string;
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

async function mount(setup: Setup = {}) {
  if (setup.loadError) {
    api.listIntegrationProviders.mockRejectedValue(refusal(setup.loadError, 500));
  } else {
    api.listIntegrationProviders.mockResolvedValue({ providers: setup.providers ?? PROVIDERS });
  }
  api.listIntegrationConnections.mockResolvedValue({
    connections: setup.connections ?? CONNECTIONS,
  });
  api.listIntegrationPreferences.mockResolvedValue({ preferences: setup.preferences ?? [] });
  api.listIntegrationDefaults.mockResolvedValue({ defaults: setup.defaults ?? [] });
  hooks.slots = [];
  hooks.mounting = true;
  let tree: ReactNode = null;
  const draw = () => {
    for (let pass = 0; pass < 10; pass++) {
      hooks.next = 0;
      hooks.dirty = false;
      tree = PreferredByKind();
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
  const options = (categoryId: string, kind: Control) =>
    flatten(control(categoryId, kind)?.props.children).filter((e) => e.type === 'option');
  return {
    draw,
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
    values: (categoryId: string, kind: Control) =>
      options(categoryId, kind).map((e) => e.props.value),
    labels: (categoryId: string, kind: Control) => options(categoryId, kind).map(textOf),
    choose: (categoryId: string, kind: Control, value: string) => {
      control(categoryId, kind)!.props.onChange!({ target: { value } });
      draw();
    },
    press: async (categoryId: string, kind: Control) => {
      const button = control(categoryId, kind);
      if (!button?.props.onClick) throw new Error(`no ${kind} button on ${categoryId}`);
      if (!button.props.disabled) button.props.onClick();
      await flush();
      draw();
    },
  };
}

beforeEach(() => {
  Object.values(api).forEach((fn) => fn.mockReset());
  api.saveIntegrationPreference.mockImplementation(async (categoryId: string, body: object) => ({
    categoryId,
    ...body,
  }));
  api.clearIntegrationPreference.mockResolvedValue({ ok: true });
});

describe('the rows of Preferred by kind', () => {
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
    expect(view.values('forge', 'provider')).toEqual(['', 'github', 'gitlab']);
    expect(view.labels('forge', 'provider')).toEqual(['Choose a provider', 'GitHub', 'GitLab']);
    expect(view.values('file-storage', 'provider')).toEqual(['', 'module.acme.docs']);
    expect(view.values('rich-documents', 'provider')).toEqual(['', 'module.acme.docs']);
  });

  it('has nothing to choose, and says so, where no enabled provider serves the category', async () => {
    const view = await mount();
    expect(view.values('mail', 'provider')).toEqual(['']);
    expect(view.labels('mail', 'provider')).toEqual(['No enabled provider']);
    expect(view.control('mail', 'provider')!.props.disabled).toBe(true);
    expect(view.control('forge', 'provider')!.props.disabled).toBe(false);
  });

  it("offers only the chosen provider's accounts, after Any account", async () => {
    const view = await mount();
    expect(view.control('forge', 'account')).toBeUndefined();
    view.choose('forge', 'provider', 'gitlab');
    expect(view.values('forge', 'account')).toEqual(['', 'c-gitlab-1', 'c-gitlab-2']);
    expect(view.labels('forge', 'account')).toEqual(['Any account', 'work', 'personal']);
    view.choose('forge', 'provider', 'github');
    expect(view.values('forge', 'account')).toEqual(['', 'c-github-1']);
    view.choose('forge', 'provider', '');
    expect(view.control('forge', 'account')).toBeUndefined();
  });

  it('starts from the saved choice', async () => {
    const view = await mount({ preferences: [GITLAB_WORK] });
    expect(view.control('forge', 'provider')!.props.value).toBe('gitlab');
    expect(view.control('forge', 'account')!.props.value).toBe('c-gitlab-1');
    expect(view.control('mail', 'provider')!.props.value).toBe('');
  });
});

describe('what the row says about the choice', () => {
  it('names the install default as the fallback while the user has chosen nothing', async () => {
    const view = await mount({ defaults: [{ categoryId: 'forge', providerId: 'github' }] });
    expect(view.rowText('forge')).toContain('the install default applies: GitHub.');
    expect(view.rowText('forge')).not.toContain('Your choice');
    expect(view.rowText('mail')).not.toContain('install default applies');
  });

  it('says there is no default either, where there is none', async () => {
    const view = await mount();
    expect(view.rowText('forge')).toContain('no install default');
  });

  it('states the user choice instead of the default once there is one', async () => {
    const view = await mount({
      preferences: [GITLAB_WORK],
      defaults: [{ categoryId: 'forge', providerId: 'github' }],
    });
    expect(view.rowText('forge')).toContain('Your choice: GitLab, account work.');
    expect(view.rowText('forge')).not.toContain('install default');
  });

  it('says any account where the choice names none', async () => {
    const view = await mount({
      preferences: [{ ...GITLAB_WORK, connectionId: null }],
    });
    expect(view.rowText('forge')).toContain('Your choice: GitLab, any account.');
  });

  it('still states a choice whose provider is no longer enabled, and lets it be cleared', async () => {
    const view = await mount({
      providers: PROVIDERS.map((p) => (p.id === 'gitlab' ? { ...p, enabled: false } : p)),
      preferences: [GITLAB_WORK],
    });
    expect(view.rowText('forge')).toContain('Your choice: GitLab');
    expect(view.control('forge', 'provider')!.props.value).toBe('');
    expect(view.control('forge', 'clear')!.props.disabled).toBe(false);
    await view.press('forge', 'clear');
    expect(api.clearIntegrationPreference.mock.calls).toStrictEqual([['forge']]);
  });
});

describe('saving a row', () => {
  it('sends exactly the chosen provider and account to that category', async () => {
    const view = await mount();
    view.choose('forge', 'provider', 'gitlab');
    view.choose('forge', 'account', 'c-gitlab-2');
    await view.press('forge', 'save');
    expect(api.saveIntegrationPreference.mock.calls).toStrictEqual([
      ['forge', { providerId: 'gitlab', connectionId: 'c-gitlab-2' }],
    ]);
  });

  it('sends no account, as null and not an empty string, for Any account', async () => {
    const view = await mount();
    view.choose('forge', 'provider', 'github');
    await view.press('forge', 'save');
    expect(api.saveIntegrationPreference.mock.calls).toStrictEqual([
      ['forge', { providerId: 'github', connectionId: null }],
    ]);
  });

  it('drops the account when the provider changes, so an account never travels to another provider', async () => {
    const view = await mount();
    view.choose('forge', 'provider', 'gitlab');
    view.choose('forge', 'account', 'c-gitlab-1');
    view.choose('forge', 'provider', 'github');
    expect(view.control('forge', 'account')!.props.value).toBe('');
    await view.press('forge', 'save');
    expect(api.saveIntegrationPreference.mock.calls).toStrictEqual([
      ['forge', { providerId: 'github', connectionId: null }],
    ]);
  });

  it('sends nothing before a provider is chosen', async () => {
    const view = await mount();
    expect(view.control('forge', 'save')!.props.disabled).toBe(true);
    await view.press('forge', 'save');
    expect(api.saveIntegrationPreference).not.toHaveBeenCalled();
  });

  it('holds every control while a request is out', async () => {
    let finish!: () => void;
    api.saveIntegrationPreference.mockReturnValueOnce(
      new Promise<void>((resolve) => (finish = resolve)),
    );
    const view = await mount();
    view.choose('forge', 'provider', 'gitlab');
    view.control('forge', 'save')!.props.onClick!();
    view.draw();
    expect(view.control('forge', 'save')!.props.disabled).toBe(true);
    expect(view.control('forge', 'provider')!.props.disabled).toBe(true);
    expect(view.control('rich-documents', 'provider')!.props.disabled).toBe(true);
    finish();
    await flush();
    view.draw();
    expect(view.control('forge', 'save')!.props.disabled).toBe(false);
  });

  it('states the saved choice afterwards, and only on its own row', async () => {
    const view = await mount({ defaults: [{ categoryId: 'forge', providerId: 'github' }] });
    view.choose('forge', 'provider', 'gitlab');
    view.choose('forge', 'account', 'c-gitlab-2');
    await view.press('forge', 'save');
    expect(view.rowText('forge')).toContain('Your choice: GitLab, account personal.');
    expect(view.rowText('forge')).not.toContain('install default');
    expect(view.rowText('rich-documents')).not.toContain('Your choice');
    expect(view.control('forge', 'clear')!.props.disabled).toBe(false);
  });

  it('shows a refusal on its own row, saves nothing, and drops the message on the next try', async () => {
    const view = await mount();
    api.saveIntegrationPreference.mockRejectedValueOnce(refusal(FORGE_ERROR, 400));
    view.choose('forge', 'provider', 'gitlab');
    await view.press('forge', 'save');
    expect(view.rowError('forge')).toBe(FORGE_ERROR);
    expect(view.rowError('rich-documents')).toBeNull();
    expect(view.errors()).toEqual([FORGE_ERROR]);
    expect(view.rowText('forge')).not.toContain('Your choice');
    await view.press('forge', 'save');
    expect(view.errors()).toEqual([]);
    expect(view.rowText('forge')).toContain('Your choice: GitLab, any account.');
  });

  it('shows a 409 from a provider that is not enabled the same way', async () => {
    const view = await mount();
    api.saveIntegrationPreference.mockRejectedValueOnce(
      refusal('GitLab is not enabled on this server', 409),
    );
    view.choose('forge', 'provider', 'gitlab');
    await view.press('forge', 'save');
    expect(view.rowError('forge')).toBe('GitLab is not enabled on this server');
  });
});

describe('clearing a row', () => {
  it('sends the DELETE for that category and puts the row back to the fallback', async () => {
    const view = await mount({
      preferences: [GITLAB_WORK],
      defaults: [{ categoryId: 'forge', providerId: 'github' }],
    });
    await view.press('forge', 'clear');
    expect(api.clearIntegrationPreference.mock.calls).toStrictEqual([['forge']]);
    expect(view.rowText('forge')).not.toContain('Your choice');
    expect(view.rowText('forge')).toContain('the install default applies: GitHub.');
    expect(view.control('forge', 'provider')!.props.value).toBe('');
    expect(view.control('forge', 'account')).toBeUndefined();
    expect(view.control('forge', 'clear')!.props.disabled).toBe(true);
  });

  it('is not offered while nothing is saved', async () => {
    const view = await mount();
    view.choose('forge', 'provider', 'gitlab');
    expect(view.control('forge', 'clear')!.props.disabled).toBe(true);
    await view.press('forge', 'clear');
    expect(api.clearIntegrationPreference).not.toHaveBeenCalled();
  });

  it('shows a refusal on its own row and keeps the saved choice', async () => {
    const view = await mount({ preferences: [GITLAB_WORK] });
    api.clearIntegrationPreference.mockRejectedValueOnce(refusal('Could not clear', 500));
    await view.press('forge', 'clear');
    expect(view.rowError('forge')).toBe('Could not clear');
    expect(view.rowText('forge')).toContain('Your choice: GitLab, account work.');
  });
});

describe('when the page cannot load', () => {
  it('shows the failure and no rows', async () => {
    const view = await mount({ loadError: 'Failed to load' });
    expect(view.errors()).toEqual(['Failed to load']);
    expect(view.rows()).toEqual([]);
  });
});
