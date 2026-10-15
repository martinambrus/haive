import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { Dialog } from '@/components/dialog';
import { Button, FormError } from '@/components/ui';
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
  const button = (name: string) => all().find((e) => e.type === Button && textOf(e) === name);
  const field = (id: string) => {
    const el = all().find((e) => e.props.id === id);
    if (!el) throw new Error(`no #${id} field`);
    return el;
  };
  return {
    draw,
    button,
    field,
    dialog,
    dialogError: () =>
      flatten(dialog()?.props.children).find((e) => e.type === FormError)?.props.message ?? null,
    text: () => textOf(tree),
    error: () => all().find((e) => e.type === FormError)?.props.message ?? null,
    press: async (name: string) => {
      const target = button(name);
      if (!target?.props.onClick) throw new Error(`no "${name}" button to press`);
      target.props.onClick();
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
