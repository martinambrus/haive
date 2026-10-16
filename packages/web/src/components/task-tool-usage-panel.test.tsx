import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskToolUsage, TaskToolUsageStep } from '@/lib/api-client';
import { TaskToolUsagePanel, TaskToolUsageTable } from './task-tool-usage-table';

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
    if (!(at in rt.slots)) rt.slots[at] = initial;
    const set = (next: unknown) => {
      if (Object.is(next, rt.slots[at])) return;
      rt.slots[at] = next;
      rt.dirty = true;
      if (!rt.rendering) void Promise.resolve().then(() => rt.redraw());
    };
    return [rt.slots[at], set];
  },
  useEffect: (run: () => unknown, deps?: unknown[]) => {
    rt.queued.push({ deps, run });
  },
}));

const net = vi.hoisted(() => ({ getTaskToolUsage: vi.fn() }));
vi.mock('@/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-client')>()),
  getTaskToolUsage: net.getTaskToolUsage,
}));

const NO_RUN: TaskToolUsageStep = {
  runs: 0,
  observable: 0,
  partial: 0,
  unobservable: 0,
  unrecorded: 0,
  personasAssigned: [],
  personasRead: [],
  skillsInvoked: [],
  skillsRead: [],
  mcp: [],
  subagents: [],
  toolCalls: 0,
};
const answer = (call: { ok?: number; running?: number }): TaskToolUsage => ({
  taskId: 'task-1',
  steps: [],
  totals: NO_RUN,
  coverage: { total: 0, observable: 0, partial: 0, unobservable: 0, unrecorded: 0 },
  callTotals: {
    customTools: [
      { tool: 'lookup', action: 'http-get', ok: 0, refused: 0, error: 0, running: 0, ...call },
    ],
    integrations: [],
  },
});
const RUNNING = answer({ running: 2 });
const ONE_SETTLED = answer({ ok: 1, running: 1 });
const DONE = '2026-10-16T09:00:00.000Z';

type Props = Parameters<typeof TaskToolUsagePanel>[0];
const FIRST: Props = {
  taskId: 'task-1',
  taskCompletedAt: null,
  loggedCallCount: 2,
  runningCallCount: 2,
};

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const deferred = () => {
  let resolve!: (value: TaskToolUsage) => void;
  const promise = new Promise<TaskToolUsage>((res) => (resolve = res));
  return { promise, resolve };
};
const shown = () => {
  const root = rt.tree as { type: unknown; props: { data?: TaskToolUsage } };
  return root.type === TaskToolUsageTable ? root.props.data : undefined;
};

async function mount() {
  let props = FIRST;
  rt.slots = [];
  rt.ran = [];
  const draw = () => {
    rt.rendering = true;
    try {
      for (let pass = 0; pass < 20; pass++) {
        rt.at = 0;
        rt.dirty = false;
        rt.queued = [];
        rt.tree = TaskToolUsagePanel(props);
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
  await settle();
  return {
    rerender: async (change: Partial<Props>) => {
      props = { ...props, ...change };
      draw();
      await settle();
    },
  };
}

describe('TaskToolUsagePanel', () => {
  beforeEach(() => {
    net.getTaskToolUsage.mockReset();
    net.getTaskToolUsage.mockResolvedValue(RUNNING);
  });

  it('reads the task usage when it mounts and shows the answer', async () => {
    await mount();
    expect(net.getTaskToolUsage.mock.calls).toEqual([['task-1']]);
    expect(shown()).toBe(RUNNING);
  });

  it.each([
    ['logged call count', { loggedCallCount: 3 }],
    ['running call count', { runningCallCount: 1 }],
    ['completion time', { taskCompletedAt: DONE }],
    ['task', { taskId: 'task-2' }],
  ])('reads the task usage again when its %s changes', async (_name, change) => {
    const panel = await mount();
    await panel.rerender(change);
    expect(net.getTaskToolUsage).toHaveBeenCalledTimes(2);
  });

  it('does not read it again when a rerender changes none of them', async () => {
    const panel = await mount();
    await panel.rerender({});
    await panel.rerender({ loggedCallCount: 2, runningCallCount: 2 });
    expect(net.getTaskToolUsage).toHaveBeenCalledTimes(1);
  });

  it('shows a call as settled once the running count falls', async () => {
    const panel = await mount();
    expect(shown()).toBe(RUNNING);
    net.getTaskToolUsage.mockResolvedValue(ONE_SETTLED);
    await panel.rerender({ runningCallCount: 1 });
    expect(shown()).toBe(ONE_SETTLED);
  });

  it('keeps the answer to the newest read when an older one lands last', async () => {
    const older = deferred();
    const newer = deferred();
    net.getTaskToolUsage.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    const panel = await mount();
    await panel.rerender({ taskCompletedAt: DONE });
    newer.resolve(ONE_SETTLED);
    await settle();
    older.resolve(RUNNING);
    await settle();
    expect(shown()).toBe(ONE_SETTLED);
  });

  it('keeps what it shows when a later read fails', async () => {
    const panel = await mount();
    net.getTaskToolUsage.mockRejectedValue(new Error('gone'));
    await panel.rerender({ taskCompletedAt: DONE });
    expect(shown()).toBe(RUNNING);
  });
});
