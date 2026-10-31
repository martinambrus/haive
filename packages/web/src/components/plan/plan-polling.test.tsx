import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { PLAN_CHAT_STEP_ID, PLAN_MERGE_STEP_ID, type PlanMergeState } from '@/lib/api-client';
import { PlanChat } from './plan-chat';
import { PlanMergePanel } from './plan-merge-panel';
import { FormError } from '@/components/ui';

// Hooks on a plain slot list, as in toast-stack.test.tsx: this package has no DOM environment.
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
  useCallback: (fn: unknown, deps: unknown[]) => {
    const at = rt.at++;
    const held = rt.slots[at] as { fn: unknown; deps: unknown[] } | undefined;
    if (held && rt.same(held.deps, deps)) return held.fn;
    rt.slots[at] = { fn, deps };
    return fn;
  },
  useEffect: (run: () => unknown, deps?: unknown[]) => {
    rt.queued.push({ deps, run });
  },
}));

const net = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  discardPlanMerge: vi.fn(),
  endPlanChat: vi.fn(),
  messages: undefined as unknown,
}));
vi.mock('@/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-client')>()),
  api: { get: net.get, post: net.post },
  discardPlanMerge: net.discardPlanMerge,
  endPlanChat: net.endPlanChat,
  getPlanMessages: async () => net.messages,
  getPlanBuildClis: async () => ({ plannerCliProviderId: null }),
  markPlanNodeRead: async () => undefined,
}));
vi.mock('@/components/markdown/markdown-view', () => ({ MarkdownView: () => null }));

