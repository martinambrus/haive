import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import Link from 'next/link';
import type { ModuleOpenTask, ModuleUrgentResponse } from '@/lib/api-client';
import { Dialog, DialogContent } from '@/components/dialog';
import { Button, FormError, Input } from '@/components/ui';
import { ModulePurgeDialog } from './module-purge-dialog';
import {
  ModuleTaskTitle,
  ModuleTasksCapNote,
  ModuleTasksOpenDialog,
  type ModuleTasksBlocked,
} from './module-tasks-open-dialog';

// No DOM environment here: hooks run on a plain slot list, and Escape goes through a fake document.
const hooks = vi.hoisted(() => ({ slots: [] as unknown[], next: 0, dirty: false, mounting: true }));
const keys = vi.hoisted(() => ({ listeners: [] as ((event: unknown) => void)[] }));

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
  useRef: (initial: unknown) => {
    const at = hooks.next++;
    if (!(at in hooks.slots)) hooks.slots[at] = { current: initial };
    return hooks.slots[at];
  },
  useEffect: (effect: () => void) => {
    if (hooks.mounting) effect();
  },
}));
vi.mock('react-dom', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-dom')>()),
  createPortal: (children: unknown) => children,
}));
beforeAll(() =>
  vi.stubGlobal('document', {
    body: {},
    addEventListener: (_type: string, listener: (event: unknown) => void) =>
      keys.listeners.push(listener),
    removeEventListener: () => undefined,
  }),
);
afterAll(() => vi.unstubAllGlobals());

