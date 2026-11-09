import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { Dialog } from '@/components/dialog';
import { Button, FormError, Label } from '@/components/ui';
import GlobalKbPage from './page';
import { MarkdownView } from '@/components/markdown/markdown-view';
import { InlineMarkdown } from '@/components/markdown/inline-markdown';

// No DOM in this package: the page's hooks run on a plain slot list, as in components/task-type-editor.test.tsx.
const hooks = vi.hoisted(() => ({ slots: [] as unknown[], next: 0, dirty: false, mounting: true }));
const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() }));
type KeyListener = (event: {
  key: string;
  stopPropagation: () => void;
  stopImmediatePropagation: () => void;
}) => void;
const keys = vi.hoisted(() => ({ listeners: [] as KeyListener[] }));

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
  useInsertionEffect: (effect: () => void) => {
    if (hooks.mounting) effect();
  },
  useCallback: (fn: unknown) => fn,
  useMemo: (fn: () => unknown) => fn(),
  useRef: (initial: unknown) => {
    const at = hooks.next++;
    if (!(at in hooks.slots)) hooks.slots[at] = { current: initial };
    return hooks.slots[at];
  },
}));
// The shared Dialog portals into document.body, which this package has no equivalent of.
vi.mock('react-dom', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-dom')>()),
  createPortal: (children: unknown) => children,
}));
vi.mock('@/lib/use-page-title', () => ({ usePageTitle: () => {} }));
vi.mock('@/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-client')>()),
  api,
}));

beforeAll(() => {
  vi.stubGlobal('window', {
    location: { search: '', hash: '', href: 'http://localhost:3000/settings/global-kb' },
    history: { replaceState: () => {} },
    addEventListener: () => {},
    removeEventListener: () => {},
    confirm: vi.fn(() => true),
  });
  vi.stubGlobal('document', {
    body: {},
    addEventListener: (type: string, listener: KeyListener) => {
      if (type === 'keydown') keys.listeners.push(listener);
    },
    removeEventListener: () => {},
  });
});
afterAll(() => vi.unstubAllGlobals());

