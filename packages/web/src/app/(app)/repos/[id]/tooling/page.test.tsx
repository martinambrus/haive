import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { DEFAULT_AGENT_RULES } from '@haive/shared/constants';
import { Dialog } from '@/components/dialog';
import { Button, FormError } from '@/components/ui';
import { InlineMarkdown } from '@/components/markdown/inline-markdown';
import { MarkdownEditor } from '@/components/markdown/markdown-editor';
import { MarkdownView } from '@/components/markdown/markdown-view';
import { RepositoryIntegrations } from '@/components/integrations/repository-integrations';
import RepoToolingPage from './page';

const TYPED_PASSWORD = crypto.randomUUID();

// No DOM in this package: the page's hooks run on a plain slot list, as in components/task-type-editor.test.tsx.
const hooks = vi.hoisted(() => ({ slots: [] as unknown[], next: 0, dirty: false, mounting: true }));
const api = vi.hoisted(() => ({ get: vi.fn(), patch: vi.fn() }));

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
vi.mock('next/navigation', () => ({ useParams: () => ({ id: 'repo-1' }) }));
vi.mock('@/lib/use-page-title', () => ({ usePageTitle: () => {} }));
vi.mock('@/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-client')>()),
  api,
  requestCheckoutSync: vi.fn().mockResolvedValue(undefined),
}));

