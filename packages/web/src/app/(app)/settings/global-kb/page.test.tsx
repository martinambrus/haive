import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { Dialog } from '@/components/dialog';
import { Button, FormError, Label } from '@/components/ui';
import GlobalKbPage from './page';

// No DOM in this package: the page's hooks run on a plain slot list, as in components/task-type-editor.test.tsx.
const hooks = vi.hoisted(() => ({ slots: [] as unknown[], next: 0, dirty: false, mounting: true }));
const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn() }));
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
  id?: string;
  htmlFor?: string;
  value?: string;
  disabled?: boolean;
  open?: boolean;
  message?: string | null;
  onClick?: () => void;
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

async function mount(config: Record<string, unknown> = {}, providers: unknown[] = []) {
  api.get.mockImplementation(async (path: string) => {
    if (path === CONFIG_PATH) return { ...CONFIG, ...config };
    if (path.startsWith('/global-kb/entries')) return { entries: [], total: 0, frameworks: [] };
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
    target.props.onClick();
    await settle();
  };
  await press(button('Edit'), 'Edit');
  field('cfg-mode');

  return {
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
