import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { PLAN_CHAT_STEP_ID, PLAN_MERGE_STEP_ID, type PlanMergeState } from '@/lib/api-client';
import { PlanChat } from './plan-chat';
import { PlanMergePanel } from './plan-merge-panel';
import { FormError } from '@/components/ui';
import { InlineMarkdown } from '@/components/markdown/inline-markdown';
import Link from 'next/link';
import { planOrigin, taskOrigin } from '@/lib/task-origin';

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
    stateWrites: 0,
    rendering: false,
    redraw: () => {},
    tree: undefined as unknown,
  };
});

vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  useState: (initial: unknown) => {
    const slots = rt.slots;
    const at = rt.at++;
    if (!(at in rt.slots)) {
      rt.slots[at] = typeof initial === 'function' ? (initial as () => unknown)() : initial;
    }
    const set = (update: unknown) => {
      rt.stateWrites++;
      if (slots !== rt.slots) return; // React ignores state writes from an unmounted instance.
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
  submitPlanMergeTurn: vi.fn(),
  endPlanChat: vi.fn(),
  startPlanChat: vi.fn(),
  submitPlanChatTurn: vi.fn(),
  getPlanMessages: vi.fn(),
  messages: undefined as unknown,
}));
vi.mock('@/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-client')>()),
  api: { get: net.get, post: net.post },
  discardPlanMerge: net.discardPlanMerge,
  submitPlanMergeTurn: net.submitPlanMergeTurn,
  endPlanChat: net.endPlanChat,
  startPlanChat: net.startPlanChat,
  submitPlanChatTurn: net.submitPlanChatTurn,
  getPlanMessages: net.getPlanMessages,
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
  return Object.assign(
    () => rt.ran.forEach((effect) => typeof effect.cleanup === 'function' && effect.cleanup()),
    {
      rerender: (next: P) => {
        props = next;
        draw();
      },
    },
  );
}