type El = ReactElement<{
  children?: ReactNode;
  id?: string;
  value?: string;
  placeholder?: string;
  checked?: boolean;
  disabled?: boolean;
  open?: boolean;
  message?: string | null;
  repositoryId?: string;
  body?: string;
  className?: string;
  onClick?: () => void;
  onChange?: (event: { target: { value?: string; checked?: boolean } }) => void;
  onOpenChange?: (open: boolean) => void;
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

const TOOLING_PATH = '/repositories/repo-1/tooling';
const CONFIG_PATH = '/repositories/repo-1/tooling-config';
const CLEAR = 'Clear stored credentials';
const CONFIRM = 'Clear credentials';
const STORED_NOTE = 'Credentials are stored. Leave both blank to keep them; type to replace.';
const UNSTORED_NOTE =
  "Credentials are stored encrypted, separately from this repository's settings.";
const STORED_HINT = '•••••• (stored)';
const APP_AUTH = {
  enabled: true,
  loginUrl: 'https://app.test/login',
  usernameSelector: '#email',
  passwordSelector: '#password',
  submitSelector: 'button[type="submit"]',
  successCondition: { type: 'url_contains', value: '/dashboard' },
};
const stored = (username: boolean, password: boolean) => ({
  appAuthUsernameSet: username,
  appAuthPasswordSet: password,
  appAuthCredentialsSet: username && password,
});
const CONFIG = {
  repositoryId: 'repo-1',
  rtkEnabled: false,
  rtkVersion: null,
  rtkVersions: [],
  chromeDevtoolsMcpVersion: null,
  chromeVersions: [],
  browserTesting: false,
  lspServers: [],
  lspServerVersions: {},
  secretMaskEnabled: true,
  secretMaskAllow: [],
  secretMaskDenyExtend: [],
  appAuth: APP_AUTH,
  ...stored(true, true),
  prWorkflowEnabled: false,
  stepGuidanceEnabled: true,
  stepGuidance: [],
  lspOptions: [],
  reviewDimensions: ['security'],
  reviewDimensionOptions: [],
  ragEmbedDegradedAt: null,
  ragEmbedDegradedReason: null,
  ragEmbedLexicalOnly: false,
  pendingRepoMcpServers: null,
  agentRulesOverride: null,
};

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

async function mount(config: Record<string, unknown> = {}) {
  api.get.mockResolvedValue({ ...CONFIG, ...config });
  hooks.slots = [];
  hooks.mounting = true;
  let tree: ReactNode = null;
  const draw = () => {
    for (let pass = 0; pass < 10; pass++) {
      hooks.next = 0;
      hooks.dirty = false;
      tree = RepoToolingPage();
      hooks.mounting = false;
      if (!hooks.dirty) return;
    }
    throw new Error('the page kept updating its own state');
  };
  draw();
  await flush();
  draw();

  const all = () => flatten(tree);
  const dialog = () => all().find((e) => e.type === Dialog);
  const integrations = () => all().find((e) => e.type === RepositoryIntegrations);
  const button = (name: string) => all().find((e) => e.type === Button && textOf(e) === name);
  const field = (id: string) => {
    const el = all().find((e) => e.props.id === id);
    if (!el) throw new Error(`no #${id} field`);
    return el;
  };
  return {
    draw,
    all,
    button,
    field,
    dialog,
    integrations,
    dialogError: () =>
      flatten(dialog()?.props.children).find((e) => e.type === FormError)?.props.message ?? null,
    text: () => textOf(tree),
    error: () => all().find((e) => e.type === FormError)?.props.message ?? null,
    press: async (name: string) => {
      const target = button(name);
      if (!target?.props.onClick) throw new Error(`no "${name}" button to press`);
      if (!target.props.disabled) target.props.onClick();
      await flush();
      draw();
    },
    enter: (id: string, value: string) => {
      field(id).props.onChange!({ target: { value } });
      draw();
    },
    tick: (id: string, checked: boolean) => {
      field(id).props.onChange!({ target: { checked } });
      draw();
    },
  };
}

const lastBody = () => api.patch.mock.calls.at(-1)![1] as Record<string, unknown>;
const credentialFields = (body: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(body).filter(([key]) => key === 'appAuthUsername' || key === 'appAuthPassword'),
  );

beforeEach(() => {
  api.get.mockReset();
  api.patch.mockReset();
  api.patch.mockResolvedValue({ ok: true });
});

describe('the clear control on the tooling page', () => {
  it.each([
    ['both fields', stored(true, true)],
    ['the username alone', stored(true, false)],
    ['the password alone', stored(false, true)],
  ])('is offered when %s is stored', async (_what, config) => {
    expect((await mount(config)).button(CLEAR)).toBeDefined();
  });

  it('is not offered when nothing is stored', async () => {
    expect((await mount(stored(false, false))).button(CLEAR)).toBeUndefined();
  });

  it.each([
    ['switched off', { ...APP_AUTH, enabled: false }],
    ['never configured', null],
  ])('stays usable while app login is %s', async (_state, appAuth) => {
    const view = await mount({ appAuth });
    expect(view.field('appAuthUsername').props.disabled).toBe(true);
    expect(view.button(CLEAR)).toBeDefined();
    expect(view.button(CLEAR)!.props.disabled).toBeFalsy();
  });

  it('appears once credentials have been saved from a page that had none', async () => {
    const view = await mount(stored(false, false));
    view.enter('appAuthUsername', 'ci-user');
    view.enter('appAuthPassword', TYPED_PASSWORD);
    await view.press('Save tooling');
    expect(view.button(CLEAR)).toBeDefined();
  });

  it('opens a confirmation that names what is removed, and sends nothing yet', async () => {
    const view = await mount();
    expect(view.dialog()?.props.open).toBe(false);
    await view.press(CLEAR);
    expect(view.dialog()?.props.open).toBe(true);
    expect(view.text()).toContain(
      "Remove the stored username and password for this repository's app login? Runs that need them will fail to log in until you enter new ones.",
    );
    expect(api.patch).not.toHaveBeenCalled();
  });

  it('sends nothing and keeps the credentials on Cancel', async () => {
    const view = await mount();
    await view.press(CLEAR);
    await view.press('Cancel');
    expect(api.patch).not.toHaveBeenCalled();
    expect(view.dialog()?.props.open).toBe(false);
    expect(view.button(CLEAR)).toBeDefined();
    expect(view.text()).toContain(STORED_NOTE);
  });

  it('sends nothing when the dialog is dismissed with Escape or a click outside it', async () => {
    const view = await mount();
    await view.press(CLEAR);
    view.dialog()!.props.onOpenChange!(false);
    view.draw();
    expect(api.patch).not.toHaveBeenCalled();
    expect(view.dialog()?.props.open).toBe(false);
  });
});

describe('confirming the clear', () => {
  it('sends exactly the two blank credential fields to the tooling PATCH', async () => {
    const view = await mount();
    await view.press(CLEAR);
    await view.press(CONFIRM);
    expect(api.patch).toHaveBeenCalledTimes(1);
    expect(api.patch.mock.calls[0]![0]).toBe(TOOLING_PATH);
    expect(api.patch.mock.calls[0]![1]).toStrictEqual({ appAuthUsername: '', appAuthPassword: '' });
  });

  it.each([
    ['the username alone', stored(true, false)],
    ['the password alone', stored(false, true)],
  ])('clears a credential with %s stored, with the same two blanks', async (_what, config) => {
    const view = await mount(config);
    await view.press(CLEAR);
    await view.press(CONFIRM);
    expect(api.patch.mock.calls[0]![1]).toStrictEqual({ appAuthUsername: '', appAuthPassword: '' });
    expect(view.button(CLEAR)).toBeUndefined();
    expect(view.text()).toContain(UNSTORED_NOTE);
  });

  it('then reads as having no credentials and empties both inputs', async () => {
    const view = await mount();
    view.enter('appAuthUsername', 'typed-user');
    view.enter('appAuthPassword', 'typed-pass');
    await view.press(CLEAR);
    await view.press(CONFIRM);
    expect(view.button(CLEAR)).toBeUndefined();
    expect(view.dialog()).toBeUndefined();
    expect(view.field('appAuthUsername').props.value).toBe('');
    expect(view.field('appAuthPassword').props.value).toBe('');
    expect(view.text()).toContain(UNSTORED_NOTE);
    expect(view.text()).not.toContain(STORED_NOTE);
    expect(view.error()).toBeNull();
  });

  it('neither saves nor discards the rest of the form', async () => {
    const view = await mount();
    view.tick('rtkEnabled', true);
    view.enter('appAuthLoginUrl', 'https://app.test/other');
    await view.press(CLEAR);
    await view.press(CONFIRM);
    expect(api.patch).toHaveBeenCalledTimes(1);
    expect(Object.keys(lastBody())).toEqual(['appAuthUsername', 'appAuthPassword']);
    expect(api.get).toHaveBeenCalledTimes(1);
    expect(view.field('rtkEnabled').props.checked).toBe(true);
    expect(view.field('appAuthLoginUrl').props.value).toBe('https://app.test/other');
  });

  it('holds the dialog while the request is out, and sends it once', async () => {
    let finish!: () => void;
    api.patch.mockReturnValueOnce(new Promise<void>((resolve) => (finish = resolve)));
    const view = await mount();
    await view.press(CLEAR);
    view.button(CONFIRM)!.props.onClick!();
    view.draw();
    expect(view.button('Clearing...')?.props.disabled).toBe(true);
    expect(view.button('Cancel')?.props.disabled).toBe(true);
    view.dialog()!.props.onOpenChange!(false);
    view.draw();
    expect(view.dialog()!.props.open).toBe(true);
    view.button('Clearing...')!.props.onClick!();
    expect(api.patch).toHaveBeenCalledTimes(1);
    finish();
    await flush();
    view.draw();
    expect(view.button(CLEAR)).toBeUndefined();
  });

  it('closes the dialog, and it stays closed when credentials are stored again', async () => {
    const view = await mount();
    await view.press(CLEAR);
    await view.press(CONFIRM);
    view.enter('appAuthUsername', 'new-user');
    view.enter('appAuthPassword', 'new-pass');
    await view.press('Save tooling');
    expect(view.button(CLEAR)).toBeDefined();
    expect(view.dialog()?.props.open).toBe(false);
  });

  it('keeps the dialog open with the error inside it, and changes nothing else, when the request fails', async () => {
    api.patch.mockRejectedValueOnce(new Error('The server said no'));
    const view = await mount();
    view.enter('appAuthUsername', 'typed-user');
    await view.press(CLEAR);
    await view.press(CONFIRM);
    expect(view.dialog()?.props.open).toBe(true);
    expect(view.dialogError()).toBe('The server said no');
    expect(view.error()).toBeNull();
    expect(view.button(CONFIRM)?.props.disabled).toBeFalsy();
    expect(view.button('Cancel')?.props.disabled).toBeFalsy();
    expect(view.button(CLEAR)).toBeDefined();
    expect(view.text()).toContain(STORED_NOTE);
    expect(view.field('appAuthUsername').props.value).toBe('typed-user');
  });

  it('leaves the page error line to the page: a failed Save lands there, a failed clear does not', async () => {
    const view = await mount();
    api.patch.mockRejectedValueOnce(new Error('Save failed'));
    await view.press('Save tooling');
    expect(view.error()).toBe('Save failed');
    api.patch.mockRejectedValueOnce(new Error('The server said no'));
    await view.press(CLEAR);
    await view.press(CONFIRM);
    expect(view.error()).toBe('Save failed');
    expect(view.dialogError()).toBe('The server said no');
  });

  it('can be confirmed again after a failure, and then closes', async () => {
    api.patch.mockRejectedValueOnce(new Error('The server said no'));
    const view = await mount();
    await view.press(CLEAR);
    await view.press(CONFIRM);
    await view.press(CONFIRM);
    expect(api.patch).toHaveBeenCalledTimes(2);
    expect(view.button(CLEAR)).toBeUndefined();
    expect(view.error()).toBeNull();
    expect(view.dialogError()).toBeNull();
  });

  it('does not show the last failure when the dialog is opened again', async () => {
    api.patch.mockRejectedValueOnce(new Error('The server said no'));
    const view = await mount();
    await view.press(CLEAR);
    await view.press(CONFIRM);
    await view.press('Cancel');
    expect(view.dialog()?.props.open).toBe(false);
    await view.press(CLEAR);
    expect(view.dialog()?.props.open).toBe(true);
    expect(view.dialogError()).toBeNull();
  });

  it('does not show the last failure while the next attempt is out', async () => {
    let finish!: () => void;
    api.patch.mockRejectedValueOnce(new Error('The server said no'));
    api.patch.mockReturnValueOnce(new Promise<void>((resolve) => (finish = resolve)));
    const view = await mount();
    await view.press(CLEAR);
    await view.press(CONFIRM);
    expect(view.dialogError()).toBe('The server said no');
    view.button(CONFIRM)!.props.onClick!();
    view.draw();
    expect(view.dialogError()).toBeNull();
    finish();
    await flush();
    view.draw();
    expect(view.button(CLEAR)).toBeUndefined();
  });
});

describe('what the page says is stored after a save', () => {
  it.each([
    ['the username alone', { appAuthUsername: 'ci-user' }],
    ['the password alone', { appAuthPassword: TYPED_PASSWORD }],
  ])(
    'does not claim both are stored once %s is saved, and offers the clear',
    async (_what, typed) => {
      const view = await mount(stored(false, false));
      for (const [id, value] of Object.entries(typed)) view.enter(id, value);
      await view.press('Save tooling');
      expect(view.text()).toContain(UNSTORED_NOTE);
      expect(view.text()).not.toContain(STORED_NOTE);
      expect(view.button(CLEAR)).toBeDefined();
    },
  );

  it('says both are stored once both are saved', async () => {
    const view = await mount(stored(false, false));
    view.enter('appAuthUsername', 'ci-user');
    view.enter('appAuthPassword', TYPED_PASSWORD);
    await view.press('Save tooling');
    expect(view.text()).toContain(STORED_NOTE);
    expect(view.text()).not.toContain(UNSTORED_NOTE);
  });

  it('adds up across saves', async () => {
    const view = await mount(stored(false, false));
    view.enter('appAuthUsername', 'ci-user');
    await view.press('Save tooling');
    expect(view.text()).toContain(UNSTORED_NOTE);
    view.enter('appAuthPassword', TYPED_PASSWORD);
    await view.press('Save tooling');
    expect(view.text()).toContain(STORED_NOTE);
  });

  it('completes a half-stored credential when the missing field is saved', async () => {
    const view = await mount(stored(true, false));
    expect(view.text()).toContain(UNSTORED_NOTE);
    view.enter('appAuthPassword', TYPED_PASSWORD);
    await view.press('Save tooling');
    expect(view.text()).toContain(STORED_NOTE);
    expect(view.text()).not.toContain(UNSTORED_NOTE);
  });

  it.each([
    ['both fields', stored(true, true), STORED_NOTE],
    ['the username alone', stored(true, false), UNSTORED_NOTE],
  ])('forgets nothing when a save types neither field (%s stored)', async (_what, config, note) => {
    const view = await mount(config);
    await view.press('Save tooling');
    expect(view.text()).toContain(note);
    expect(view.button(CLEAR)).toBeDefined();
  });
});

describe('which input the page marks as stored', () => {
  it.each([
    ['both fields', stored(true, true), STORED_HINT, STORED_HINT],
    ['the username alone', stored(true, false), STORED_HINT, ''],
    ['the password alone', stored(false, true), 'test user', STORED_HINT],
    ['neither field', stored(false, false), 'test user', ''],
  ])('with %s stored', async (_what, config, usernameHint, passwordHint) => {
    const view = await mount(config);
    expect(view.field('appAuthUsername').props.placeholder).toBe(usernameHint);
    expect(view.field('appAuthPassword').props.placeholder).toBe(passwordHint);
  });

  it('follows a save that typed one field', async () => {
    const view = await mount(stored(false, false));
    view.enter('appAuthUsername', 'ci-user');
    await view.press('Save tooling');
    expect(view.field('appAuthUsername').props.placeholder).toBe(STORED_HINT);
    expect(view.field('appAuthPassword').props.placeholder).toBe('');
  });
});

describe('Save tooling and the stored credentials', () => {
  it('sends neither credential field when both are left untouched', async () => {
    const view = await mount();
    await view.press('Save tooling');
    expect(api.patch).toHaveBeenCalledTimes(1);
    expect(api.patch.mock.calls[0]![0]).toBe(TOOLING_PATH);
    expect(lastBody().appAuth).toMatchObject({ enabled: true, loginUrl: 'https://app.test/login' });
    expect(credentialFields(lastBody())).toStrictEqual({});
  });

  it.each([
    ['the username alone', { appAuthUsername: 'ci-user' }],
    ['the password alone', { appAuthPassword: TYPED_PASSWORD }],
    ['both', { appAuthUsername: 'ci-user', appAuthPassword: TYPED_PASSWORD }],
  ])('sends %s when that is what was typed', async (_what, typed) => {
    const view = await mount();
    for (const [id, value] of Object.entries(typed)) view.enter(id, value);
    await view.press('Save tooling');
    expect(credentialFields(lastBody())).toStrictEqual(typed);
  });

  it('never turns a field typed and then erased into a clear', async () => {
    const view = await mount();
    view.enter('appAuthUsername', 'ci-user');
    view.enter('appAuthUsername', '');
    await view.press('Save tooling');
    expect(credentialFields(lastBody())).toStrictEqual({});
  });

  it('does not send blanks after the credentials were cleared either', async () => {
    const view = await mount();
    await view.press(CLEAR);
    await view.press(CONFIRM);
    api.patch.mockClear();
    await view.press('Save tooling');
    expect(api.patch).toHaveBeenCalledTimes(1);
    expect(credentialFields(lastBody())).toStrictEqual({});
  });
});

describe('Clear stored credentials and Save tooling never run together', () => {
  type View = Awaited<ReturnType<typeof mount>>;

  function holdNextPatch() {
    let settle!: (ok: boolean) => void;
    api.patch.mockReturnValueOnce(
      new Promise<void>((resolve, reject) => {
        settle = (ok) => (ok ? resolve() : reject(new Error('The server said no')));
      }),
    );
    return async (ok: boolean) => {
      settle(ok);
      await flush();
    };
  }
  const startSave = (view: View) => {
    view.button('Save tooling')!.props.onClick!();
    view.draw();
  };
  const startClear = async (view: View) => {
    await view.press(CLEAR);
    view.button(CONFIRM)!.props.onClick!();
    view.draw();
  };

  it('leaves both enabled when nothing is out', async () => {
    const view = await mount();
    expect(view.button(CLEAR)!.props.disabled).toBeFalsy();
    expect(view.button('Save tooling')!.props.disabled).toBeFalsy();
  });

  it('disables Clear while a save is out', async () => {
    const settle = holdNextPatch();
    const view = await mount();
    startSave(view);
    expect(view.button(CLEAR)!.props.disabled).toBe(true);
    await settle(true);
  });

  it('opens nothing and sends nothing when Clear is pressed while a save is out', async () => {
    const settle = holdNextPatch();
    const view = await mount();
    startSave(view);
    await view.press(CLEAR);
    expect(view.dialog()?.props.open).toBe(false);
    expect(api.patch).toHaveBeenCalledTimes(1);
    await settle(true);
  });

  it('disables Save while a clear is out', async () => {
    const settle = holdNextPatch();
    const view = await mount();
    await startClear(view);
    expect(view.button('Save tooling')!.props.disabled).toBe(true);
    await settle(true);
  });

  it('sends nothing when Save is pressed while a clear is out', async () => {
    const settle = holdNextPatch();
    const view = await mount();
    await startClear(view);
    await view.press('Save tooling');
    expect(api.patch).toHaveBeenCalledTimes(1);
    await settle(true);
  });

  it('disables the confirm in a dialog opened before a save, while the save is out', async () => {
    const settle = holdNextPatch();
    const view = await mount();
    await view.press(CLEAR);
    startSave(view);
    expect(view.button(CONFIRM)!.props.disabled).toBe(true);
    await settle(true);
    view.draw();
    expect(view.button(CONFIRM)!.props.disabled).toBeFalsy();
  });

  it('ignores a confirm pressed in a dialog opened before a save, while the save is out', async () => {
    const settle = holdNextPatch();
    const view = await mount();
    await view.press(CLEAR);
    startSave(view);
    view.button(CONFIRM)!.props.onClick!();
    await flush();
    expect(api.patch).toHaveBeenCalledTimes(1);
    expect(lastBody()).toHaveProperty('appAuth');
    await settle(true);
  });

  it('ignores a Save that reaches its handler while a clear is out', async () => {
    const settle = holdNextPatch();
    const view = await mount();
    await startClear(view);
    view.button('Save tooling')!.props.onClick!();
    await flush();
    expect(api.patch).toHaveBeenCalledTimes(1);
    expect(lastBody()).toStrictEqual({ appAuthUsername: '', appAuthPassword: '' });
    await settle(true);
  });

  it.each([
    ['succeeds', true],
    ['fails', false],
  ])('enables Clear again once the save %s', async (_how, ok) => {
    const settle = holdNextPatch();
    const view = await mount();
    startSave(view);
    await settle(ok);
    view.draw();
    expect(view.button(CLEAR)!.props.disabled).toBeFalsy();
    await view.press(CLEAR);
    expect(view.dialog()?.props.open).toBe(true);
  });

  it.each([
    ['succeeds', true],
    ['fails', false],
  ])('enables Save again once the clear %s', async (_how, ok) => {
    const settle = holdNextPatch();
    const view = await mount();
    await startClear(view);
    await settle(ok);
    view.draw();
    expect(view.button('Save tooling')!.props.disabled).toBeFalsy();
    await view.press('Save tooling');
    expect(api.patch).toHaveBeenCalledTimes(2);
    expect(lastBody()).toHaveProperty('appAuth');
  });
});

describe('after a failed clear or save, the page re-reads which credentials are stored', () => {
  type View = Awaited<ReturnType<typeof mount>>;
  type Flags = [username: boolean, password: boolean];

  const SAVE = 'Save tooling';
  const REFUSED = 'The server said no';
  const SERVER_SIDE = {
    rtkEnabled: false,
    appAuth: { ...APP_AUTH, loginUrl: 'https://server.test/login' },
    pendingRepoMcpServers: ['server-side-mcp'],
  };
  const GONE: [string, Flags, Flags][] = [
    ['the username has gone', [true, true], [false, true]],
    ['the password has gone', [true, true], [true, false]],
  ];
  const BACK: [string, Flags, Flags][] = [
    ['only the username is stored', [false, false], [true, false]],
    ['only the password is stored', [false, false], [false, true]],
  ];

  const refuse = () => api.patch.mockRejectedValueOnce(new Error(REFUSED));
  const reread = (flags: Flags, rest: Record<string, unknown> = {}) =>
    api.get.mockResolvedValueOnce({ ...CONFIG, ...stored(...flags), ...rest });
  const holdRead = (flags: Flags) => {
    let land!: () => void;
    api.get.mockReturnValueOnce(
      new Promise((resolve) => {
        land = () => resolve({ ...CONFIG, ...stored(...flags) });
      }),
    );
    return async () => {
      land();
      await flush();
    };
  };
  const failClear = async (view: View) => {
    await view.press(CLEAR);
    await view.press(CONFIRM);
  };
  const failSave = (view: View) => view.press(SAVE);
  const paths: [string, (view: View) => Promise<void>][] = [
    ['clear', failClear],
    ['save', failSave],
  ];
  const showsStored = (view: View, [username, password]: Flags) => {
    const both = username && password;
    expect(view.field('appAuthUsername').props.placeholder).toBe(
      username ? STORED_HINT : 'test user',
    );
    expect(view.field('appAuthPassword').props.placeholder).toBe(password ? STORED_HINT : '');
    expect(view.text()).toContain(both ? STORED_NOTE : UNSTORED_NOTE);
    expect(view.text()).not.toContain(both ? UNSTORED_NOTE : STORED_NOTE);
    expect(view.button(CLEAR) !== undefined).toBe(username || password);
  };

  it.each(GONE)(
    'shows what the re-read found when %s after a failed clear',
    async (_what, from, to) => {
      const view = await mount(stored(...from));
      refuse();
      reread(to);
      await failClear(view);
      expect(api.get).toHaveBeenCalledTimes(2);
      expect(api.get).toHaveBeenLastCalledWith(CONFIG_PATH);
      showsStored(view, to);
      expect(view.dialog()?.props.open).toBe(true);
      expect(view.dialogError()).toBe(REFUSED);
    },
  );

  it('keeps that after Cancel on the clear error', async () => {
    const view = await mount();
    refuse();
    reread([false, true]);
    await failClear(view);
    await view.press('Cancel');
    expect(view.dialog()?.props.open).toBe(false);
    showsStored(view, [false, true]);
  });

  it('closes the dialog when nothing is left to clear, and it stays closed when credentials are stored again', async () => {
    const view = await mount();
    refuse();
    reread([false, false]);
    await failClear(view);
    expect(view.button(CLEAR)).toBeUndefined();
    expect(view.dialog()).toBeUndefined();
    showsStored(view, [false, false]);
    view.enter('appAuthUsername', 'new-user');
    await view.press(SAVE);
    expect(view.button(CLEAR)).toBeDefined();
    expect(view.dialog()?.props.open).toBe(false);
  });

  it.each([...GONE, ...BACK])(
    'shows what the re-read found when %s after a failed save',
    async (_what, from, to) => {
      const view = await mount(stored(...from));
      view.enter('appAuthUsername', 'ci-user');
      view.enter('appAuthPassword', TYPED_PASSWORD);
      refuse();
      reread(to);
      await failSave(view);
      expect(api.get).toHaveBeenCalledTimes(2);
      expect(api.get).toHaveBeenLastCalledWith(CONFIG_PATH);
      expect(view.error()).toBe(REFUSED);
      showsStored(view, to);
    },
  );

  it('closes a dialog left open behind a failed save when nothing is left to clear', async () => {
    const view = await mount();
    await view.press(CLEAR);
    refuse();
    reread([false, false]);
    await failSave(view);
    expect(view.dialog()).toBeUndefined();
    view.enter('appAuthUsername', 'new-user');
    await view.press(SAVE);
    expect(view.button(CLEAR)).toBeDefined();
    expect(view.dialog()?.props.open).toBe(false);
  });

  it.each(paths)('keeps the unsaved edits when a failed %s is re-read', async (_what, fail) => {
    const view = await mount();
    view.tick('rtkEnabled', true);
    view.enter('appAuthLoginUrl', 'https://app.test/other');
    view.enter('appAuthUsername', 'typed-user');
    refuse();
    reread([false, true], SERVER_SIDE);
    await fail(view);
    showsStored(view, [false, true]);
    expect(view.field('rtkEnabled').props.checked).toBe(true);
    expect(view.field('appAuthLoginUrl').props.value).toBe('https://app.test/other');
    expect(view.field('appAuthUsername').props.value).toBe('typed-user');
    expect(view.text()).not.toContain('MCP servers waiting for your decision');
  });

  it.each(paths)(
    'keeps the flags and the error when the re-read of a failed %s fails too',
    async (_what, fail) => {
      const unhandled: unknown[] = [];
      const collect = (reason: unknown) => unhandled.push(reason);
      process.on('unhandledRejection', collect);
      try {
        const view = await mount();
        refuse();
        api.get.mockRejectedValueOnce(new Error('Network down'));
        await fail(view);
        await flush();
        expect(api.get).toHaveBeenCalledTimes(2);
        showsStored(view, [true, true]);
        expect(view.error() ?? view.dialogError()).toBe(REFUSED);
        expect([view.error(), view.dialogError()]).not.toContain('Network down');
      } finally {
        process.off('unhandledRejection', collect);
      }
      expect(unhandled).toEqual([]);
    },
  );

  it('keeps Save disabled until the re-read of a failed clear has landed', async () => {
    const view = await mount();
    refuse();
    const land = holdRead([false, true]);
    await view.press(CLEAR);
    view.button(CONFIRM)!.props.onClick!();
    await flush();
    view.draw();
    expect(view.dialogError()).toBe(REFUSED);
    expect(view.button('Clearing...')!.props.disabled).toBe(true);
    expect(view.button(SAVE)!.props.disabled).toBe(true);
    await land();
    view.draw();
    expect(view.button(CONFIRM)!.props.disabled).toBeFalsy();
    expect(view.button(SAVE)!.props.disabled).toBeFalsy();
    showsStored(view, [false, true]);
  });

  it('keeps Clear disabled until the re-read of a failed save has landed', async () => {
    const view = await mount();
    refuse();
    const land = holdRead([false, true]);
    view.button(SAVE)!.props.onClick!();
    await flush();
    view.draw();
    expect(view.error()).toBe(REFUSED);
    expect(view.button('Saving...')!.props.disabled).toBe(true);
    expect(view.button(CLEAR)!.props.disabled).toBe(true);
    await land();
    view.draw();
    expect(view.button(SAVE)!.props.disabled).toBeFalsy();
    expect(view.button(CLEAR)!.props.disabled).toBeFalsy();
    showsStored(view, [false, true]);
  });

  it('makes no extra read after a clear that succeeds', async () => {
    const view = await mount();
    await view.press(CLEAR);
    await view.press(CONFIRM);
    expect(api.patch).toHaveBeenCalledTimes(1);
    expect(api.get).toHaveBeenCalledTimes(1);
  });

  it('makes no extra read after a save that succeeds', async () => {
    const view = await mount();
    view.enter('appAuthUsername', 'new-user');
    await view.press(SAVE);
    expect(api.patch).toHaveBeenCalledTimes(1);
    expect(api.get).toHaveBeenCalledTimes(1);
  });
});

describe('the integrations section of the tooling page', () => {
  it('is rendered for this repository once the tooling has loaded', async () => {
    const view = await mount();
    expect(view.integrations()?.props.repositoryId).toBe('repo-1');
  });
});

type View = Awaited<ReturnType<typeof mount>>;
type EditorEl = ReactElement<{
  value: string;
  disabled?: boolean;
  autoFocus?: boolean;
  onChange: (markdown: string) => void;
  onBaseline?: (markdown: string) => void;
}>;

const SAVE_RULES = 'Save AGENTS.md rules';
const RESET = 'Reset to default';
const DEFAULT_RADIO = 'agent-rules-mode-default';
const OVERRIDE_RADIO = 'agent-rules-mode-override';
const STORED = '# Our rules\n\n- Be kind.\n';
const NORMALIZED = '# A re-serialized form of the text\n';

const editor = (view: View) =>
  view.all().find((e) => e.type === MarkdownEditor) as unknown as EditorEl | undefined;
const defaultBox = (view: View) =>
  view.all().find((e) => e.type === MarkdownView && e.props.body === DEFAULT_AGENT_RULES);
const notes = (view: View) =>
  view
    .all()
    .filter((e) => e.type === InlineMarkdown)
    .map((e) => e.props.body ?? '');
const formErrors = (view: View) =>
  view
    .all()
    .filter((e) => e.type === FormError)
    .map((e) => e.props.message)
    .filter(Boolean);
const edit = (view: View, markdown: string) => {
  editor(view)!.props.onChange(markdown);
  view.draw();
};
const saveDisabled = (view: View) => view.button(SAVE_RULES)!.props.disabled === true;

describe('the AGENTS.md rules section', () => {
  describe('on load', () => {
    it('follows the default for null: the default text read-only in a bounded box', async () => {
      const view = await mount({ agentRulesOverride: null });
      expect(view.field(DEFAULT_RADIO).props.checked).toBe(true);
      expect(view.field(OVERRIDE_RADIO).props.checked).toBe(false);
      const box = defaultBox(view);
      expect(box).toBeDefined();
      expect(box!.props.className).toMatch(/\bmax-h-/);
      expect(box!.props.className).toContain('overflow-auto');
      expect(editor(view)).toBeUndefined();
    });

    it('shows a stored text as an override held in the editor', async () => {
      const view = await mount({ agentRulesOverride: STORED });
      expect(view.field(OVERRIDE_RADIO).props.checked).toBe(true);
      expect(view.field(DEFAULT_RADIO).props.checked).toBe(false);
      expect(editor(view)!.props.value).toBe(STORED);
      // An editor mounted with the page that took focus would scroll the page to this card.
      expect(editor(view)!.props.autoFocus).toBe(false);
      expect(defaultBox(view)).toBeUndefined();
      expect(notes(view).some((n) => n.includes('empty override'))).toBe(false);
    });

    it('shows an explicit empty override as an override, with the empty note', async () => {
      const view = await mount({ agentRulesOverride: '' });
      expect(view.field(OVERRIDE_RADIO).props.checked).toBe(true);
      expect(editor(view)!.props.value).toBe('');
      expect(defaultBox(view)).toBeUndefined();
      expect(notes(view)).toContain('An empty override writes no rules block into `AGENTS.md`.');
    });

    it('says a default follows Haive updates and an override does not', async () => {
      const following = notes(await mount());
      expect(following).toContain(
        "This repository follows Haive's default rules and picks up their updates.",
      );
      const overridden = notes(await mount({ agentRulesOverride: STORED }));
      expect(overridden).toContain(
        "This repository no longer follows updates to Haive's default rules.",
      );
      expect(overridden.some((n) => n.includes('picks up their updates'))).toBe(false);
    });

    it.each([null, STORED, ''])(
      'says once, whatever is stored (%j), how a change reaches AGENTS.md',
      async (rules) => {
        const said = notes(await mount({ agentRulesOverride: rules })).filter((n) =>
          n.includes('next upgrade'),
        );
        expect(said).toHaveLength(1);
        expect(said[0]).toContain('personal CLI rules');
      },
    );
  });

  describe('switching', () => {
    it('starts an override from the default text and sends nothing', async () => {
      const view = await mount();
      view.tick(OVERRIDE_RADIO, true);
      expect(view.field(OVERRIDE_RADIO).props.checked).toBe(true);
      expect(editor(view)!.props.value).toBe(DEFAULT_AGENT_RULES);
      expect(defaultBox(view)).toBeUndefined();
      expect(api.patch).not.toHaveBeenCalled();
    });

    it('offers Reset to default only while overriding', async () => {
      const view = await mount();
      expect(view.button(RESET)).toBeUndefined();
      view.tick(OVERRIDE_RADIO, true);
      expect(view.button(RESET)).toBeDefined();
    });

    it('keeps an edited draft when the radio goes to Default and back', async () => {
      const view = await mount();
      view.tick(OVERRIDE_RADIO, true);
      edit(view, 'My draft\n');
      view.tick(DEFAULT_RADIO, true);
      expect(defaultBox(view)).toBeDefined();
      expect(editor(view)).toBeUndefined();
      view.tick(OVERRIDE_RADIO, true);
      expect(editor(view)!.props.value).toBe('My draft\n');
      expect(api.patch).not.toHaveBeenCalled();
    });

    it('discards the draft on Reset to default and sends nothing until Save', async () => {
      const view = await mount();
      view.tick(OVERRIDE_RADIO, true);
      edit(view, 'My draft\n');
      await view.press(RESET);
      expect(view.field(DEFAULT_RADIO).props.checked).toBe(true);
      expect(defaultBox(view)).toBeDefined();
      expect(api.patch).not.toHaveBeenCalled();
      view.tick(OVERRIDE_RADIO, true);
      expect(editor(view)!.props.value).toBe(DEFAULT_AGENT_RULES);
    });

    it('Reset to default on a stored override is a pending change, saved as null', async () => {
      const view = await mount({ agentRulesOverride: STORED });
      expect(saveDisabled(view)).toBe(true);
      await view.press(RESET);
      expect(view.field(DEFAULT_RADIO).props.checked).toBe(true);
      expect(api.patch).not.toHaveBeenCalled();
      expect(saveDisabled(view)).toBe(false);
      api.patch.mockResolvedValueOnce({ agentRulesOverride: null });
      await view.press(SAVE_RULES);
      expect(api.patch).toHaveBeenCalledTimes(1);
      expect(api.patch.mock.calls[0]![0]).toBe(TOOLING_PATH);
      expect(lastBody()).toStrictEqual({ agentRulesOverride: null });
      expect(view.field(DEFAULT_RADIO).props.checked).toBe(true);
      expect(defaultBox(view)).toBeDefined();
    });
  });

  describe('the rules Save', () => {
    it('sends the text alone in Override mode', async () => {
      const view = await mount();
      api.patch.mockResolvedValueOnce({ agentRulesOverride: 'Custom\n' });
      view.tick(OVERRIDE_RADIO, true);
      edit(view, 'Custom\n');
      await view.press(SAVE_RULES);
      expect(api.patch).toHaveBeenCalledTimes(1);
      expect(api.patch.mock.calls[0]![0]).toBe(TOOLING_PATH);
      expect(lastBody()).toStrictEqual({ agentRulesOverride: 'Custom\n' });
      expect(api.get).toHaveBeenCalledTimes(1);
    });

    it('sends the pre-filled default verbatim, never the editor baseline', async () => {
      const view = await mount();
      api.patch.mockResolvedValueOnce({ agentRulesOverride: DEFAULT_AGENT_RULES });
      view.tick(OVERRIDE_RADIO, true);
      editor(view)!.props.onBaseline!(NORMALIZED);
      view.draw();
      await view.press(SAVE_RULES);
      expect(lastBody()).toStrictEqual({ agentRulesOverride: DEFAULT_AGENT_RULES });
    });

    it('sends an explicit empty override as the empty string and keeps it an override', async () => {
      const view = await mount();
      api.patch.mockResolvedValueOnce({ agentRulesOverride: '' });
      view.tick(OVERRIDE_RADIO, true);
      edit(view, '');
      expect(saveDisabled(view)).toBe(false);
      await view.press(SAVE_RULES);
      expect(lastBody()).toStrictEqual({ agentRulesOverride: '' });
      expect(view.field(OVERRIDE_RADIO).props.checked).toBe(true);
      expect(editor(view)!.props.value).toBe('');
      expect(notes(view)).toContain('An empty override writes no rules block into `AGENTS.md`.');
    });

    it('shows the value the server stored, and restarts the editor from it', async () => {
      const view = await mount();
      api.patch.mockResolvedValueOnce({ agentRulesOverride: 'Raw text\n' });
      view.tick(OVERRIDE_RADIO, true);
      edit(view, 'Raw text  \r\n\r\n');
      const before = editor(view)!.key;
      await view.press(SAVE_RULES);
      expect(editor(view)!.props.value).toBe('Raw text\n');
      expect(editor(view)!.key).not.toBe(before);
      expect(saveDisabled(view)).toBe(true);
    });

    it('shows an empty override when the server turned whitespace into the empty string', async () => {
      const view = await mount();
      api.patch.mockResolvedValueOnce({ agentRulesOverride: '' });
      view.tick(OVERRIDE_RADIO, true);
      edit(view, '   ');
      await view.press(SAVE_RULES);
      expect(view.field(OVERRIDE_RADIO).props.checked).toBe(true);
      expect(editor(view)!.props.value).toBe('');
      expect(defaultBox(view)).toBeUndefined();
    });

    it('says Saved. after a save and drops it on the next edit', async () => {
      const view = await mount();
      api.patch.mockResolvedValueOnce({ agentRulesOverride: 'A\n' });
      view.tick(OVERRIDE_RADIO, true);
      edit(view, 'A\n');
      expect(view.text()).not.toContain('Saved.');
      await view.press(SAVE_RULES);
      expect(view.text().match(/Saved\./g)).toHaveLength(1);
      edit(view, 'A\nB\n');
      expect(view.text()).not.toContain('Saved.');
    });

    it('shows a failed save in its own error line and keeps the draft', async () => {
      const view = await mount();
      api.patch.mockRejectedValueOnce(new Error('Invalid AGENTS.md rules: holds a NUL character'));
      view.tick(OVERRIDE_RADIO, true);
      edit(view, 'Draft\n');
      await view.press(SAVE_RULES);
      expect(formErrors(view)).toEqual(['Invalid AGENTS.md rules: holds a NUL character']);
      expect(view.error()).toBeNull();
      expect(view.field(OVERRIDE_RADIO).props.checked).toBe(true);
      expect(editor(view)!.props.value).toBe('Draft\n');
      expect(view.text()).not.toContain('Saved.');
      expect(saveDisabled(view)).toBe(false);
    });

    it('clears the error line when the next attempt succeeds', async () => {
      const view = await mount();
      api.patch.mockRejectedValueOnce(new Error('Invalid AGENTS.md rules: holds a NUL character'));
      api.patch.mockResolvedValueOnce({ agentRulesOverride: 'Draft\n' });
      view.tick(OVERRIDE_RADIO, true);
      edit(view, 'Draft\n');
      await view.press(SAVE_RULES);
      await view.press(SAVE_RULES);
      expect(formErrors(view)).toEqual([]);
      expect(view.text()).toContain('Saved.');
    });
  });

  describe('when Save is available', () => {
    it.each([
      ['following the default', null],
      ['an override', STORED],
      ['an explicit empty override', ''],
    ])('is disabled while the rules are as loaded (%s)', async (_what, rules) => {
      const view = await mount({ agentRulesOverride: rules });
      expect(saveDisabled(view)).toBe(true);
      await view.press(SAVE_RULES);
      expect(api.patch).not.toHaveBeenCalled();
    });

    it('is enabled by a change of mode or of text', async () => {
      const view = await mount({ agentRulesOverride: STORED });
      edit(view, `${STORED}- More.\n`);
      expect(saveDisabled(view)).toBe(false);
      edit(view, STORED);
      expect(saveDisabled(view)).toBe(true);
      view.tick(DEFAULT_RADIO, true);
      expect(saveDisabled(view)).toBe(false);
    });

    it('does not read the editor re-serializing the loaded text as an edit', async () => {
      const view = await mount({ agentRulesOverride: STORED });
      editor(view)!.props.onBaseline!(NORMALIZED);
      view.draw();
      edit(view, NORMALIZED);
      expect(saveDisabled(view)).toBe(true);
      edit(view, `${NORMALIZED}More.\n`);
      expect(saveDisabled(view)).toBe(false);
    });

    it('does not let the baseline of an editor started from the default hide a change', async () => {
      const view = await mount({ agentRulesOverride: '' });
      view.tick(DEFAULT_RADIO, true);
      view.tick(OVERRIDE_RADIO, true);
      editor(view)!.props.onBaseline!(NORMALIZED);
      view.draw();
      edit(view, NORMALIZED);
      expect(saveDisabled(view)).toBe(false);
    });

    it('is disabled while a save is out, which also locks the editor and the radios', async () => {
      let finish!: (value: unknown) => void;
      api.patch.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
      const view = await mount();
      view.tick(OVERRIDE_RADIO, true);
      view.button(SAVE_RULES)!.props.onClick!();
      view.draw();
      const saving = view.button('Saving...')!;
      expect(saving.props.disabled).toBe(true);
      expect(editor(view)!.props.disabled).toBe(true);
      expect(view.field(OVERRIDE_RADIO).props.disabled).toBe(true);
      expect(view.field(DEFAULT_RADIO).props.disabled).toBe(true);
      expect(view.button(RESET)!.props.disabled).toBe(true);
      saving.props.onClick!();
      expect(api.patch).toHaveBeenCalledTimes(1);
      finish({ agentRulesOverride: DEFAULT_AGENT_RULES });
      await flush();
      view.draw();
      expect(saveDisabled(view)).toBe(true);
      expect(editor(view)!.props.disabled).toBe(false);
    });
  });
});

describe('Save tooling and the AGENTS.md rules', () => {
  const SAVE_TOOLING = 'Save tooling';
  const sentNoRules = () => {
    expect(lastBody()).not.toHaveProperty('agentRulesOverride');
    expect(JSON.stringify(lastBody())).not.toContain('agentRules');
  };

  it.each([
    ['following the default', null],
    ['an override', '# Ours\n'],
    ['an explicit empty override', ''],
  ])('sends no agentRulesOverride while the repository is %s', async (_what, rules) => {
    const view = await mount({ agentRulesOverride: rules });
    await view.press(SAVE_TOOLING);
    expect(api.patch).toHaveBeenCalledTimes(1);
    expect(api.patch.mock.calls[0]![0]).toBe(TOOLING_PATH);
    sentNoRules();
  });

  it('sends none while an override is started and edited but not saved', async () => {
    const view = await mount();
    view.tick(OVERRIDE_RADIO, true);
    edit(view, 'Unsaved draft\n');
    await view.press(SAVE_TOOLING);
    sentNoRules();
    expect(view.field(OVERRIDE_RADIO).props.checked).toBe(true);
    expect(editor(view)!.props.value).toBe('Unsaved draft\n');
    expect(saveDisabled(view)).toBe(false);
  });

  it('sends none while a stored override is switched back to Default but not saved', async () => {
    const view = await mount({ agentRulesOverride: STORED });
    await view.press(RESET);
    await view.press(SAVE_TOOLING);
    sentNoRules();
    expect(view.field(DEFAULT_RADIO).props.checked).toBe(true);
    expect(saveDisabled(view)).toBe(false);
  });

  it('sends none after the rules were saved either', async () => {
    const view = await mount();
    api.patch.mockResolvedValueOnce({ agentRulesOverride: 'Custom\n' });
    view.tick(OVERRIDE_RADIO, true);
    edit(view, 'Custom\n');
    await view.press(SAVE_RULES);
    api.patch.mockClear();
    await view.press(SAVE_TOOLING);
    expect(api.patch).toHaveBeenCalledTimes(1);
    sentNoRules();
    expect(editor(view)!.props.value).toBe('Custom\n');
  });
});
