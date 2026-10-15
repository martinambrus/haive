import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { Button, FormError } from '@/components/ui';
import type { IntegrationConnection, IntegrationProvider } from '@/lib/integrations';
import { RepositoryIntegrations } from './repository-integrations';

// No DOM in this package: hooks run on a plain slot list, as in repos/[id]/tooling/page.test.tsx.
const hooks = vi.hoisted(() => ({ slots: [] as unknown[], next: 0, dirty: false, mounting: true }));
const api = vi.hoisted(() => ({
  getRepositoryIntegrations: vi.fn(),
  saveRepositoryIntegrations: vi.fn(),
  listIntegrationProviders: vi.fn(),
  listIntegrationConnections: vi.fn(),
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
  id?: string;
  checked?: boolean;
  disabled?: boolean;
  message?: string | null;
  role?: string;
  onClick?: () => void;
  onChange?: (event: { target: { checked: boolean } }) => void;
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

const provider = (id: string, displayName: string): IntegrationProvider => ({
  id,
  displayName,
  categories: ['forge'],
  selfHosted: false,
  enabled: true,
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
  provider('github', 'GitHub'),
  provider('gitlab', 'GitLab'),
  provider('module.acme.docs', 'Acme Docs'),
];
const CONNECTIONS = [
  connection('c-gitlab-1', 'gitlab', 'work'),
  connection('c-github-1', 'github', 'octocat'),
  connection('c-gitlab-2', 'gitlab', 'personal'),
  connection('c-docs-1', 'module.acme.docs', 'docs@acme.test'),
];
const SWITCH = 'integrationsRestricted';
const NO_ACCOUNT = 'Nothing is ticked, so tasks of this repository can use no account.';
const refusal = (message: string, status: number) => Object.assign(new Error(message), { status });

interface Setup {
  restricted?: boolean;
  connectionIds?: string[];
  connections?: IntegrationConnection[];
  loadError?: string;
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

async function mount(setup: Setup = {}) {
  if (setup.loadError) {
    api.getRepositoryIntegrations.mockRejectedValue(refusal(setup.loadError, 404));
  } else {
    api.getRepositoryIntegrations.mockResolvedValue({
      restricted: setup.restricted ?? false,
      connectionIds: setup.connectionIds ?? [],
    });
  }
  api.listIntegrationProviders.mockResolvedValue({ providers: PROVIDERS });
  api.listIntegrationConnections.mockResolvedValue({
    connections: setup.connections ?? CONNECTIONS,
  });
  hooks.slots = [];
  hooks.mounting = true;
  let tree: ReactNode = null;
  const draw = () => {
    for (let pass = 0; pass < 10; pass++) {
      hooks.next = 0;
      hooks.dirty = false;
      tree = RepositoryIntegrations({ repositoryId: 'repo-1' });
      hooks.mounting = false;
      if (!hooks.dirty) return;
    }
    throw new Error('the component kept updating its own state');
  };
  draw();
  await flush();
  draw();

  const all = () => flatten(tree);
  const field = (id: string) => all().find((e) => e.props.id === id);
  const save = () => all().find((e) => e.type === Button);
  return {
    draw,
    text: () => textOf(tree),
    field,
    groups: () =>
      all()
        .filter((e) => e.type === 'fieldset')
        .map((group) => ({
          provider: textOf(flatten(group.props.children).find((e) => e.type === 'legend')),
          accounts: flatten(group.props.children)
            .filter((e) => e.type === 'label')
            .map(textOf),
        })),
    ticked: () =>
      all()
        .filter((e) => e.type === 'input' && e.props.id?.startsWith('allow-'))
        .filter((e) => e.props.checked)
        .map((e) => e.props.id),
    errors: () =>
      all()
        .filter((e) => e.type === FormError)
        .map((e) => e.props.message)
        .filter((message) => message),
    notice: () => all().find((e) => e.props.role === 'status'),
    save,
    tick: (connectionId: string, checked: boolean) => {
      field(`allow-${connectionId}`)!.props.onChange!({ target: { checked } });
      draw();
    },
    restrict: (checked: boolean) => {
      field(SWITCH)!.props.onChange!({ target: { checked } });
      draw();
    },
    submit: async () => {
      if (!save()!.props.disabled) save()!.props.onClick!();
      await flush();
      draw();
    },
  };
}

beforeEach(() => {
  Object.values(api).forEach((fn) => fn.mockReset());
  api.saveRepositoryIntegrations.mockImplementation(
    async (_repositoryId: string, body: object) => body,
  );
});

describe('the Integrations section of a repository', () => {
  it("reads this repository's allow-list and the owner's providers and accounts", async () => {
    await mount();
    expect(api.getRepositoryIntegrations.mock.calls).toStrictEqual([['repo-1']]);
    expect(api.listIntegrationConnections).toHaveBeenCalledTimes(1);
  });

  it("lists the owner's accounts under their provider names, never the provider ids", async () => {
    const view = await mount({ restricted: true });
    expect(view.groups()).toEqual([
      { provider: 'GitLab', accounts: ['work', 'personal'] },
      { provider: 'GitHub', accounts: ['octocat'] },
      { provider: 'Acme Docs', accounts: ['docs@acme.test'] },
    ]);
    expect(view.text()).not.toContain('module.acme.docs');
  });

  it('starts from the saved switch and ticks', async () => {
    const view = await mount({ restricted: true, connectionIds: ['c-gitlab-2', 'c-docs-1'] });
    expect(view.field(SWITCH)!.props.checked).toBe(true);
    expect(view.ticked()).toEqual(['allow-c-gitlab-2', 'allow-c-docs-1']);
  });

  it('lists the accounts only while the switch is on', async () => {
    const view = await mount();
    expect(view.field(SWITCH)!.props.checked).toBe(false);
    expect(view.groups()).toEqual([]);
    view.restrict(true);
    expect(view.groups()).toHaveLength(3);
    view.restrict(false);
    expect(view.groups()).toEqual([]);
  });
});

describe('the warning for an empty allow-list', () => {
  it('says plainly that no account can be used when the switch is on and nothing is ticked', async () => {
    const view = await mount();
    expect(view.text()).not.toContain(NO_ACCOUNT);
    view.restrict(true);
    expect(view.text()).toContain(NO_ACCOUNT);
  });

  it('goes once an account is ticked, and comes back when it is unticked', async () => {
    const view = await mount({ restricted: true });
    view.tick('c-gitlab-1', true);
    expect(view.text()).not.toContain(NO_ACCOUNT);
    view.tick('c-gitlab-1', false);
    expect(view.text()).toContain(NO_ACCOUNT);
  });

  it('is not shown while the switch is off, whatever is ticked', async () => {
    const view = await mount({ restricted: false, connectionIds: [] });
    expect(view.text()).not.toContain(NO_ACCOUNT);
  });

  it('holds where the owner has no account at all, and says there is none', async () => {
    const view = await mount({ restricted: true, connections: [] });
    expect(view.text()).toContain('no connected accounts');
    expect(view.text()).toContain(NO_ACCOUNT);
    expect(view.groups()).toEqual([]);
  });
});

describe('saving the allow-list', () => {
  it('sends exactly restricted and the ticked account ids, in the order of the list', async () => {
    const view = await mount();
    view.restrict(true);
    view.tick('c-gitlab-2', true);
    view.tick('c-gitlab-1', true);
    await view.submit();
    expect(api.saveRepositoryIntegrations.mock.calls).toStrictEqual([
      ['repo-1', { restricted: true, connectionIds: ['c-gitlab-1', 'c-gitlab-2'] }],
    ]);
  });

  it('sends an empty list when the switch is on and nothing is ticked', async () => {
    const view = await mount();
    view.restrict(true);
    await view.submit();
    expect(api.saveRepositoryIntegrations.mock.calls).toStrictEqual([
      ['repo-1', { restricted: true, connectionIds: [] }],
    ]);
  });

  it('keeps the ticks when the switch is turned off, so they are there when it comes back on', async () => {
    const view = await mount({ restricted: true, connectionIds: ['c-github-1'] });
    view.restrict(false);
    await view.submit();
    expect(api.saveRepositoryIntegrations.mock.calls).toStrictEqual([
      ['repo-1', { restricted: false, connectionIds: ['c-github-1'] }],
    ]);
  });

  it('says it is saved, until the next change', async () => {
    const view = await mount();
    expect(view.notice()).toBeUndefined();
    view.restrict(true);
    await view.submit();
    expect(textOf(view.notice())).toBe('Saved.');
    view.tick('c-gitlab-1', true);
    expect(view.notice()).toBeUndefined();
  });

  it('shows a refusal, and does not say it is saved', async () => {
    const view = await mount({ restricted: true });
    api.saveRepositoryIntegrations.mockRejectedValueOnce(refusal('Connection not found', 404));
    view.tick('c-gitlab-1', true);
    await view.submit();
    expect(view.errors()).toEqual(['Connection not found']);
    expect(view.notice()).toBeUndefined();
  });

  it('holds the button while a request is out', async () => {
    let finish!: () => void;
    api.saveRepositoryIntegrations.mockReturnValueOnce(
      new Promise<void>((resolve) => (finish = resolve)),
    );
    const view = await mount();
    view.save()!.props.onClick!();
    view.draw();
    expect(view.save()!.props.disabled).toBe(true);
    finish();
    await flush();
    view.draw();
    expect(view.save()!.props.disabled).toBe(false);
  });
});

describe('when the allow-list cannot load', () => {
  it('shows the failure and nothing to change', async () => {
    const view = await mount({ loadError: 'Repository not found' });
    expect(view.errors()).toEqual(['Repository not found']);
    expect(view.field(SWITCH)).toBeUndefined();
    expect(view.save()).toBeUndefined();
  });
});