type El = ReactElement<{
  children?: ReactNode;
  role?: string;
  variant?: string;
  disabled?: boolean;
  message?: string | null;
  href?: string;
  task?: ModuleOpenTask;
  viewerId?: string | null;
  onClick?: () => void;
  onChange?: (event: { target: { value: string } }) => void;
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

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

async function mount(render: () => ReactNode, runDialog = false) {
  hooks.slots = [];
  hooks.mounting = true;
  keys.listeners = [];
  let tree: ReactNode = null;
  const draw = () => {
    for (let pass = 0; pass < 10; pass++) {
      hooks.next = 0;
      hooks.dirty = false;
      tree = render();
      if (runDialog && hooks.mounting && isValidElement<El['props']>(tree)) {
        (tree.type as (props: unknown) => unknown)(tree.props);
      }
      hooks.mounting = false;
      if (!hooks.dirty) return;
    }
    throw new Error('the dialog kept updating its own state');
  };
  draw();
  await flush();
  draw();
  const button = (label: string) => {
    const found = flatten(tree).find((e) => e.type === Button && textOf(e) === label);
    if (!found) throw new Error(`no ${label} button`);
    return found;
  };
  return {
    tree: () => tree,
    draw,
    button,
    buttons: () => flatten(tree).filter((e) => e.type === Button),
    click: async (label: string) => {
      button(label).props.onClick!();
      draw();
      await flush();
      draw();
    },
    text: () => textOf(tree),
    press: async (key: string) => {
      const stop = () => {};
      for (const listener of [...keys.listeners]) {
        listener({ key, stopPropagation: stop, stopImmediatePropagation: stop });
      }
      draw();
      await flush();
      draw();
    },
    titles: () =>
      flatten(tree)
        .filter((e) => e.type === ModuleTaskTitle)
        .map((e) => {
          const shown = ModuleTaskTitle(e.props as Parameters<typeof ModuleTaskTitle>[0]) as El;
          return {
            text: textOf(shown),
            href: shown.type === Link ? (shown.props.href ?? null) : null,
          };
        }),
  };
}

const VIEWER = 'viewer-1';
const OTHER = 'someone-else';
const ME = {
  user: {
    id: VIEWER,
    email: 'admin@example.test',
    role: 'admin',
    status: 'active',
    createdAt: '2026-10-01T00:00:00.000Z',
  },
};
const task = (
  id: string,
  currentStepId: string | null,
  ownerId = VIEWER,
  status = 'running',
): ModuleOpenTask => ({ id, title: `Task ${id}`, status, ownerId, currentStepId });
const BLOCKED: ModuleTasksBlocked = {
  moduleId: 'alpha',
  name: 'Alpha Search',
  tasks: [task('t1', 'module.alpha.x'), task('t2', '07-phase-2-implement')],
  capped: false,
};
const RESULT: ModuleUrgentResponse = {
  moduleId: 'alpha',
  active: false,
  deactivatedAt: '2026-10-15T09:00:00.000Z',
  stopped: [{ id: 't1', title: 'Task t1', killed: 1, cancelled: 1, stopped: 1 }],
  left: [{ id: 't2', title: 'Task t2', status: 'running', currentStepId: '07-phase-2-implement' }],
  failed: [],
  capped: false,
};
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

const fetchMock = vi.fn();
let meAnswer: () => Promise<Response> | Response;
let apiAnswer: () => Promise<Response> | Response;
const sent = (path: string) =>
  fetchMock.mock.calls.filter(([url]) => new URL(url as string).pathname === path);

beforeEach(() => {
  fetchMock.mockReset();
  meAnswer = () => json(200, ME);
  apiAnswer = () => {
    throw new Error('this test set no answer for the request');
  };
  fetchMock.mockImplementation(async (url: string) =>
    new URL(url).pathname === '/auth/me' ? meAnswer() : apiAnswer(),
  );
  vi.stubGlobal('fetch', fetchMock);
});

describe('ModuleTasksOpenDialog actions', () => {
  const view = async (blocked: ModuleTasksBlocked | null = BLOCKED) => {
    const onClose = vi.fn();
    const onDone = vi.fn();
    const mounted = await mount(() => ModuleTasksOpenDialog({ blocked, onClose, onDone }), true);
    return { ...mounted, onClose, onDone };
  };

  it('is the shared Dialog, so Escape and the backdrop close it', async () => {
    const { tree } = await view();
    expect((tree() as El).type).toBe(Dialog);
    expect(flatten(tree()).find((e) => e.type === DialogContent)?.props.role).toBe('alertdialog');
  });

  it('draws nothing while no deactivation is refused', async () => {
    expect((await view(null)).tree()).toBeNull();
  });

  it('offers Cancel and a danger Turn off now, and sends nothing until one is clicked', async () => {
    const { buttons } = await view();
    expect(buttons().map((b) => [textOf(b), b.props.variant])).toEqual([
      ['Cancel', 'secondary'],
      ['Turn off now', 'destructive'],
    ]);
    expect(sent('/modules/alpha')).toHaveLength(0);
  });

  it('sends exactly {active:false, mode:"urgent"} once on Turn off now, and hands the answer on', async () => {
    apiAnswer = () => json(200, RESULT);
    const { click, onDone, onClose } = await view();
    await click('Turn off now');
    expect(sent('/modules/alpha')).toHaveLength(1);
    const [url, init] = sent('/modules/alpha')[0] as [string, RequestInit];
    expect(new URL(url).pathname).toBe('/modules/alpha');
    expect(init.method).toBe('PATCH');
    expect(init.body).toBe('{"active":false,"mode":"urgent"}');
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(onDone).toHaveBeenCalledWith(RESULT);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('sends once when Turn off now is clicked twice before the answer arrives', async () => {
    apiAnswer = () => json(200, RESULT);
    const { button, onDone } = await view();
    const turnOff = button('Turn off now');
    turnOff.props.onClick!();
    turnOff.props.onClick!();
    await flush();
    expect(sent('/modules/alpha')).toHaveLength(1);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('shows it is busy, disables both buttons, and ignores Cancel and Escape until the answer arrives', async () => {
    let answer!: (response: Response) => void;
    apiAnswer = () => new Promise<Response>((resolve) => (answer = resolve));
    const { click, buttons, press, button, onClose, onDone } = await view();
    await click('Turn off now');
    expect(buttons().map((b) => [textOf(b), b.props.disabled])).toEqual([
      ['Cancel', true],
      ['Turning off…', true],
    ]);
    button('Cancel').props.onClick!();
    await press('Escape');
    expect(onClose).not.toHaveBeenCalled();
    answer(json(200, RESULT));
    await flush();
    expect(sent('/modules/alpha')).toHaveLength(1);
    expect(onDone).toHaveBeenCalledWith(RESULT);
  });

  it('sends nothing on Cancel, and closes', async () => {
    const { click, onClose, onDone } = await view();
    await click('Cancel');
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onDone).not.toHaveBeenCalled();
    expect(sent('/modules/alpha')).toHaveLength(0);
  });

  it('sends nothing on Escape, and closes; any other key does neither', async () => {
    const { press, onClose, onDone } = await view();
    await press('Enter');
    await press('y');
    expect(onClose).not.toHaveBeenCalled();
    await press('Escape');
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onDone).not.toHaveBeenCalled();
    expect(sent('/modules/alpha')).toHaveLength(0);
  });

  it('keeps the dialog open with the reason when the api refuses, and lets the click be repeated', async () => {
    apiAnswer = () => json(500, { error: 'The database is away' });
    const { click, tree, buttons, onDone, onClose } = await view();
    await click('Turn off now');
    const alert = flatten(tree()).find((e) => e.type === FormError);
    expect(alert?.props.message).toBe('The database is away');
    expect(onDone).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(buttons().map((b) => [textOf(b), b.props.disabled])).toEqual([
      ['Cancel', false],
      ['Turn off now', false],
    ]);
    await click('Turn off now');
    expect(sent('/modules/alpha')).toHaveLength(2);
  });

  it('forgets a refusal once the dialog is dismissed', async () => {
    apiAnswer = () => json(500, { error: 'The database is away' });
    const { click, tree } = await view();
    await click('Turn off now');
    await click('Cancel');
    expect(flatten(tree()).find((e) => e.type === FormError)?.props.message).toBeNull();
  });
});

describe('who gets a link to a task', () => {
  const tasks = [
    task('t1', 'module.alpha.x', VIEWER, 'running'),
    task('t2', 'module.alpha.y', OTHER, 'running'),
    task('t3', '07-phase-2-implement', VIEWER, 'waiting_user'),
    task('t4', '07-phase-2-implement', OTHER, 'waiting_user'),
  ];
  const open = (over: Partial<ModuleTasksBlocked> = {}) =>
    mount(
      () =>
        ModuleTasksOpenDialog({
          blocked: { ...BLOCKED, tasks, ...over },
          onClose: () => {},
          onDone: () => {},
        }),
      true,
    );
  const OWN_ONLY = [
    { text: 'Task t1 ↗', href: '/tasks/t1' },
    { text: 'Task t2', href: null },
    { text: 'Task t3 ↗', href: '/tasks/t3' },
    { text: 'Task t4', href: null },
  ];

  it('links the tasks the signed-in user owns and shows the rest as text', async () => {
    expect((await open()).titles()).toEqual(OWN_ONLY);
  });

  it('shows text only while the read of /auth/me has not answered', async () => {
    let answer!: (response: Response) => void;
    meAnswer = () => new Promise<Response>((resolve) => (answer = resolve));
    const dialog = await open();
    expect(dialog.titles().every((t) => t.href === null)).toBe(true);
    answer(json(200, ME));
    await flush();
    dialog.draw();
    expect(dialog.titles()).toEqual(OWN_ONLY);
  });

  it.each([
    ['answers 500', () => json(500, { error: 'The database is away' })],
    ['answers 401', () => json(401, { error: 'Not signed in' })],
    ['cannot be reached', () => Promise.reject(new TypeError('Failed to fetch'))],
    ['answers with no body', () => json(200, null)],
    ['answers without a user', () => json(200, {})],
    ['answers a user without an id', () => json(200, { user: { role: 'admin' } })],
    ['answers an id that is not a string', () => json(200, { user: { id: 7 } })],
    ['answers an empty id', () => json(200, { user: { id: '' } })],
  ])('gives text only when /auth/me %s', async (_label, answer) => {
    meAnswer = answer;
    const { titles } = await open({ tasks: [...tasks, task('t5', null, '')] });
    expect(titles()).toHaveLength(5);
    expect(titles().every((t) => t.href === null)).toBe(true);
  });

  it('reads /auth/me once while the dialog is open, however often it redraws', async () => {
    apiAnswer = () => json(200, RESULT);
    const dialog = await open();
    dialog.draw();
    dialog.draw();
    await dialog.press('y');
    await dialog.click('Turn off now');
    expect(sent('/auth/me')).toHaveLength(1);
  });

  it('does not read /auth/me while no dialog is open', async () => {
    await mount(
      () => ModuleTasksOpenDialog({ blocked: null, onClose: () => {}, onDone: () => {} }),
      true,
    );
    expect(sent('/auth/me')).toHaveLength(0);
  });

  it('applies to the purge dialog the same way', async () => {
    apiAnswer = () =>
      json(409, {
        error: 'Live tasks still use this module, dead ones included. Cancel them first.',
        code: 'module_tasks_open',
        tasks,
      });
    const purge = await mount(() =>
      ModulePurgeDialog({
        target: { id: 'alpha', tornDown: true },
        onClose: () => {},
        onDone: () => {},
      }),
    );
    const input = flatten(purge.tree()).find((e) => e.type === Input)!;
    input.props.onChange!({ target: { value: 'alpha' } });
    purge.draw();
    await purge.click('Purge');
    expect(purge.titles()).toEqual(OWN_ONLY);
    expect(sent('/auth/me')).toHaveLength(1);
  });

  it('gives the purge dialog text only when /auth/me fails', async () => {
    meAnswer = () => json(500, { error: 'The database is away' });
    apiAnswer = () => json(409, { error: 'x', code: 'module_tasks_open', tasks });
    const purge = await mount(() =>
      ModulePurgeDialog({
        target: { id: 'alpha', tornDown: true },
        onClose: () => {},
        onDone: () => {},
      }),
    );
    const input = flatten(purge.tree()).find((e) => e.type === Input)!;
    input.props.onChange!({ target: { value: 'alpha' } });
    purge.draw();
    await purge.click('Purge');
    expect(purge.titles().map((t) => t.text)).toEqual(['Task t1', 'Task t2', 'Task t3', 'Task t4']);
    expect(purge.titles().every((t) => t.href === null)).toBe(true);
  });
});

describe('ModulePurgeDialog cap note', () => {
  const refusal = (capped: unknown) =>
    json(409, {
      error: 'Live tasks still use this module, dead ones included. Cancel them first.',
      code: 'module_tasks_open',
      tasks: [task('t1', 'module.alpha.x'), task('t2', null)],
      ...(capped === undefined ? {} : { capped }),
    });

  const purge = async (answer: Response) => {
    apiAnswer = () => answer;
    const mounted = await mount(() =>
      ModulePurgeDialog({
        target: { id: 'alpha', tornDown: true },
        onClose: () => {},
        onDone: () => {},
      }),
    );
    const input = flatten(mounted.tree()).find((e) => e.type === Input)!;
    input.props.onChange!({ target: { value: 'alpha' } });
    mounted.draw();
    await mounted.click('Purge');
    return mounted;
  };
  const noteIn = (tree: ReactNode) => flatten(tree).filter((e) => e.type === ModuleTasksCapNote);

  it('shows the note under the list when the refusal says the list was cut', async () => {
    const { tree, titles } = await purge(refusal(true));
    expect(titles().map((t) => t.text)).toEqual(['Task t1 ↗', 'Task t2 ↗']);
    expect(noteIn(tree())).toHaveLength(1);
  });

  it('shows no note when the refusal does not say so', async () => {
    for (const capped of [false, undefined, 'yes']) {
      const { tree, titles } = await purge(refusal(capped));
      expect(titles()).toHaveLength(2);
      expect(noteIn(tree())).toHaveLength(0);
    }
  });

  it('shows no note and no list for a refusal that is not about open tasks', async () => {
    const { tree, titles } = await purge(
      json(409, { error: 'Only a module that is missing', code: 'x' }),
    );
    expect(titles()).toHaveLength(0);
    expect(noteIn(tree())).toHaveLength(0);
  });
});