function mount<P>(Component: (props: P) => ReactNode, props: P) {
  rt.slots = [];
  rt.ran = [];
  const draw = () => {
    rt.rendering = true;
    try {
      for (let pass = 0; pass < 20; pass++) {
        rt.at = 0;
        rt.dirty = false;
        rt.queued = [];
        rt.tree = Component(props);
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

const settle = () => vi.advanceTimersByTimeAsync(0);
const taskFetches = () =>
  net.get.mock.calls.filter(([path]) => String(path).startsWith('/tasks/')).length;

type Shown = { type: unknown; props: Record<string, unknown> };
const shownIn = (node: unknown): Shown[] => {
  if (Array.isArray(node)) return node.flatMap(shownIn);
  if (typeof node !== 'object' || node === null || !('props' in node)) return [];
  const element = node as Shown;
  return [element, ...shownIn(element.props.children)];
};
const shown = () => shownIn(rt.tree);
const pulsing = () =>
  shown().some((el) => String(el.props.className ?? '').includes('animate-pulse'));
const labelled = (label: string) => shown().find((el) => el.props.children === label);
const host = (type: string) => shown().find((el) => el.type === type);
const typeDraft = async (text: string) => {
  (host('textarea')?.props.onChange as (e: unknown) => void)({ target: { value: text } });
  await settle();
};
const press = async (label: string) => {
  const button = labelled(label);
  expect(button, `${label} is offered`).toBeDefined();
  (button?.props.onClick as () => void)();
  await settle();
};

const DEAD_AT = '2026-10-14T09:00:00.000Z';
const TERMINAL = [
  { status: 'completed', dead: false },
  { status: 'cancelled', dead: false },
  { status: 'failed', dead: false },
  { status: 'cancelled', dead: true },
];
const DEAD_CADENCE = [
  { parked: false, status: 'running' },
  { parked: true, status: 'running' },
  { parked: false, status: 'failed' },
];
const taskResponse = (
  stepId: string,
  opts: { dead?: boolean; status?: string; parked?: boolean } = {},
) => ({
  task: {
    id: 'task-1',
    status: opts.status ?? 'running',
    cliProviderId: null,
    deadAt: opts.dead ? DEAD_AT : null,
  },
  steps: [
    {
      stepId,
      status: opts.parked ? 'waiting_form' : 'running',
      waitingStartedAt: opts.parked ? '2026-10-14T08:30:00.000Z' : null,
      statusMessage: 'Working',
      preferredCliProviderId: null,
    },
  ],
  dead: opts.dead ? { at: DEAD_AT, steps: [] } : null,
});
const respondWith = (response: unknown, providers: unknown[] = []) =>
  net.get.mockImplementation(async (path: string) =>
    path.startsWith('/tasks/') ? response : { providers },
  );

let unmount = () => {};
beforeEach(() => {
  vi.useFakeTimers();
  net.get.mockReset();
  net.post.mockReset().mockResolvedValue(undefined);
  net.discardPlanMerge.mockReset();
  net.endPlanChat.mockReset().mockResolvedValue(undefined);
});
afterEach(() => {
  unmount();
  unmount = () => {};
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('PlanChat with a live conversation', () => {
  const onPatched = vi.fn();
  const open = async (response: unknown, providers: unknown[] = []) => {
    onPatched.mockReset();
    net.messages = {
      messages: [
        {
          id: 'm1',
          nodeId: 'node-1',
          taskId: 'task-1',
          role: 'user',
          body: 'split Auth',
          patch: null,
          cliLabel: null,
          createdAt: '2026-10-14T08:00:00.000Z',
        },
      ],
      conversations: [{ taskId: 'task-1', status: 'running', completedAt: null }],
    };
    respondWith(response, providers);
    unmount = mount(PlanChat, { repositoryId: 'repo-1', nodeId: 'node-1', onPatched });
    await settle();
  };

  it('keeps polling a conversation that is still working', async () => {
    await open(taskResponse(PLAN_CHAT_STEP_ID));
    expect(taskFetches()).toBe(1);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(taskFetches()).toBeGreaterThan(1);
    expect(onPatched).not.toHaveBeenCalled();
  });

  it.each(TERMINAL)(
    'stops polling for good once the task is $status (dead_at set: $dead)',
    async ({ status, dead }) => {
      await open(taskResponse(PLAN_CHAT_STEP_ID, { status, dead }));
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(taskFetches()).toBe(1);
      expect(onPatched).toHaveBeenCalledTimes(1);
    },
  );

  it.each(DEAD_CADENCE)(
    'polls a dead conversation once every 30 s, not every 2 s (parked: $parked, status: $status)',
    async ({ parked, status }) => {
      await open(taskResponse(PLAN_CHAT_STEP_ID, { dead: true, parked, status }));
      expect(taskFetches()).toBe(1);
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(29_999);
      expect(taskFetches()).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(taskFetches()).toBe(2);
      await vi.advanceTimersByTimeAsync(29_999);
      expect(taskFetches()).toBe(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(taskFetches()).toBe(3);
      expect(onPatched).toHaveBeenCalledTimes(1);
    },
  );

  const provider = { id: 'cli-1', label: 'Claude', enabled: true };
  const locks = () => ({
    picker: host('select')?.props.disabled,
    composer: host('textarea')?.props.disabled,
    send: labelled('Send')?.props.disabled,
  });

  it('shows a working conversation as working: pulse, everything locked, no End', async () => {
    await open(taskResponse(PLAN_CHAT_STEP_ID), [provider]);
    await typeDraft('and the mobile app');
    expect(pulsing()).toBe(true);
    expect(locks()).toEqual({ picker: true, composer: true, send: true });
    expect(labelled('End conversation')).toBeUndefined();
  });

  it('offers a conversation parked on its form an open composer and End', async () => {
    await open(taskResponse(PLAN_CHAT_STEP_ID, { parked: true }), [provider]);
    await typeDraft('and the mobile app');
    expect(pulsing()).toBe(false);
    expect(locks()).toEqual({ picker: false, composer: false, send: false });
    expect(labelled('End conversation')).toBeDefined();
  });

  it.each([false, true])(
    'shows a dead conversation (parked on its form: %s) as not working: End offered, composer locked',
    async (parked) => {
      await open(taskResponse(PLAN_CHAT_STEP_ID, { dead: true, parked }), [provider]);
      await typeDraft('and the mobile app');
      expect(pulsing()).toBe(false);
      expect(locks()).toEqual({ picker: true, composer: true, send: true });
      expect(labelled('End conversation')).toBeDefined();
    },
  );

  it('lifts the dead lock and polls every 2 s again once the task revives and works', async () => {
    await open(taskResponse(PLAN_CHAT_STEP_ID, { dead: true }), [provider]);
    expect(pulsing()).toBe(false);
    expect(labelled('End conversation')).toBeDefined();
    respondWith(taskResponse(PLAN_CHAT_STEP_ID), [provider]);
    await vi.advanceTimersByTimeAsync(30_000);
    await settle();
    expect(taskFetches()).toBe(2);
    expect(pulsing()).toBe(true);
    expect(labelled('End conversation')).toBeUndefined();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(taskFetches()).toBe(3);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(taskFetches()).toBe(4);
  });

  it('opens the composer again when the task revives onto its form, and stops polling', async () => {
    await open(taskResponse(PLAN_CHAT_STEP_ID, { dead: true, parked: true }), [provider]);
    await typeDraft('and the mobile app');
    expect(locks()).toEqual({ picker: true, composer: true, send: true });
    respondWith(taskResponse(PLAN_CHAT_STEP_ID, { parked: true }), [provider]);
    await vi.advanceTimersByTimeAsync(30_000);
    await settle();
    expect(locks()).toEqual({ picker: false, composer: false, send: false });
    expect(vi.getTimerCount()).toBe(0);
    expect(onPatched).toHaveBeenCalledTimes(2);
  });

  it('slows down again, and refreshes again, when a revived task dies once more', async () => {
    await open(taskResponse(PLAN_CHAT_STEP_ID, { dead: true }));
    respondWith(taskResponse(PLAN_CHAT_STEP_ID));
    await vi.advanceTimersByTimeAsync(30_000);
    respondWith(taskResponse(PLAN_CHAT_STEP_ID, { dead: true }));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(taskFetches()).toBe(3);
    expect(onPatched).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(taskFetches()).toBe(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(taskFetches()).toBe(4);
  });

  it('ends a parked conversation with the blank form answer', async () => {
    await open(taskResponse(PLAN_CHAT_STEP_ID, { parked: true }));
    await press('End conversation');
    expect(net.endPlanChat).toHaveBeenCalledTimes(1);
    expect(net.endPlanChat).toHaveBeenCalledWith('task-1');
    expect(net.post).not.toHaveBeenCalled();
  });

  it('ends a dead conversation by cancelling its task, which a dead task still takes', async () => {
    await open(taskResponse(PLAN_CHAT_STEP_ID, { dead: true }));
    await press('End conversation');
    expect(net.post).toHaveBeenCalledTimes(1);
    expect(net.post).toHaveBeenCalledWith('/tasks/task-1/action', { action: 'cancel' });
    expect(net.endPlanChat).not.toHaveBeenCalled();
  });
});

describe('PlanMergePanel with a merge task', () => {
  const merge: PlanMergeState = {
    taskId: 'task-1',
    status: 'running',
    cliProviderId: null,
    createdAt: '2026-10-14T08:00:00.000Z',
    messages: [],
  };
  const onChanged = vi.fn();
  const onSettled = vi.fn();
  const open = async (response: unknown) => {
    onChanged.mockReset();
    onSettled.mockReset();
    respondWith(response);
    unmount = mount(PlanMergePanel, { repositoryId: 'repo-1', merge, onChanged, onSettled });
    await settle();
  };

  it('keeps polling a merge that is still working', async () => {
    await open(taskResponse(PLAN_MERGE_STEP_ID));
    expect(taskFetches()).toBe(1);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(taskFetches()).toBeGreaterThan(1);
    expect(onChanged).not.toHaveBeenCalled();
  });

  it.each(TERMINAL)(
    'stops polling for good once the task is $status (dead_at set: $dead)',
    async ({ status, dead }) => {
      await open(taskResponse(PLAN_MERGE_STEP_ID, { status, dead }));
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(taskFetches()).toBe(1);
      expect(onSettled).toHaveBeenCalledTimes(1);
    },
  );

  it.each(DEAD_CADENCE)(
    'polls a dead merge once every 30 s, not every 2 s (parked: $parked, status: $status)',
    async ({ parked, status }) => {
      await open(taskResponse(PLAN_MERGE_STEP_ID, { dead: true, parked, status }));
      expect(taskFetches()).toBe(1);
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(29_999);
      expect(taskFetches()).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(taskFetches()).toBe(2);
      await vi.advanceTimersByTimeAsync(29_999);
      expect(taskFetches()).toBe(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(taskFetches()).toBe(3);
      expect(onChanged).toHaveBeenCalledTimes(1);
      expect(onSettled).not.toHaveBeenCalled();
    },
  );

  it('does not call a dead merge settled: it neither landed nor was discarded', async () => {
    await open(taskResponse(PLAN_MERGE_STEP_ID, { dead: true }));
    expect(onSettled).not.toHaveBeenCalled();
  });

  const CONFIRM = 'Confirm — merge in and push';

  it('reports a merge that already ended without treating it as discarded', async () => {
    vi.stubGlobal('window', { confirm: vi.fn(() => true) });
    net.discardPlanMerge.mockResolvedValue({ ok: true, cancelled: false });
    await open(taskResponse(PLAN_MERGE_STEP_ID, { parked: true }));

    await press('Discard');

    expect(net.discardPlanMerge).toHaveBeenCalledWith('repo-1');
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(labelled(CONFIRM)).toBeDefined();
    expect(host('textarea')).toBeDefined();
    expect(pulsing()).toBe(false);
    expect(shown().find((el) => el.type === FormError)?.props.message).toBe(
      'The merge has already completed or closed. Nothing was discarded.',
    );
    expect(taskFetches()).toBe(1);
  });

  it('treats the merge as discarded only when DELETE cancelled it', async () => {
    vi.stubGlobal('window', { confirm: vi.fn(() => true) });
    net.discardPlanMerge.mockResolvedValue({ ok: true, cancelled: true, taskId: 'task-1' });
    await open(taskResponse(PLAN_MERGE_STEP_ID, { parked: true }));

    await press('Discard');

    expect(net.discardPlanMerge).toHaveBeenCalledWith('repo-1');
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(labelled(CONFIRM)).toBeUndefined();
    expect(host('textarea')).toBeUndefined();
    expect(pulsing()).toBe(true);
    expect(shown().find((el) => el.type === FormError)?.props.message).toBeNull();
    expect(taskFetches()).toBe(2);
  });

  it('shows a working merge as working: pulse and nothing to answer', async () => {
    await open(taskResponse(PLAN_MERGE_STEP_ID));
    expect(pulsing()).toBe(true);
    expect(host('textarea')).toBeUndefined();
    expect(labelled(CONFIRM)).toBeUndefined();
  });

  it('offers a merge parked on its form the answer buttons', async () => {
    await open(taskResponse(PLAN_MERGE_STEP_ID, { parked: true }));
    expect(pulsing()).toBe(false);
    expect(host('textarea')).toBeDefined();
    expect(labelled(CONFIRM)).toBeDefined();
  });

  it.each([false, true])(
    'shows a dead merge (parked on its form: %s) as not working: Discard offered, nothing to answer',
    async (parked) => {
      await open(taskResponse(PLAN_MERGE_STEP_ID, { dead: true, parked }));
      expect(pulsing()).toBe(false);
      expect(host('textarea')).toBeUndefined();
      expect(labelled(CONFIRM)).toBeUndefined();
      expect(labelled('Discard')?.props.disabled).toBe(false);
    },
  );

  it('lifts the dead lock and polls every 2 s again once the task revives and works', async () => {
    await open(taskResponse(PLAN_MERGE_STEP_ID, { dead: true }));
    expect(pulsing()).toBe(false);
    respondWith(taskResponse(PLAN_MERGE_STEP_ID));
    await vi.advanceTimersByTimeAsync(30_000);
    await settle();
    expect(taskFetches()).toBe(2);
    expect(pulsing()).toBe(true);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(taskFetches()).toBe(3);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(taskFetches()).toBe(4);
  });

  it('offers the answer buttons again when the task revives onto its form, and stops polling', async () => {
    await open(taskResponse(PLAN_MERGE_STEP_ID, { dead: true, parked: true }));
    expect(labelled(CONFIRM)).toBeUndefined();
    respondWith(taskResponse(PLAN_MERGE_STEP_ID, { parked: true }));
    await vi.advanceTimersByTimeAsync(30_000);
    await settle();
    expect(labelled(CONFIRM)).toBeDefined();
    expect(vi.getTimerCount()).toBe(0);
    expect(onChanged).toHaveBeenCalledTimes(2);
    expect(onSettled).not.toHaveBeenCalled();
  });

  it('slows down again, and refreshes again, when a revived task dies once more', async () => {
    await open(taskResponse(PLAN_MERGE_STEP_ID, { dead: true }));
    respondWith(taskResponse(PLAN_MERGE_STEP_ID));
    await vi.advanceTimersByTimeAsync(30_000);
    respondWith(taskResponse(PLAN_MERGE_STEP_ID, { dead: true }));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(taskFetches()).toBe(3);
    expect(onChanged).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(taskFetches()).toBe(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(taskFetches()).toBe(4);
  });
});
