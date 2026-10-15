import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TYPE_DRAFT_STATE_MAX_BYTES } from '@haive/shared/modularity';
import { API_BASE_URL } from '@/lib/api-client';
import { MarkdownView } from '@/components/markdown/markdown-view';
import { TaskTypeCreatorPanel, draftStorageKey } from './task-type-creator-panel';

// Hooks on a plain slot list, as in plan/plan-polling.test.tsx: this package has no DOM environment.
const rt = vi.hoisted(() => {
  const same = (a: unknown[] | undefined, b: unknown[] | undefined) =>
    a !== undefined &&
    b !== undefined &&
    a.length === b.length &&
    a.every((v, i) => Object.is(v, b[i]));
  return {
    same,
    slots: [] as unknown[],
    at: 0,
    queued: [] as { deps: unknown[] | undefined; run: () => unknown }[],
    ran: [] as { deps: unknown[] | undefined; cleanup: unknown }[],
    dirty: false,
    rendering: false,
    redraw: () => {},
    tree: undefined as unknown,
  };
});

vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  useState: (initial: unknown) => {
    const at = rt.at++;
    if (!(at in rt.slots)) {
      rt.slots[at] = typeof initial === 'function' ? (initial as () => unknown)() : initial;
    }
    const set = (update: unknown) => {
      const next =
        typeof update === 'function' ? (update as (v: unknown) => unknown)(rt.slots[at]) : update;
      if (Object.is(next, rt.slots[at])) return;
      rt.slots[at] = next;
      rt.dirty = true;
      if (!rt.rendering) void Promise.resolve().then(() => rt.redraw());
    };
    return [rt.slots[at], set];
  },
  useRef: (initial: unknown) => {
    const at = rt.at++;
    if (!(at in rt.slots)) rt.slots[at] = { current: initial };
    return rt.slots[at];
  },
  useEffect: (run: () => unknown, deps?: unknown[]) => {
    rt.queued.push({ deps, run });
  },
}));
vi.mock('@/components/markdown/markdown-view', () => ({ MarkdownView: () => null }));

interface Props {
  slug: string | null;
  editorState: Record<string, unknown>;
  onLoad: (draft: Record<string, unknown>) => void;
}

let props: Props;
function mount() {
  rt.slots = [];
  rt.ran = [];
  const draw = () => {
    rt.rendering = true;
    try {
      for (let pass = 0; pass < 20; pass++) {
        rt.at = 0;
        rt.dirty = false;
        rt.queued = [];
        rt.tree = TaskTypeCreatorPanel(props);
        rt.queued.forEach((effect, i) => {
          const before = rt.ran[i];
          if (before && rt.same(before.deps, effect.deps)) return;
          if (typeof before?.cleanup === 'function') before.cleanup();
          rt.ran[i] = { deps: effect.deps, cleanup: effect.run() };
        });
        if (!rt.dirty) return;
      }
      throw new Error('the panel kept updating its own state');
    } finally {
      rt.rendering = false;
    }
  };
  rt.redraw = draw;
  draw();
  return () => rt.ran.forEach((effect) => typeof effect.cleanup === 'function' && effect.cleanup());
}

type Shown = { type: unknown; props: Record<string, unknown> };
const shownIn = (node: unknown): Shown[] => {
  if (Array.isArray(node)) return node.flatMap(shownIn);
  if (typeof node !== 'object' || node === null || !('props' in node)) return [];
  const element = node as Shown;
  return [element, ...shownIn(element.props.children)];
};
const textIn = (node: unknown): string => {
  if (Array.isArray(node)) return node.map(textIn).join(' ');
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (typeof node !== 'object' || node === null || !('props' in node)) return '';
  return textIn((node as Shown).props.children);
};
const shown = () => shownIn(rt.tree);
const text = () => textIn(rt.tree);
const labelled = (label: string) => shown().find((el) => el.props.children === label);
const composer = () => shown().find((el) => el.type === 'textarea');
const bodies = () =>
  shown()
    .filter((el) => el.type === MarkdownView)
    .map((el) => el.props.body);
const settle = async () => {
  for (let i = 0; i < 6; i++) await vi.advanceTimersByTimeAsync(0);
};
const type = async (value: string) => {
  (composer()?.props.onChange as (e: unknown) => void)({ target: { value } });
  await settle();
};
const press = async (label: string) => {
  const button = labelled(label);
  expect(button, `${label} is offered`).toBeDefined();
  (button?.props.onClick as () => void)();
  await settle();
};