const settle = () => vi.advanceTimersByTimeAsync(0);
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
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
  net.getPlanMessages.mockReset().mockImplementation(async () => net.messages);
  net.post.mockReset().mockResolvedValue(undefined);
  net.discardPlanMerge.mockReset();
  net.submitPlanMergeTurn.mockReset().mockResolvedValue(undefined);
  net.endPlanChat.mockReset().mockResolvedValue(undefined);
  net.startPlanChat.mockReset().mockResolvedValue({ taskId: 'task-1' });
  net.submitPlanChatTurn.mockReset().mockResolvedValue(undefined);
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('Unexpected network call in plan component test');
    }),
  );
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

  it('retries a failed chat poll on its normal cadence and unlocks the next turn', async () => {
    await open(taskResponse(PLAN_CHAT_STEP_ID));
    net.get.mockRejectedValueOnce(new Error('Temporary read failure'));
    await vi.advanceTimersByTimeAsync(2000);
    expect(taskFetches()).toBe(2);
    expect(host('textarea')?.props.disabled).toBe(true);
    expect(labelled('End conversation')).toBeUndefined();
    respondWith(taskResponse(PLAN_CHAT_STEP_ID, { parked: true }));
    await vi.advanceTimersByTimeAsync(1999);
    expect(taskFetches()).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(taskFetches()).toBe(3);
    expect(host('textarea')?.props.disabled).toBe(false);
    expect(labelled('End conversation')).toBeDefined();
    expect(onPatched).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
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

  it.each([
    { code: 'step_form_not_waiting', message: 'The form has already moved on.', ended: true },
    { code: undefined, message: 'No step awaiting form submission', ended: false },
    { code: 'other_conflict', message: 'No step awaiting form submission', ended: false },
  ])(
    'classifies an ended form by code ($code), with copy: $message',
    async ({ code, message, ended }) => {
      await open(taskResponse(PLAN_CHAT_STEP_ID, { parked: true }));
      net.submitPlanChatTurn.mockRejectedValueOnce(
        Object.assign(new Error(message), { code, status: 409 }),
      );
      await typeDraft('Follow up');
      await press('Send');
      expect(shown().find((el) => el.type === FormError)?.props.message).toBe(
        ended ? 'That conversation has ended. Send again to start a new one.' : message,
      );
      expect(host('textarea')?.props.value).toBe('Follow up');
    },
  );

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

describe('PlanChat drafts on different nodes', () => {
  const props = { repositoryId: 'repo-1', nodeId: 'node-A', onPatched: vi.fn() };
  beforeEach(() => {
    net.messages = { messages: [], conversations: [] };
    respondWith(null);
  });

  it('never sends A’s draft to B and restores each node’s own text', async () => {
    const mounted = mount(PlanChat, props);
    unmount = mounted;
    await settle();
    await typeDraft('Only for A');

    mounted.rerender({ ...props, nodeId: 'node-B' });
    await settle();
    await press('Send');

    expect(net.startPlanChat).not.toHaveBeenCalled();
    expect(host('textarea')?.props.value).toBe('');
    expect(labelled('Send')?.props.disabled).toBe(true);
    await typeDraft('Only for B');
    mounted.rerender(props);
    await settle();
    expect(host('textarea')?.props.value).toBe('Only for A');
    mounted.rerender({ ...props, nodeId: 'node-B' });
    await settle();
    expect(host('textarea')?.props.value).toBe('Only for B');
    await press('Send');
    expect(net.startPlanChat).toHaveBeenCalledExactlyOnceWith('repo-1', 'node-B', {
      message: 'Only for B',
    });
    expect(host('textarea')?.props.value).toBe('');
    mounted.rerender(props);
    await settle();
    expect(host('textarea')?.props.value).toBe('Only for A');
  });

  it('restores drafts after the parent unmounts the chat, scoped to repository and node', async () => {
    const drafts = new Map<string, string>();
    const open = async (repositoryId: string, nodeId: string) => {
      unmount = mount(PlanChat, { ...props, repositoryId, nodeId, drafts });
      await settle();
    };
    await open('repo-1', 'node-A');
    await typeDraft('A in repo 1');
    unmount();
    await open('repo-1', 'node-B');
    expect(host('textarea')?.props.value).toBe('');
    await typeDraft('B in repo 1');
    unmount();
    await open('repo-2', 'node-A');
    expect(host('textarea')?.props.value).toBe('');
    await typeDraft('A in repo 2');
    unmount();
    await open('repo-1', 'node-A');
    expect(host('textarea')?.props.value).toBe('A in repo 1');
    unmount();
    await open('repo-1', 'node-B');
    expect(host('textarea')?.props.value).toBe('B in repo 1');
    unmount();
    await open('repo-2', 'node-A');
    expect(host('textarea')?.props.value).toBe('A in repo 2');
  });

  it.each(['success', 'failure'])(
    'keeps B’s draft when A’s pending send ends with %s',
    async (outcome) => {
      const request = deferred<unknown>();
      net.startPlanChat.mockReturnValueOnce(request.promise);
      const mounted = mount(PlanChat, props);
      unmount = mounted;
      await settle();
      await typeDraft('Only for A');
      await press('Send');
      mounted.rerender({ ...props, nodeId: 'node-B' });
      await settle();
      await typeDraft('Only for B');

      if (outcome === 'success') request.resolve({ taskId: 'task-A' });
      else request.reject(new Error('Send failed'));
      await settle();

      expect(host('textarea')?.props.value).toBe('Only for B');
      mounted.rerender(props);
      await settle();
      expect(host('textarea')?.props.value).toBe(outcome === 'success' ? '' : 'Only for A');
    },
  );

  it('drops a late transcript for A containing a live conversation after switching to B', async () => {
    const transcript = deferred<unknown>();
    const refreshedB = deferred<unknown>();
    net.getPlanMessages
      .mockReturnValueOnce(transcript.promise)
      .mockResolvedValueOnce({ messages: [], conversations: [] })
      .mockReturnValueOnce(refreshedB.promise);
    respondWith(taskResponse(PLAN_CHAT_STEP_ID, { parked: true }));
    const mounted = mount(PlanChat, props);
    unmount = mounted;
    await settle();
    mounted.rerender({ ...props, nodeId: 'node-B' });
    await settle();
    transcript.resolve({
      messages: [
        {
          id: 'message-A',
          nodeId: 'node-A',
          taskId: 'task-A',
          role: 'user',
          body: 'An active conversation for A',
          patch: null,
          cliLabel: null,
          createdAt: '2026-10-14T08:00:00.000Z',
        },
      ],
      conversations: [{ taskId: 'task-A', status: 'running', completedAt: null }],
    });
    await settle();
    await typeDraft('Only for B');
    await press('Send');
    expect(net.submitPlanChatTurn).not.toHaveBeenCalled();
    expect(net.startPlanChat).toHaveBeenCalledExactlyOnceWith('repo-1', 'node-B', {
      message: 'Only for B',
    });
    expect(net.get.mock.calls.some(([path]) => path === '/tasks/task-A')).toBe(false);
    refreshedB.resolve({ messages: [], conversations: [] });
    await settle();
  });

  it('empties the node after a successful send including edits during the request', async () => {
    const request = deferred<unknown>();
    net.startPlanChat.mockReturnValueOnce(request.promise);
    unmount = mount(PlanChat, props);
    await settle();
    await typeDraft('First message');
    await press('Send');
    await typeDraft('Next message');
    request.resolve({ taskId: 'task-A' });
    await settle();
    expect(host('textarea')?.props.value).toBe('');
  });
});

describe('PlanChat submitted drafts', () => {
  const props = { repositoryId: 'repo-1', nodeId: 'node-A', onPatched: vi.fn() };
  beforeEach(() => {
    net.messages = { messages: [], conversations: [] };
    respondWith(null);
  });

  it.each([false, true])(
    'restores a failed send unless a newer draft exists (new: %s)',
    async (edited) => {
      const request = deferred<unknown>();
      net.startPlanChat.mockReturnValueOnce(request.promise);
      unmount = mount(PlanChat, props);
      await settle();
      await typeDraft('  Original message  ');
      await press('Send');
      expect(host('textarea')?.props.value).toBe('');
      if (edited) await typeDraft('A newer draft');
      request.reject(new Error('Send failed'));
      await settle();
      expect(host('textarea')?.props.value).toBe(edited ? 'A newer draft' : '  Original message  ');
    },
  );

  it.each(['success', 'failure'])(
    'consumes the draft before remounting during a pending send that ends in %s',
    async (outcome) => {
      const drafts = new Map<string, string>();
      const request = deferred<unknown>();
      net.startPlanChat.mockReturnValueOnce(request.promise);
      unmount = mount(PlanChat, { ...props, drafts });
      await settle();
      await typeDraft('Submitted message');
      await press('Send');
      unmount();
      unmount = mount(PlanChat, { ...props, drafts });
      await settle();
      expect(host('textarea')?.props.value).toBe('');
      expect(labelled('Send')?.props.disabled).toBe(true);
      if (outcome === 'success') {
        await typeDraft('Edited after remount');
        request.resolve({ taskId: 'task-A' });
      } else request.reject(new Error('Send failed'));
      await settle();
      expect(host('textarea')?.props.value).toBe(outcome === 'success' ? '' : 'Submitted message');
    },
  );
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
    const mounted = mount(PlanMergePanel, {
      repositoryId: 'repo-1',
      merge: merge as PlanMergeState | null,
      onChanged,
      onSettled,
    });
    unmount = mounted;
    await settle();
    return (next: PlanMergeState | null) =>
      mounted.rerender({ repositoryId: 'repo-1', merge: next, onChanged, onSettled });
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
  const NOTICE =
    'The merge is no longer open: it completed, was cancelled or failed. Nothing was discarded.';
  const hasNotice = () =>
    shown().some((el) => el.props.message === NOTICE || el.props.body === NOTICE);

  it.each([
    ['completed', 'The remote was merged into your checkout and pushed.'],
    [
      'cancelled',
      'This merge was cancelled elsewhere. Its scratch worktree may be discarded unless another merge holds it. This does not undo changes already merged into your checkout.',
    ],
    [
      'failed',
      'The merge failed. Retry on its task resumes it while its scratch worktree is still there. A Save or Pull may discard it.',
    ],
  ])('keeps the polled %s outcome after the page removes the merge', async (status, text) => {
    const rerender = await open(taskResponse(PLAN_MERGE_STEP_ID));
    onSettled.mockImplementationOnce(() => rerender(null));
    respondWith(taskResponse(PLAN_MERGE_STEP_ID, { status }));

    await vi.advanceTimersByTimeAsync(2000);

    const outcome = shown().find((el) => el.props.role === 'status');
    expect(outcome).toBeDefined();
    expect(shownIn(outcome).find((el) => el.type === InlineMarkdown)?.props.body).toBe(text);
    expect(labelled('Discard')).toBeUndefined();
    if (status === 'failed') {
      const link = shownIn(outcome).find((el) => el.type === Link);
      expect(link?.props.href).toBe('/tasks/task-1');
      (link?.props.onClick as () => void)();
      expect(taskOrigin('/tasks/task-1')).toEqual(planOrigin('repo-1'));
    } else {
      expect(shownIn(outcome).find((el) => el.type === Link)).toBeUndefined();
    }
    respondWith(taskResponse(PLAN_MERGE_STEP_ID, { parked: true }));
    rerender({ ...merge, taskId: 'task-2' });
    await settle();
    rerender(null);
    expect(shown().find((el) => el.props.role === 'status')).toBeUndefined();
  });

  it.each(['completed', 'cancelled', 'failed'])(
    'recovers %s when the page removes a working merge before its poll returns',
    async (status) => {
      const rerender = await open(taskResponse(PLAN_MERGE_STEP_ID));
      const inFlight = deferred<unknown>();
      net.get.mockReturnValueOnce(inFlight.promise);
      await vi.advanceTimersByTimeAsync(2000);
      respondWith(taskResponse(PLAN_MERGE_STEP_ID, { status }));
      rerender(null);
      await settle();
      const outcome = shown().find((el) => el.props.role === 'status');
      expect(outcome).toBeDefined();
      expect(onSettled).toHaveBeenCalledTimes(1);
      expect(taskFetches()).toBe(3);
      inFlight.resolve(taskResponse(PLAN_MERGE_STEP_ID, { status: 'cancelled' }));
      await settle();
      expect(shown().find((el) => el.props.role === 'status')).toEqual(outcome);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(taskFetches()).toBe(3);
    },
  );

  it.each(['completed', 'cancelled', 'failed'])(
    'recovers %s after a parked merge ends elsewhere',
    async (status) => {
      const rerender = await open(taskResponse(PLAN_MERGE_STEP_ID, { parked: true }));
      expect(vi.getTimerCount()).toBe(0);
      respondWith(taskResponse(PLAN_MERGE_STEP_ID, { status }));
      rerender(null);
      await settle();
      expect(shown().find((el) => el.props.role === 'status')).toBeDefined();
      expect(onSettled).toHaveBeenCalledTimes(1);
      expect(taskFetches()).toBe(2);
    },
  );

  it('retries a failed merge poll on its normal cadence', async () => {
    await open(taskResponse(PLAN_MERGE_STEP_ID));
    net.get.mockRejectedValueOnce(new Error('Temporary read failure'));
    await vi.advanceTimersByTimeAsync(2000);
    expect(taskFetches()).toBe(2);
    respondWith(taskResponse(PLAN_MERGE_STEP_ID, { status: 'failed' }));
    await vi.advanceTimersByTimeAsync(1999);
    expect(taskFetches()).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(taskFetches()).toBe(3);
    expect(shown().find((el) => el.props.role === 'status')).toBeDefined();
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it('retries a transient recovery failure and stops as soon as it gets an answer', async () => {
    const rerender = await open(taskResponse(PLAN_MERGE_STEP_ID, { parked: true }));
    net.get.mockRejectedValueOnce(new Error('Temporary recovery failure'));
    rerender(null);
    await settle();
    expect(taskFetches()).toBe(2);
    respondWith(taskResponse(PLAN_MERGE_STEP_ID, { status: 'failed' }));
    await vi.advanceTimersByTimeAsync(1999);
    expect(taskFetches()).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(taskFetches()).toBe(3);
    expect(shown().find((el) => el.props.role === 'status')).toBeDefined();
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(taskFetches()).toBe(3);
  });

  it('bounds recovery to three failed reads', async () => {
    const rerender = await open(taskResponse(PLAN_MERGE_STEP_ID, { parked: true }));
    net.get.mockRejectedValue(new Error('Recovery unavailable'));
    rerender(null);
    await settle();
    await vi.advanceTimersByTimeAsync(4000);
    expect(taskFetches()).toBe(4);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(taskFetches()).toBe(4);
    expect(onSettled).not.toHaveBeenCalled();
  });

  it('stops recovery retries after a readable working task', async () => {
    const rerender = await open(taskResponse(PLAN_MERGE_STEP_ID, { parked: true }));
    net.get.mockRejectedValueOnce(new Error('Temporary recovery failure'));
    rerender(null);
    await settle();
    respondWith(taskResponse(PLAN_MERGE_STEP_ID));
    await vi.advanceTimersByTimeAsync(2000);
    expect(taskFetches()).toBe(3);
    expect(vi.getTimerCount()).toBe(0);
    expect(onSettled).not.toHaveBeenCalled();
    expect(shown().find((el) => el.props.role === 'status')).toBeUndefined();
  });

  it('drops a recovered outcome if another merge is displayed before it returns', async () => {
    const rerender = await open(taskResponse(PLAN_MERGE_STEP_ID, { parked: true }));
    const recovery = deferred<unknown>();
    net.get.mockReturnValueOnce(recovery.promise);
    rerender(null);
    await settle();
    rerender({ ...merge, taskId: 'task-2' });
    await settle();
    recovery.resolve(taskResponse(PLAN_MERGE_STEP_ID, { status: 'failed' }));
    await settle();
    expect(onSettled).not.toHaveBeenCalled();
    expect(shown().find((el) => el.props.role === 'status')).toBeUndefined();
  });

  it('does not set state or notify the page when recovery resolves after unmount', async () => {
    const rerender = await open(taskResponse(PLAN_MERGE_STEP_ID, { parked: true }));
    const recovery = deferred<unknown>();
    net.get.mockReturnValueOnce(recovery.promise);
    rerender(null);
    await settle();
    unmount();
    unmount = () => {};
    const writes = rt.stateWrites;
    recovery.resolve(taskResponse(PLAN_MERGE_STEP_ID, { status: 'failed' }));
    await settle();
    expect(rt.stateWrites).toBe(writes);
    expect(onSettled).not.toHaveBeenCalled();
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not recover an outcome while a local Discard is pending', async () => {
    vi.stubGlobal('window', { confirm: vi.fn(() => true) });
    const request = deferred<{ ok: boolean; cancelled: boolean }>();
    net.discardPlanMerge.mockReturnValueOnce(request.promise);
    const rerender = await open(taskResponse(PLAN_MERGE_STEP_ID, { parked: true }));
    await press('Discard');
    respondWith(taskResponse(PLAN_MERGE_STEP_ID, { status: 'cancelled' }));
    rerender(null);
    await settle();
    expect(taskFetches()).toBe(1);
    expect(shown().find((el) => el.props.role === 'status')).toBeUndefined();
    request.resolve({ ok: true, cancelled: true });
    await settle();
  });

  it.each(['cancelled', 'running', 'unreadable'] as const)(
    'recovers after a failed Discard when the page removed the merge and its task is %s',
    async (status) => {
      vi.stubGlobal('window', { confirm: vi.fn(() => true) });
      const request = deferred<{ ok: boolean; cancelled: boolean }>();
      net.discardPlanMerge.mockReturnValueOnce(request.promise);
      const rerender = await open(taskResponse(PLAN_MERGE_STEP_ID, { parked: true }));
      await press('Discard');
      rerender(null);
      await settle();
      expect(taskFetches()).toBe(1);
      expect(shown().find((el) => el.props.role === 'status')).toBeUndefined();

      if (status === 'unreadable') net.get.mockRejectedValue(new Error('Recovery unavailable'));
      else respondWith(taskResponse(PLAN_MERGE_STEP_ID, { status }));
      request.reject(new Error('Discard request failed'));
      await settle();

      const outcome = shown().find((el) => el.props.role === 'status');
      if (status === 'cancelled') {
        expect(shownIn(outcome).find((el) => el.type === InlineMarkdown)?.props.body).toBe(
          'This merge was cancelled elsewhere. Its scratch worktree may be discarded unless another merge holds it. This does not undo changes already merged into your checkout.',
        );
        expect(onSettled).toHaveBeenCalledTimes(1);
      } else {
        expect(outcome).toBeUndefined();
        expect(onSettled).not.toHaveBeenCalled();
      }
      expect(shown().find((el) => el.type === FormError)?.props.message).toBe(
        'Discard request failed',
      );
      expect(taskFetches()).toBe(2);
      expect(labelled('Discard')).toBeUndefined();
      expect(host('textarea')).toBeUndefined();

      await vi.advanceTimersByTimeAsync(20_000);
      expect(taskFetches()).toBe(status === 'unreadable' ? 4 : 2);
      expect(vi.getTimerCount()).toBe(0);
      expect(shown().find((el) => el.type === FormError)?.props.message).toBe(
        'Discard request failed',
      );
    },
  );

  it('keeps a locally requested discard quiet when the poll observes cancellation', async () => {
    vi.stubGlobal('window', { confirm: vi.fn(() => true) });
    net.discardPlanMerge.mockResolvedValue({ ok: true, cancelled: true, taskId: 'task-1' });
    const rerender = await open(taskResponse(PLAN_MERGE_STEP_ID, { parked: true }));
    await press('Discard');
    onSettled.mockImplementationOnce(() => rerender(null));
    respondWith(taskResponse(PLAN_MERGE_STEP_ID, { status: 'cancelled' }));

    await vi.advanceTimersByTimeAsync(2000);

    expect(onSettled).toHaveBeenCalledTimes(2);
    expect(shown().find((el) => el.props.role === 'status')).toBeUndefined();
  });

  it('announces the next end after a locally discarded merge is revived', async () => {
    vi.stubGlobal('window', { confirm: vi.fn(() => true) });
    net.discardPlanMerge.mockResolvedValue({ ok: true, cancelled: true });
    const rerender = await open(taskResponse(PLAN_MERGE_STEP_ID, { parked: true }));
    await press('Discard');
    rerender(null);
    await settle();
    expect(shown().find((el) => el.props.role === 'status')).toBeUndefined();
    respondWith(taskResponse(PLAN_MERGE_STEP_ID));
    rerender(merge);
    await settle();
    onSettled.mockClear();
    respondWith(taskResponse(PLAN_MERGE_STEP_ID, { status: 'failed' }));
    await vi.advanceTimersByTimeAsync(2000);
    expect(shown().find((el) => el.props.role === 'status')).toBeDefined();
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it('keeps a cancellation quiet before the local Discard response arrives', async () => {
    vi.stubGlobal('window', { confirm: vi.fn(() => true) });
    const request = deferred<{ ok: boolean; cancelled: boolean }>();
    net.discardPlanMerge.mockReturnValueOnce(request.promise);
    await open(taskResponse(PLAN_MERGE_STEP_ID));
    await press('Discard');
    respondWith(taskResponse(PLAN_MERGE_STEP_ID, { status: 'cancelled' }));

    await vi.advanceTimersByTimeAsync(2000);

    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(shown().find((el) => el.props.role === 'status')).toBeUndefined();
    request.resolve({ ok: true, cancelled: true });
    await settle();
    expect(shown().find((el) => el.props.role === 'status')).toBeUndefined();
  });

  it.each(['failure', 'not-cancelled'])(
    'clears local Discard suppression after %s',
    async (result) => {
      vi.stubGlobal('window', { confirm: vi.fn(() => true) });
      const request = deferred<{ ok: boolean; cancelled: boolean }>();
      net.discardPlanMerge.mockReturnValueOnce(request.promise);
      await open(taskResponse(PLAN_MERGE_STEP_ID));
      await press('Discard');
      if (result === 'failure') request.reject(new Error('Discard failed'));
      else request.resolve({ ok: true, cancelled: false });
      await settle();
      respondWith(taskResponse(PLAN_MERGE_STEP_ID, { status: 'cancelled' }));
      await vi.advanceTimersByTimeAsync(2000);
      expect(shown().find((el) => el.type === InlineMarkdown)?.props.body).toBe(
        'This merge was cancelled elsewhere. Its scratch worktree may be discarded unless another merge holds it. This does not undo changes already merged into your checkout.',
      );
    },
  );

  it('clears refused Discard suppression even after switching to another merge', async () => {
    vi.stubGlobal('window', { confirm: vi.fn(() => true) });
    const request = deferred<{ ok: boolean; cancelled: boolean }>();
    net.discardPlanMerge.mockReturnValueOnce(request.promise);
    const rerender = await open(taskResponse(PLAN_MERGE_STEP_ID));
    await press('Discard');
    rerender({ ...merge, taskId: 'task-2' });
    await settle();
    request.resolve({ ok: true, cancelled: false });
    await settle();
    respondWith(taskResponse(PLAN_MERGE_STEP_ID, { status: 'cancelled' }));
    rerender(merge);
    await settle();
    expect(shown().find((el) => el.props.role === 'status')).toBeDefined();
  });

  it('confirms Discard without promising that the checkout has not moved', async () => {
    const confirm = vi.fn(() => false);
    vi.stubGlobal('window', { confirm });
    await open(taskResponse(PLAN_MERGE_STEP_ID));
    await press('Discard');
    expect(confirm).toHaveBeenCalledWith(
      'Discard this merge? Its scratch worktree may be removed. Changes already merged into your checkout will remain.',
    );
    expect(net.discardPlanMerge).not.toHaveBeenCalled();
    const footer = shown()
      .filter((el) => el.type === 'p')
      .flatMap((el) => el.props.children)
      .filter((child) => typeof child === 'string')
      .join('');
    expect(footer).toContain(
      'The merge is prepared in a scratch worktree. Confirm merges it into your checkout and pushes it.',
    );
  });

  it('does not infer an outcome from a working task’s status message', async () => {
    const response = taskResponse(PLAN_MERGE_STEP_ID);
    response.steps[0]!.statusMessage = 'The merge failed, completed or was cancelled';
    await open(response);
    expect(shown().find((el) => el.props.role === 'status')).toBeUndefined();
    expect(onSettled).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);
  });

  it.each([
    ['answer', 'success'],
    ['answer', 'error'],
    ['discard', 'cancelled'],
    ['discard', 'notice'],
    ['discard', 'error'],
  ])('ignores a late %s %s from the previous merge', async (action, result) => {
    vi.stubGlobal('window', { confirm: vi.fn(() => true) });
    const old = deferred<{ ok: boolean; cancelled: boolean }>();
    const next = deferred<{ ok: boolean; cancelled: boolean }>();
    const request = action === 'answer' ? net.submitPlanMergeTurn : net.discardPlanMerge;
    request.mockImplementationOnce(() => old.promise).mockImplementationOnce(() => next.promise);
    const rerender = await open(taskResponse(PLAN_MERGE_STEP_ID, { parked: true }));
    await press(action === 'answer' ? CONFIRM : 'Discard');
    rerender({ ...merge, taskId: 'task-2' });
    await settle();
    await typeDraft('instructions for B');
    await press(action === 'answer' ? CONFIRM : 'Discard');
    const changedBefore = onChanged.mock.calls.length;
    const settledBefore = onSettled.mock.calls.length;
    const fetchedBefore = taskFetches();

    if (result === 'error') old.reject({ message: 'Error from A' });
    else old.resolve({ ok: true, cancelled: result === 'cancelled' });
    await settle();

    expect(shown().find((el) => el.type === FormError)?.props.message).toBeNull();
    expect(host('textarea')?.props.value).toBe('instructions for B');
    expect(host('textarea')?.props.disabled).toBe(true);
    expect(labelled('Discard')?.props.disabled).toBe(true);
    expect(onChanged).toHaveBeenCalledTimes(changedBefore);
    expect(onSettled).toHaveBeenCalledTimes(settledBefore);
    expect(taskFetches()).toBe(fetchedBefore);
    rerender(null);
    await settle();
    expect(shown().find((el) => el.props.role === 'status')).toBeUndefined();
    next.resolve({ ok: true, cancelled: false });
    await settle();
  });

  it.each([true, false])(
    'settles Discard after the page removed the merge (cancelled: %s)',
    async (cancelled) => {
      vi.stubGlobal('window', { confirm: vi.fn(() => true) });
      const request = deferred<{ ok: boolean; cancelled: boolean }>();
      net.discardPlanMerge.mockReturnValueOnce(request.promise);
      const rerender = await open(taskResponse(PLAN_MERGE_STEP_ID, { parked: true }));
      await press('Discard');
      rerender(null);
      request.resolve({ ok: true, cancelled });
      await settle();
      expect(onSettled).toHaveBeenCalledTimes(1);
      expect(hasNotice()).toBe(!cancelled);
    },
  );

  it.each([
    ['step_form_not_waiting', 'The form is closed', true],
    [undefined, 'No step awaiting form submission for id 01-plan-merge', false],
    ['another_conflict', 'No step awaiting form submission for id 01-plan-merge', false],
  ])('classifies an ended merge answer by code %s', async (code, message, ended) => {
    net.submitPlanMergeTurn.mockRejectedValueOnce({ code, message });
    await open(taskResponse(PLAN_MERGE_STEP_ID, { parked: true }));
    await press(CONFIRM);
    expect(shown().find((el) => el.type === FormError)?.props.message).toBe(
      ended ? 'That merge is no longer awaiting an answer. Refreshing its status.' : message,
    );
    expect(onChanged).toHaveBeenCalledTimes(ended ? 2 : 1);
  });

  it('accepts an answer that settles after the page removed the merge', async () => {
    const request = deferred<unknown>();
    net.submitPlanMergeTurn.mockReturnValueOnce(request.promise);
    const rerender = await open(taskResponse(PLAN_MERGE_STEP_ID, { parked: true }));
    await press(CONFIRM);
    const before = onChanged.mock.calls.length;
    rerender(null);
    request.resolve(undefined);
    await settle();
    expect(onChanged).toHaveBeenCalledTimes(before + 1);
  });

  it('keeps the already-ended notice after the page refresh removes the merge', async () => {
    vi.stubGlobal('window', { confirm: vi.fn(() => true) });
    net.discardPlanMerge.mockResolvedValue({ ok: true, cancelled: false });
    const rerender = await open(taskResponse(PLAN_MERGE_STEP_ID, { parked: true }));
    onSettled.mockImplementationOnce(() => rerender(null));

    await press('Discard');

    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(hasNotice()).toBe(true);
    expect(shown().find((el) => el.props.role === 'status')).toBeDefined();
    expect(labelled('Discard')).toBeUndefined();
    expect(host('textarea')).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reports a merge that already ended without treating it as discarded', async () => {
    vi.stubGlobal('window', { confirm: vi.fn(() => true) });
    net.discardPlanMerge.mockResolvedValue({ ok: true, cancelled: false });
    await open(taskResponse(PLAN_MERGE_STEP_ID, { parked: true }));

    await press('Discard');

    expect(net.discardPlanMerge).toHaveBeenCalledWith('repo-1', 'task-1');
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(labelled(CONFIRM)).toBeDefined();
    expect(host('textarea')).toBeDefined();
    expect(pulsing()).toBe(false);
    expect(shown().find((el) => el.type === FormError)?.props.message).toBeNull();
    const status = shown().find((el) => el.props.role === 'status');
    expect(status).toBeDefined();
    expect(shownIn(status).find((el) => el.type === InlineMarkdown)?.props.body).toBe(NOTICE);
    expect(taskFetches()).toBe(1);
  });

  it.each(['notice', 'error'] as const)(
    'resets the old %s and draft for a new merge task',
    async (outcome) => {
      vi.stubGlobal('window', { confirm: vi.fn(() => true) });
      if (outcome === 'notice')
        net.discardPlanMerge.mockResolvedValue({ ok: true, cancelled: false });
      else net.discardPlanMerge.mockRejectedValue({ message: 'Discard request failed' });
      const rerender = await open(taskResponse(PLAN_MERGE_STEP_ID, { parked: true }));
      await typeDraft('old merge instructions');
      await press('Discard');
      expect(
        outcome === 'notice'
          ? hasNotice()
          : shown().some((el) => el.props.message === 'Discard request failed'),
      ).toBe(true);

      rerender(null);
      rerender({ ...merge, taskId: 'task-2' });
      await settle();

      expect(hasNotice()).toBe(false);
      expect(shown().find((el) => el.type === FormError)?.props.message).toBeNull();
      expect(host('textarea')?.props.value).toBe('');
    },
  );

  it.each(['answer', 'discard'] as const)(
    'clears the previous outcome when trying to %s again',
    async (action) => {
      vi.stubGlobal('window', { confirm: vi.fn(() => true) });
      net.discardPlanMerge.mockResolvedValue({ ok: true, cancelled: false });
      await open(taskResponse(PLAN_MERGE_STEP_ID, { parked: true }));
      await press('Discard');
      expect(hasNotice()).toBe(true);
      net.discardPlanMerge.mockRejectedValue({ message: 'Next request failed' });
      net.submitPlanMergeTurn.mockRejectedValue({ message: 'Next request failed' });

      await press(action === 'answer' ? CONFIRM : 'Discard');

      expect(hasNotice()).toBe(false);
      expect(shown().find((el) => el.props.role === 'status')).toBeUndefined();
      expect(shown().find((el) => el.type === FormError)?.props.message).toBe(
        'Next request failed',
      );
    },
  );

  it('treats the merge as discarded only when DELETE cancelled it', async () => {
    vi.stubGlobal('window', { confirm: vi.fn(() => true) });
    net.discardPlanMerge.mockResolvedValue({ ok: true, cancelled: true, taskId: 'task-1' });
    await open(taskResponse(PLAN_MERGE_STEP_ID, { parked: true }));

    await press('Discard');

    expect(net.discardPlanMerge).toHaveBeenCalledWith('repo-1', 'task-1');
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(labelled(CONFIRM)).toBeUndefined();
    expect(host('textarea')).toBeUndefined();
    expect(pulsing()).toBe(true);
    expect(shown().find((el) => el.type === FormError)?.props.message).toBeNull();
    expect(taskFetches()).toBe(2);
    // A second press could only answer "nothing was discarded" about the discard that just happened.
    expect(labelled('Discard')?.props.disabled).toBe(true);
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