type El = ReactElement<{
  children?: ReactNode;
  body?: string;
  id?: string;
  htmlFor?: string;
  value?: string;
  disabled?: boolean;
  'data-testid'?: string;
  open?: boolean;
  message?: string | null;
  title?: string;
  role?: string;
  onClick?: (event?: { stopPropagation: () => void }) => void;
  onChange?: (event: { target: { value?: string } }) => void;
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

const CONFIG_PATH = '/global-kb/config';
const REMOVE = 'Remove stored connection string';
const CONFIRM = 'Remove connection string';
const BUSY = 'Removing…';
const STORED_NOTE = '(set — leave blank to keep)';
const CONFIG = {
  enabled: true,
  digestEnabled: true,
  mode: 'internal',
  namespace: 'default',
  ollamaUrl: 'http://ollama:11434',
  embedModel: 'qwen3-embedding:4b',
  embedDimensions: 2560,
  archiveRetentionDays: 30,
  connectionStringSet: true,
  canEnforce: true,
  houseRulesEnabled: true,
};

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

async function mount(
  config: Record<string, unknown> = {},
  providers: unknown[] = [],
  entries: unknown[] = [],
) {
  api.get.mockImplementation(async (path: string) => {
    if (path === CONFIG_PATH) return { ...CONFIG, ...config };
    if (path.startsWith('/global-kb/entries'))
      return { entries, total: entries.length, frameworks: [] };
    if (path === '/repos') return { repositories: [] };
    if (path === '/cli-providers') return { providers };
    throw new Error(`unexpected GET ${path}`);
  });
  hooks.slots = [];
  hooks.mounting = true;
  let tree: ReactNode = null;
  const draw = () => {
    for (let pass = 0; pass < 10; pass++) {
      hooks.next = 0;
      hooks.dirty = false;
      tree = GlobalKbPage();
      hooks.mounting = false;
      if (!hooks.dirty) return;
    }
    throw new Error('the page kept updating its own state');
  };
  draw();
  await flush();
  draw();

  const all = () => flatten(tree);
  const button = (name: string) => all().find((e) => e.type === Button && textOf(e) === name);
  const field = (id: string) => {
    const el = all().find((e) => e.props.id === id);
    if (!el) throw new Error(`no #${id} field`);
    return el;
  };
  const confirmDialog = () =>
    all().find((e) => e.type === Dialog && textOf(e.props.children).includes(REMOVE));
  // A closed Dialog renders nothing, so nothing in it can be read or pressed.
  const inDialog = () => {
    const dialog = confirmDialog();
    return dialog?.props.open === true ? flatten(dialog.props.children) : [];
  };
  const settle = async () => {
    await flush();
    draw();
  };
  const press = async (target: El | undefined, name: string) => {
    if (!target?.props.onClick) throw new Error(`no "${name}" button to press`);
    target.props.onClick({ stopPropagation: () => {} });
    await settle();
  };
  await press(button('Edit'), 'Edit');
  field('cfg-mode');

  return {
    all,
    pressTarget: press,
    openEntry: async () => {
      const card = all().find((e) => e.props.role === 'button' && e.props.onClick);
      await press(card, 'entry card');
    },
    field,
    settle,
    button,
    press: (name: string) => press(button(name), name),
    pressInDialog: (name: string) =>
      press(
        inDialog().find((e) => e.type === Button && textOf(e) === name),
        name,
      ),
    dialogButton: (name: string) => inDialog().find((e) => e.type === Button && textOf(e) === name),
    confirmOpen: () => confirmDialog()?.props.open === true,
    confirmError: () => inDialog().find((e) => e.type === FormError)?.props.message ?? null,
    connectionLabel: () => {
      const label = all().find((e) => e.type === Label && e.props.htmlFor === 'cfg-conn');
      if (!label) throw new Error('no connection string label: is the external store selected?');
      return textOf(label);
    },
    choose: (id: string, value: string) => {
      field(id).props.onChange!({ target: { value } });
      draw();
    },
    escape: () => {
      const dialog = confirmDialog();
      if (dialog?.props.open !== true) throw new Error('no open confirm dialog to press Escape on');
      keys.listeners.length = 0;
      hooks.mounting = true;
      Dialog(dialog.props as Parameters<typeof Dialog>[0]);
      hooks.mounting = false;
      const stop = () => {};
      for (const listener of keys.listeners) {
        listener({ key: 'Escape', stopPropagation: stop, stopImmediatePropagation: stop });
      }
      draw();
    },
  };
}

const configPuts = () => api.put.mock.calls.filter(([path]) => path === CONFIG_PATH);

beforeEach(() => {
  window.location.search = '';
  api.get.mockReset();
  api.post.mockReset();
  api.put.mockReset();
  api.delete.mockReset();
  api.delete.mockResolvedValue({ ok: true });
  vi.mocked(window.confirm).mockClear();
  api.put.mockResolvedValue({ ...CONFIG, connectionStringSet: false });
  keys.listeners.length = 0;
});

describe('the remove control on the Global KB settings page', () => {
  it('is offered to an admin while a string is stored and the built-in store is selected', async () => {
    expect((await mount()).button(REMOVE)).toBeDefined();
  });

  it.each([
    ['a regular user', { canEnforce: false }],
    ['no stored string', { connectionStringSet: false }],
    ['the external store saved', { mode: 'external' }],
  ])('is not offered for %s', async (_what, config) => {
    expect((await mount(config)).button(REMOVE)).toBeUndefined();
  });

  it('follows the selected store: gone once external is chosen, back with the built-in one', async () => {
    const view = await mount();

    view.choose('cfg-mode', 'external');
    expect(view.button(REMOVE)).toBeUndefined();

    view.choose('cfg-mode', 'internal');
    expect(view.button(REMOVE)).toBeDefined();
  });

  it('opens a confirm and sends nothing until it is confirmed', async () => {
    const view = await mount();
    expect(view.confirmOpen()).toBe(false);

    await view.press(REMOVE);

    expect(view.confirmOpen()).toBe(true);
    expect(view.dialogButton(CONFIRM)).toBeDefined();
    expect(configPuts()).toEqual([]);
  });
});

describe('confirming the removal', () => {
  it('sends exactly the clear flag once, closes, and the stored flag reads false', async () => {
    const view = await mount();
    view.choose('cfg-mode', 'external');
    expect(view.connectionLabel()).toContain(STORED_NOTE);
    view.choose('cfg-mode', 'internal');
    await view.press(REMOVE);

    await view.pressInDialog(CONFIRM);

    expect(configPuts()).toEqual([[CONFIG_PATH, { clearConnectionString: true }]]);
    expect(view.confirmOpen()).toBe(false);
    expect(view.button(REMOVE)).toBeUndefined();
    view.choose('cfg-mode', 'external');
    expect(view.connectionLabel()).not.toContain(STORED_NOTE);
  });

  it('sends once however often it is pressed while the request is in flight', async () => {
    let finish!: (config: unknown) => void;
    api.put.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    const view = await mount();
    await view.press(REMOVE);

    await view.pressInDialog(CONFIRM);
    expect(view.dialogButton(BUSY)?.props.disabled).toBe(true);
    await view.pressInDialog(BUSY);
    expect(configPuts()).toHaveLength(1);

    finish({ ...CONFIG, connectionStringSet: false });
    await view.settle();
    expect(view.confirmOpen()).toBe(false);
  });

  it('shows a refusal in the dialog and changes nothing', async () => {
    api.put.mockRejectedValue(
      Object.assign(new Error('the external store needs its connection string'), { status: 409 }),
    );
    const view = await mount();
    await view.press(REMOVE);

    await view.pressInDialog(CONFIRM);

    expect(configPuts()).toHaveLength(1);
    expect(view.confirmOpen()).toBe(true);
    expect(view.confirmError()).toBe('the external store needs its connection string');
    expect(view.dialogButton(CONFIRM)?.props.disabled).toBe(false);
    view.choose('cfg-mode', 'external');
    expect(view.connectionLabel()).toContain(STORED_NOTE);
    view.choose('cfg-mode', 'internal');
    expect(view.button(REMOVE)).toBeDefined();
  });

  it('also drops a string typed before the removal, so a later save cannot store it again', async () => {
    const view = await mount();
    view.choose('cfg-mode', 'external');
    view.choose('cfg-conn', 'postgres://typed:secret@elsewhere/kb');
    view.choose('cfg-mode', 'internal');
    await view.press(REMOVE);
    await view.pressInDialog(CONFIRM);
    view.choose('cfg-namespace', 'elsewhere');

    await view.press('Save connection');

    expect(configPuts()).toEqual([
      [CONFIG_PATH, { clearConnectionString: true }],
      [CONFIG_PATH, { namespace: 'elsewhere' }],
    ]);
  });
});

describe('dismissing the confirm', () => {
  it('sends nothing on Cancel, and keeps the stored string on offer', async () => {
    const view = await mount();
    await view.press(REMOVE);

    await view.pressInDialog('Cancel');

    expect(configPuts()).toEqual([]);
    expect(view.confirmOpen()).toBe(false);
    expect(view.button(REMOVE)).toBeDefined();
  });

  it('sends nothing on Escape, and keeps the stored string on offer', async () => {
    const view = await mount();
    await view.press(REMOVE);
    expect(view.confirmOpen()).toBe(true);

    view.escape();

    expect(configPuts()).toEqual([]);
    expect(view.confirmOpen()).toBe(false);
    expect(view.button(REMOVE)).toBeDefined();
  });

  it('forgets an earlier refusal when it is opened again', async () => {
    api.put.mockRejectedValueOnce(new Error('the external store needs its connection string'));
    const view = await mount();
    await view.press(REMOVE);
    await view.pressInDialog(CONFIRM);
    expect(view.confirmError()).not.toBeNull();
    await view.pressInDialog('Cancel');

    await view.press(REMOVE);

    expect(view.confirmError()).toBeNull();
  });
});

describe('Save connection', () => {
  it('does not send the clear flag, with a string stored and the built-in store selected', async () => {
    const view = await mount();
    view.choose('cfg-namespace', 'elsewhere');

    await view.press('Save connection');

    expect(configPuts()).toEqual([[CONFIG_PATH, { namespace: 'elsewhere' }]]);
  });

  it('does not send a string typed for the external store once the built-in one is selected again', async () => {
    const view = await mount();
    view.choose('cfg-mode', 'external');
    view.choose('cfg-conn', 'postgres://typed:secret@elsewhere/kb');
    view.choose('cfg-mode', 'internal');
    view.choose('cfg-namespace', 'elsewhere');

    await view.press('Save connection');

    expect(configPuts()).toEqual([[CONFIG_PATH, { namespace: 'elsewhere' }]]);
  });

  it('sends a string typed while the external store is selected', async () => {
    const view = await mount();
    view.choose('cfg-mode', 'external');
    view.choose('cfg-conn', 'postgres://typed:secret@elsewhere/kb');

    await view.press('Save connection');

    expect(configPuts()).toEqual([
      [CONFIG_PATH, { mode: 'external', connectionString: 'postgres://typed:secret@elsewhere/kb' }],
    ]);
  });
});

const EMBED_IDS = ['cfg-ollama-mode', 'cfg-model', 'cfg-dims', 'cfg-retention'];
const EXTERNAL_OLLAMA = 'http://box.lan:11434';
const ADMIN_NOTE = 'embed-admin-only';

describe('the embedding settings on the Global KB settings page', () => {
  it.each([
    ['the built-in Ollama', {}, EMBED_IDS],
    ['an external Ollama', { ollamaUrl: EXTERNAL_OLLAMA }, [...EMBED_IDS, 'cfg-ollama']],
  ])('are disabled for a regular user with %s', async (_what, config, ids) => {
    const view = await mount({ ...config, canEnforce: false });
    for (const id of ids) expect(view.field(id).props.disabled, id).toBe(true);
  });

  it.each([
    ['the built-in Ollama', {}, EMBED_IDS],
    ['an external Ollama', { ollamaUrl: EXTERNAL_OLLAMA }, [...EMBED_IDS, 'cfg-ollama']],
  ])('stay enabled for an admin with %s', async (_what, config, ids) => {
    const view = await mount(config);
    for (const id of ids) expect(view.field(id).props.disabled, id).not.toBe(true);
  });

  it('shows a regular user one short line saying an admin manages them', async () => {
    const notes = (await mount({ canEnforce: false }))
      .all()
      .filter((e) => e.props['data-testid'] === ADMIN_NOTE);
    expect(notes).toHaveLength(1);
    expect(textOf(notes[0])).toMatch(/admin/i);
    expect(textOf(notes[0]).length).toBeLessThan(140);
  });

  it('shows an admin no such line', async () => {
    const view = await mount();
    expect(view.all().filter((e) => e.props['data-testid'] === ADMIN_NOTE)).toHaveLength(0);
  });

  it('sends none of them when a regular user saves another edit', async () => {
    const view = await mount({ canEnforce: false });
    view.choose('cfg-namespace', 'elsewhere');

    await view.press('Save connection');

    const sent = configPuts().flatMap(([, body]) => Object.keys(body as object));
    expect(configPuts()).toHaveLength(1);
    for (const key of ['ollamaUrl', 'embedModel', 'embedDimensions', 'archiveRetentionDays']) {
      expect(sent).not.toContain(key);
    }
  });
});

describe('the enrichment CLI picker', () => {
  const providers = [
    { id: 'on', name: 'codex', label: 'Same label', enabled: true },
    { id: 'off', name: 'codex', label: 'Same label', enabled: false },
  ];

  it.each([
    ['on', 'on'],
    ['off', ''],
    ['missing', ''],
  ])('accepts only an enabled CLI from ?cli=%s', async (requested, expected) => {
    window.location.search = `?repo=repo-1&cli=${requested}`;
    const view = await mount({}, providers);
    const picker = view.field('enrich-cli');
    expect(picker.props.value).toBe(expected);
    expect(
      flatten(picker.props.children)
        .filter((e) => e.type === 'option')
        .map((e) => e.props.value),
    ).toEqual(['', 'on']);
    expect(view.field('enrich-repo').props.value).toBe('repo-1');
  });
});

describe('entry management controls', () => {
  const entry = (over: Record<string, unknown> = {}) => ({
    id: '00000000-0000-4000-8000-0000000000b1',
    namespace: 'default',
    userId: '00000000-0000-4000-8000-0000000000a1',
    title: 'A shared article',
    body: 'Body',
    description: null,
    category: 'best_practice',
    facets: {},
    status: 'active',
    source: 'user',
    sourceTaskId: null,
    supersedesEntryId: null,
    embedStatus: 'embedded',
    canManage: true,
    createdAt: '2026-11-09T00:00:00Z',
    updatedAt: '2026-11-09T00:00:00Z',
    ...over,
  });

  const namedControls = (ui: Awaited<ReturnType<typeof mount>>, label: string) =>
    ui.all().filter((e) => (e.type === Button || e.type === 'button') && textOf(e) === label);

  describe.each(['draft', 'active', 'archived'])('PATCH controls on %s entries', (status) => {
    it.each([false, undefined, true])('uses canManage=%s in list and detail', async (canManage) => {
      const row = entry({ status, canManage, description: 'Read this description' });
      const ui = await mount({ canEnforce: false }, [], [row]);
      const allowed = canManage === true;
      expect(namedControls(ui, 'Activate')).toHaveLength(status === 'draft' && allowed ? 1 : 0);
      await ui.openEntry();
      for (const label of ['Edit description', 'Edit scope', 'Edit body']) {
        expect(namedControls(ui, label)).toHaveLength(allowed ? 1 : 0);
      }
      expect(namedControls(ui, 'Activate')).toHaveLength(status === 'draft' && allowed ? 2 : 0);
      expect(namedControls(ui, 'Reactivate')).toHaveLength(
        status === 'archived' && allowed ? 1 : 0,
      );
      expect(namedControls(ui, 'Archive')).toHaveLength(status === 'active' && allowed ? 1 : 0);
      expect(ui.all().some((e) => e.type === MarkdownView && e.props.body === row.body)).toBe(true);
      expect(
        ui.all().some((e) => e.type === InlineMarkdown && e.props.body === row.description),
      ).toBe(true);
    });
  });

  it.each([
    ['Edit description', 'Save description'],
    ['Edit scope', 'Save scope'],
    ['Edit body', 'Save body'],
  ])('hides an open %s editor after permission is lost', async (edit, save) => {
    const row = entry();
    const ui = await mount({ canEnforce: false }, [], [row]);
    await ui.openEntry();
    await ui.pressTarget(namedControls(ui, edit)[0], edit);
    expect(namedControls(ui, save)).toHaveLength(1);
    row.canManage = false;
    await ui.settle();
    expect(namedControls(ui, save)).toHaveLength(0);
    expect(ui.all().some((e) => e.type === MarkdownView && e.props.body === row.body)).toBe(true);
  });

  it('keeps enforcement controls governed by canEnforce', async () => {
    const ui = await mount({ canEnforce: true }, [], [entry({ canManage: false })]);
    await ui.openEntry();
    expect(namedControls(ui, 'Edit body')).toHaveLength(0);
    expect(namedControls(ui, 'Enforce…')).toHaveLength(1);
  });

  const deleteButtons = (ui: Awaited<ReturnType<typeof mount>>) =>
    ui.all().filter((e) => e.type === Button && textOf(e) === 'Delete');

  it.each([false, undefined])(
    'hides list and detail Delete for canManage=%s',
    async (canManage) => {
      const ui = await mount({}, [], [entry({ canManage })]);
      expect(deleteButtons(ui)).toHaveLength(0);
      await ui.openEntry();
      expect(deleteButtons(ui)).toHaveLength(0);
    },
  );

  it('uses the server flag even when admin controls are unavailable', async () => {
    const ui = await mount(
      { canEnforce: false },
      [],
      [entry({ userId: null, enforcedHash: 'approval-from-another-install' })],
    );
    expect(deleteButtons(ui)).toHaveLength(1);
    await ui.openEntry();
    expect(deleteButtons(ui)).toHaveLength(2);
  });

  it('never cancels enrichment after a delete is refused', async () => {
    api.delete.mockRejectedValue({ message: 'Admin required' });
    const row = entry({ sourceTaskId: 'enrich-task', status: 'failed' });
    const ui = await mount({}, [], [row]);
    await ui.press('Delete');
    expect(api.delete).toHaveBeenCalledWith(`/global-kb/entries/${row.id}`);
    expect(api.post).not.toHaveBeenCalled();
  });

  it('cancels user enrichment only after deletion succeeds', async () => {
    const events: string[] = [];
    api.delete.mockImplementation(async () => {
      events.push('delete');
      return { ok: true };
    });
    api.post.mockImplementation(async () => {
      events.push('cancel');
      return {};
    });
    const ui = await mount({}, [], [entry({ sourceTaskId: 'enrich-task', status: 'failed' })]);
    await ui.press('Delete');
    expect(events).toEqual(['delete', 'cancel']);
    expect(api.post).toHaveBeenCalledWith('/tasks/enrich-task/action', { action: 'cancel' });
  });

  it('never cancels the workflow that promoted a deleted draft', async () => {
    const ui = await mount({}, [], [entry({ source: 'promoted', sourceTaskId: 'workflow-task' })]);
    await ui.press('Delete');
    expect(api.delete).toHaveBeenCalledOnce();
    expect(api.post).not.toHaveBeenCalled();
  });

  it('does not cancel a task after an unconfirmed deletion', async () => {
    vi.mocked(window.confirm).mockReturnValueOnce(false);
    const ui = await mount({}, [], [entry({ sourceTaskId: 'enrich-task', status: 'failed' })]);
    await ui.press('Delete');
    expect(api.delete).not.toHaveBeenCalled();
    expect(api.post).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'gates in-progress enrichment cancellation on canManage=%s',
    async (canManage) => {
      const ui = await mount(
        {},
        [],
        [entry({ status: 'enriching', sourceTaskId: 'enrich-task', canManage })],
      );
      const cancel = ui
        .all()
        .find(
          (e) =>
            e.type === Button &&
            e.props.title === 'Cancel the enrichment task and discard this entry',
        );
      expect(Boolean(cancel)).toBe(canManage);
      if (canManage) {
        await ui.pressTarget(cancel, 'Cancel enrichment');
        expect(api.post).toHaveBeenCalledWith('/tasks/enrich-task/action', { action: 'cancel' });
      } else {
        expect(api.post).not.toHaveBeenCalled();
      }
      expect(api.delete).not.toHaveBeenCalled();
    },
  );
});