interface Call {
  method: string;
  path: string;
  body: unknown;
}
let calls: Call[] = [];
let reply: (call: Call) => { status?: number; body?: unknown } = () => ({ status: 404 });
const store = new Map<string, string>();
const storage = {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => void store.set(key, value),
  removeItem: (key: string) => void store.delete(key),
};
const gets = () => calls.filter((c) => c.method === 'GET');
const posts = () => calls.filter((c) => c.method === 'POST');

const TASK = '5d1c0000-0000-4000-8000-000000000001';
const CONVERSATION_PATH = `/admin/task-type-drafts/${TASK}`;
const SUBMIT_PATH = `/tasks/${TASK}/steps/01-type-draft/submit`;
const EDITOR = {
  slug: 'todo-audit',
  displayName: 'TODO audit',
  description: '',
  requiresRepository: true,
  stepIds: ['custom.todo-audit.list'],
  stepLoopLimitDefaults: {},
  promptSteps: {
    list: {
      slug: 'list',
      title: 'List',
      template: 'List TODOs.',
      capabilities: [],
      timeoutMs: 600_000,
    },
  },
};
const DRAFT = { ...EDITOR, displayName: 'Drafted by the agent' };

const user = (body: string, over: Record<string, unknown> = {}) => ({
  role: 'user',
  body,
  ...over,
});
const agent = (body: string, over: Record<string, unknown> = {}) => ({
  role: 'assistant',
  body,
  draft: null,
  issues: [],
  warnings: [],
  dropped: [],
  ...over,
});
const conversation = (over: Record<string, unknown> = {}) => ({
  status: 'running',
  awaitingMessage: false,
  turns: [user('Make a TODO audit')],
  latestDraft: null,
  ...over,
});
const asked = conversation({
  awaitingMessage: true,
  turns: [user('Make a TODO audit'), agent('Which repositories?')],
});
const drafted = conversation({
  awaitingMessage: true,
  turns: [user('Make a TODO audit'), agent('Here is a draft.', { draft: DRAFT })],
  latestDraft: DRAFT,
});

let current: unknown = conversation();
const serve = (over: Partial<Record<string, { status?: number; body?: unknown }>> = {}) => {
  reply = (call) => {
    if (call.method === 'POST' && call.path === '/admin/task-type-drafts') {
      return over.start ?? { status: 201, body: { taskId: TASK } };
    }
    if (call.method === 'POST') return over.submit ?? { body: { ok: true, queued: true } };
    return over.read ?? { body: current };
  };
};

let unmount = () => {};
const open = (over: Partial<Props> = {}) => {
  props = { slug: null, editorState: EDITOR, onLoad: vi.fn(), ...over };
  unmount = mount();
  return props.onLoad as ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  vi.useFakeTimers();
  calls = [];
  store.clear();
  current = conversation();
  serve();
  vi.stubGlobal('window', { localStorage: storage });
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const call = {
      method: init?.method ?? 'GET',
      path: url.slice(API_BASE_URL.length),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    const { status = 200, body = {} } = reply(call);
    return new Response(JSON.stringify(body), { status });
  });
});
afterEach(() => {
  unmount();
  unmount = () => {};
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('TaskTypeCreatorPanel starting a conversation', () => {
  it('offers a message box and Send, and nothing to end or load', async () => {
    open();
    await settle();
    expect(composer()).toBeDefined();
    expect(labelled('Send')).toBeDefined();
    expect(labelled('End conversation')).toBeUndefined();
    expect(labelled('Load into editor')).toBeUndefined();
    expect(calls).toEqual([]);
  });

  it('does not send an empty message', async () => {
    open();
    expect(labelled('Send')?.props.disabled).toBe(true);
    await type('   ');
    expect(labelled('Send')?.props.disabled).toBe(true);
    await type('A TODO audit');
    expect(labelled('Send')?.props.disabled).toBe(false);
  });

  it('posts once with the message and the editor as it stands', async () => {
    open();
    await type('A read-only TODO audit');
    await press('Send');
    expect(posts()).toEqual([
      {
        method: 'POST',
        path: '/admin/task-type-drafts',
        body: { message: 'A read-only TODO audit', current: EDITOR },
      },
    ]);
  });

  it('starts without the editor state when the api would refuse its size, and says so', async () => {
    const big = { ...EDITOR, description: 'x'.repeat(TYPE_DRAFT_STATE_MAX_BYTES) };
    open({ editorState: big });
    await type('A read-only TODO audit');
    await press('Send');
    expect(posts()).toEqual([
      {
        method: 'POST',
        path: '/admin/task-type-drafts',
        body: { message: 'A read-only TODO audit' },
      },
    ]);
    expect(text()).toContain('Your editor state was not sent: it was too large.');
  });

  it('names the saved type when it is editing one', async () => {
    open({ slug: 'tt-x' });
    await type('Add a step');
    await press('Send');
    expect(posts()[0]?.body).toEqual({
      message: 'Add a step',
      current: EDITOR,
      editingSlug: 'tt-x',
    });
  });

  it('remembers the conversation per slug and reads it back at once', async () => {
    open({ slug: 'tt-x' });
    await type('Add a step');
    await press('Send');
    expect([...store.entries()]).toEqual([[draftStorageKey('tt-x'), TASK]]);
    expect(draftStorageKey('tt-x')).not.toBe(draftStorageKey(null));
    expect(draftStorageKey(null)).toMatch(/:new$/);
    expect(gets().map((c) => c.path)).toEqual([CONVERSATION_PATH]);
    expect(labelled('Send')).toBeUndefined();
  });

  it('shows the error and stays on the message box when the start is refused', async () => {
    serve({ start: { status: 503, body: { error: 'Haive is preparing for maintenance' } } });
    open();
    await type('A TODO audit');
    await press('Send');
    const error = shown().find((el) => typeof el.props.message === 'string');
    expect(error?.props.message).toContain('preparing for maintenance');
    expect(store.size).toBe(0);
    expect(composer()?.props.value).toBe('A TODO audit');
    expect(gets()).toEqual([]);
  });
});

describe('TaskTypeCreatorPanel showing the conversation', () => {
  it('renders what the agent wrote, and what the administrator wrote, as markdown', async () => {
    current = conversation({
      turns: [user('Make **it** short'), agent('Done: `list` is the *only* step.')],
    });
    open();
    await type('go');
    await press('Send');
    expect(bodies()).toEqual(['Make **it** short', 'Done: `list` is the *only* step.']);
    expect(text()).not.toContain('Done: `list`');
  });

  it('lists the problems, warnings, cut keys, the error and the repair of an agent turn', async () => {
    current = conversation({
      turns: [
        user('Draft it'),
        agent('Here it is.', {
          draft: DRAFT,
          issues: [
            { path: 'stepIds', message: 'Required' },
            {
              kind: 'prompt-step-missing',
              stepId: 'custom.todo-audit.rate',
              message: 'has no prompt step',
            },
            {
              kind: 'unmet-need',
              stepId: '07-phase-2-implement',
              index: 1,
              needs: 'worktree',
              reason: 'x',
            },
          ],
          warnings: [
            {
              kind: 'slug-taken',
              slug: 'todo-audit',
              message: 'The slug todo-audit belongs to a task type that already exists.',
            },
          ],
          dropped: ['promptSteps.list.tools'],
          error: 'unreadable-reply',
          repaired: true,
        }),
      ],
      latestDraft: DRAFT,
    });
    open();
    await type('go');
    await press('Send');
    const all = text();
    for (const expected of [
      'stepIds',
      'Required',
      'custom.todo-audit.rate',
      'has no prompt step',
      '07-phase-2-implement',
      'The slug todo-audit belongs to a task type that already exists.',
      'promptSteps.list.tools',
      'unreadable-reply',
    ]) {
      expect(all).toContain(expected);
    }
    expect(all).toMatch(/correct/i);
    expect(shown().filter((el) => el.type === 'li').length).toBeGreaterThanOrEqual(5);
  });

  it('says so when the editor state of a user turn was left out', async () => {
    current = conversation({ turns: [user('Hi', { draftIgnored: 'too-large' })] });
    open();
    await type('go');
    await press('Send');
    expect(text()).toMatch(/too large/i);
  });

  it('shows no list for a turn with nothing to report', async () => {
    current = conversation({ turns: [user('Hi'), agent('Hello.')] });
    open();
    await type('go');
    await press('Send');
    expect(shown().filter((el) => el.type === 'ul')).toEqual([]);
  });
});

describe('TaskTypeCreatorPanel loading a draft', () => {
  it('offers Load only on the turn that holds the newest draft', async () => {
    current = conversation({
      awaitingMessage: true,
      turns: [
        user('one'),
        agent('first', { draft: { ...DRAFT, displayName: 'First' } }),
        user('two'),
        agent('second', { draft: DRAFT }),
        user('three'),
        agent('a question'),
      ],
      latestDraft: DRAFT,
    });
    open();
    await type('go');
    await press('Send');
    expect(shown().filter((el) => el.props.children === 'Load into editor')).toHaveLength(1);
  });

  it('hands the draft to the editor and makes no request of its own', async () => {
    current = drafted;
    const onLoad = open();
    await type('go');
    await press('Send');
    calls.length = 0;
    await press('Load into editor');
    expect(onLoad).toHaveBeenCalledTimes(1);
    expect(onLoad).toHaveBeenCalledWith(DRAFT);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toEqual([]);
  });

  it('says where the draft went once it is loaded, and only then', async () => {
    current = drafted;
    open();
    await type('go');
    await press('Send');
    expect(text()).not.toContain('Loaded into the form');
    await press('Load into editor');
    expect(text()).toContain('Loaded into the form below');
  });

  it('never touches the task types, from the first message to the load', async () => {
    current = drafted;
    open();
    await type('go');
    await press('Send');
    await press('Load into editor');
    await type('and a second step');
    await press('Send');
    await press('End conversation');
    const urls = calls.map((c) => c.path);
    expect(urls.length).toBeGreaterThan(3);
    expect(urls.filter((path) => path.startsWith('/admin/task-types'))).toEqual([]);
    expect(calls.filter((c) => c.method !== 'GET' && c.method !== 'POST')).toEqual([]);
  });

  it('offers no Load when no turn of the conversation holds a draft', async () => {
    current = asked;
    open();
    await type('go');
    await press('Send');
    expect(labelled('Load into editor')).toBeUndefined();
  });
});

describe('TaskTypeCreatorPanel following the conversation', () => {
  const started = async () => {
    open();
    await type('go');
    await press('Send');
  };

  it('keeps reading it every 2 s while the agent works, and shows no message box', async () => {
    await started();
    expect(gets()).toHaveLength(1);
    expect(composer()).toBeUndefined();
    expect(labelled('End conversation')).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1_999);
    expect(gets()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(gets()).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(gets()).toHaveLength(3);
  });

  it('stops reading once the conversation waits for the next message, and opens the message box', async () => {
    await started();
    current = asked;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(gets()).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(gets()).toHaveLength(2);
    expect(composer()).toBeDefined();
    expect(labelled('End conversation')).toBeDefined();
  });

  it('stops reading when the panel goes away', async () => {
    await started();
    unmount();
    unmount = () => {};
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(gets()).toHaveLength(1);
  });

  it.each(['completed', 'failed', 'cancelled'])(
    'stops reading when the task is %s, keeps what was said, forgets it, and offers a new start',
    async (status) => {
      await started();
      current = conversation({ status, turns: [user('Make a TODO audit'), agent('Partial.')] });
      await vi.advanceTimersByTimeAsync(2_000);
      expect(vi.getTimerCount()).toBe(0);
      expect(bodies()).toEqual(['Make a TODO audit', 'Partial.']);
      expect(text()).toContain(status);
      expect(store.size).toBe(0);
      expect(labelled('Send')).toBeDefined();
      expect(composer()).toBeDefined();
    },
  );

  it('keeps reading through a failed read and recovers', async () => {
    await started();
    serve({ read: { status: 500, body: { error: 'boom' } } });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(gets()).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(1);
    serve();
    current = asked;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(composer()).toBeDefined();
    expect(shown().some((el) => typeof el.props.message === 'string')).toBe(false);
  });
});

describe('TaskTypeCreatorPanel carrying on a conversation', () => {
  const parked = async (state: unknown = asked) => {
    current = state;
    store.set(draftStorageKey(null), TASK);
    open();
    await settle();
  };

  it('answers with the message and the editor state as it stands now, as JSON', async () => {
    await parked();
    const changed = { ...EDITOR, displayName: 'Changed by hand' };
    props.editorState = changed;
    await type('Only the main repository');
    await press('Send');
    expect(posts()).toEqual([
      {
        method: 'POST',
        path: SUBMIT_PATH,
        body: { values: { message: 'Only the main repository', draft: JSON.stringify(changed) } },
      },
    ]);
  });

  it('reads the conversation again after an answer, and shows the working state meanwhile', async () => {
    await parked();
    const reads = gets().length;
    current = conversation({ turns: [user('go'), agent('Which?'), user('Only main')] });
    await type('Only main');
    await press('Send');
    expect(composer()).toBeUndefined();
    expect(gets().length).toBeGreaterThan(reads);
  });

  it('clears the box after an answer', async () => {
    await parked();
    await type('Only main');
    await press('Send');
    current = asked;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(composer()?.props.value).toBe('');
  });

  it('ends with a blank answer, forgets the conversation and offers a new start', async () => {
    await parked(drafted);
    await press('End conversation');
    expect(posts()).toEqual([
      { method: 'POST', path: SUBMIT_PATH, body: { values: { message: '' } } },
    ]);
    expect(store.size).toBe(0);
    expect(labelled('End conversation')).toBeUndefined();
    expect(labelled('Send')).toBeDefined();
    expect(vi.getTimerCount()).toBe(0);
    expect(labelled('Load into editor')).toBeDefined();
  });

  it('says what went wrong when an answer is refused, and keeps the message', async () => {
    await parked();
    serve({ submit: { status: 409, body: { error: 'No step awaiting form submission' } } });
    await type('Only main');
    await press('Send');
    const error = shown().find((el) => typeof el.props.message === 'string');
    expect(error?.props.message).toContain('No step awaiting form submission');
    expect(composer()?.props.value).toBe('Only main');
  });
});

describe('TaskTypeCreatorPanel coming back to a conversation', () => {
  it('resumes the remembered one without starting another', async () => {
    current = asked;
    store.set(draftStorageKey('tt-x'), TASK);
    open({ slug: 'tt-x' });
    await settle();
    expect(bodies()).toEqual(['Make a TODO audit', 'Which repositories?']);
    expect(posts()).toEqual([]);
    expect(gets().map((c) => c.path)).toEqual([CONVERSATION_PATH]);
    expect(labelled('End conversation')).toBeDefined();
  });

  it('shows no message box until it knows what the remembered conversation is doing', () => {
    store.set(draftStorageKey(null), TASK);
    open();
    expect(composer()).toBeUndefined();
    expect(labelled('Send')).toBeUndefined();
  });

  it('starts afresh when the remembered conversation is gone', async () => {
    serve({ read: { status: 404, body: { error: 'Draft conversation not found' } } });
    store.set(draftStorageKey(null), TASK);
    open();
    await settle();
    expect(store.size).toBe(0);
    expect(composer()).toBeDefined();
    expect(labelled('Send')).toBeDefined();
    expect(bodies()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    expect(calls).toHaveLength(1);
  });

  it.each(['completed', 'failed', 'cancelled'])(
    'starts afresh when the remembered conversation is %s, and shows none of it',
    async (status) => {
      current = conversation({ status, turns: [user('old'), agent('older')] });
      store.set(draftStorageKey(null), TASK);
      open();
      await settle();
      expect(store.size).toBe(0);
      expect(bodies()).toEqual([]);
      expect(labelled('Send')).toBeDefined();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('keeps the remembered conversation when the read failed for another reason', async () => {
    serve({ read: { status: 500, body: { error: 'boom' } } });
    store.set(draftStorageKey(null), TASK);
    open();
    await settle();
    expect(store.get(draftStorageKey(null))).toBe(TASK);
  });
});

describe('TaskTypeCreatorPanel without browser storage', () => {
  const broken = {
    getItem: () => {
      throw new Error('denied');
    },
    setItem: () => {
      throw new Error('denied');
    },
    removeItem: () => {
      throw new Error('denied');
    },
  };

  it.each([
    ['a storage that throws', { localStorage: broken }],
    ['no storage at all', {}],
  ])('still runs a whole conversation with %s', async (_label, win) => {
    vi.stubGlobal('window', win);
    current = drafted;
    const onLoad = open();
    await type('A TODO audit');
    await press('Send');
    expect(posts()).toHaveLength(1);
    expect(bodies()).toHaveLength(2);
    await press('Load into editor');
    expect(onLoad).toHaveBeenCalledWith(DRAFT);
    await press('End conversation');
    expect(labelled('Send')).toBeDefined();
  });
});
