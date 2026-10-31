import { afterEach, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import type { PlanNodeDetail } from '@/lib/api-client';
import { PlanDetailPanel } from './plan-detail-panel';
import { PlanChat } from './plan-chat';

type Effect = { deps: unknown[]; cleanup?: unknown };
type Context = { slots: unknown[]; effects: Effect[]; at: number; effectAt: number };
const rt = vi.hoisted(() => ({ current: null as Context | null, dirty: false }));
const same = (a: unknown[] | undefined, b: unknown[]) =>
  a?.length === b.length && a.every((v, i) => Object.is(v, b[i]));
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useState: (initial: unknown) => {
    const ctx = rt.current!;
    const at = ctx.at++;
    if (!(at in ctx.slots)) ctx.slots[at] = typeof initial === 'function' ? initial() : initial;
    return [
      ctx.slots[at],
      (update: unknown) => {
        const next = typeof update === 'function' ? update(ctx.slots[at]) : update;
        if (!Object.is(next, ctx.slots[at])) {
          ctx.slots[at] = next;
          rt.dirty = true;
        }
      },
    ];
  },
  useRef: (initial: unknown) => {
    const ctx = rt.current!;
    const at = ctx.at++;
    if (!(at in ctx.slots)) ctx.slots[at] = { current: initial };
    return ctx.slots[at];
  },
  useMemo: (fn: () => unknown) => fn(),
  useCallback: (fn: unknown, deps: unknown[]) => {
    const ctx = rt.current!;
    const at = ctx.at++;
    const previous = ctx.slots[at] as { fn: unknown; deps: unknown[] } | undefined;
    if (!previous || !same(previous.deps, deps)) ctx.slots[at] = { fn, deps };
    return (ctx.slots[at] as { fn: unknown }).fn;
  },
  useEffect: (run: () => unknown, deps: unknown[]) => {
    const ctx = rt.current!;
    const at = ctx.effectAt++;
    const previous = ctx.effects[at];
    if (previous && same(previous.deps, deps)) return;
    if (typeof previous?.cleanup === 'function') previous.cleanup();
    ctx.effects[at] = { deps, cleanup: run() };
  },
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/lib/api-client', async (original) => ({
  ...(await original<typeof import('@/lib/api-client')>()),
  getPlanNode: async (_repo: string, id: string): Promise<PlanNodeDetail> => ({
    node: {
      id,
      parentId: null,
      path: `/${id}/`,
      ordinal: 0,
      title: id,
      kind: 'component',
      body: null,
      status: 'todo',
      taskable: true,
      version: 1,
      createdBy: 'user',
      sourceTaskId: null,
      directChildren: 0,
      totalDescendants: 0,
      rolledStatus: 'todo',
      sequence: 1,
      blockedBy: [],
      driftedTasks: 0,
      createdAt: '',
      updatedAt: '',
    },
    ancestry: [],
    children: [],
    edges: [],
    codeLinks: [],
    tasks: [],
  }),
  getPlanMessages: async () => ({ messages: [], conversations: [] }),
  getPlanBuildClis: async () => ({ plannerCliProviderId: null }),
  markPlanNodeRead: async () => undefined,
  api: { get: async () => ({ providers: [] }) },
}));
vi.mock('@/components/markdown/markdown-view', () => ({ MarkdownView: () => null }));

const context = (): Context => ({ slots: [], effects: [], at: 0, effectAt: 0 });
const cleanup = (ctx: Context) =>
  ctx.effects.forEach((e) => {
    if (typeof e.cleanup === 'function') e.cleanup();
  });
type Element = { type: unknown; props: Record<string, unknown> };
const elements = (node: unknown): Element[] => {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== 'object' || !('props' in node)) return [];
  const el = node as Element;
  return [el, ...elements(el.props.children)];
};
let dispose = () => {};
afterEach(() => {
  dispose();
  vi.unstubAllGlobals();
});

it('keeps node A’s draft through PlanDetailPanel selection, loading and chat remounts', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('Unexpected network request');
    }),
  );
  const drafts = new Map<string, string>(); // same owner as the page's ref
  const parent = context();
  let child: Context | null = null;
  let nodeId = 'node-A';
  let transcript: ReactNode = null;
  const draw = () => {
    for (let pass = 0; pass < 20; pass++) {
      rt.dirty = false;
      rt.current = parent;
      parent.at = 0;
      parent.effectAt = 0;
      const tree = PlanDetailPanel({
        repositoryId: 'repo-1',
        nodeId,
        tree: [],
        tab: 'chat',
        chatDrafts: drafts,
        unreadCount: 0,
        onRead: vi.fn(),
        onTabChange: vi.fn(),
        onChanged: vi.fn(),
        onNavigate: vi.fn(),
        onClose: vi.fn(),
      });
      const chat = elements(tree).find((el) => el.type === PlanChat);
      if (chat) {
        child ??= context();
        rt.current = child;
        child.at = 0;
        child.effectAt = 0;
        transcript = PlanChat(chat.props as Parameters<typeof PlanChat>[0]);
      } else {
        if (child) cleanup(child);
        child = null;
        transcript = null;
      }
      if (!rt.dirty) return;
    }
    throw new Error('The detail panel kept updating');
  };
  dispose = () => {
    cleanup(parent);
    if (child) cleanup(child);
  };
  const settle = async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    draw();
  };
  const textarea = () => elements(transcript).find((el) => el.type === 'textarea')!;
  const type = (value: string) => {
    (textarea().props.onChange as (e: unknown) => void)({ target: { value } });
    draw();
  };
  draw();
  await settle();
  await settle();
  type('Draft for A');
  nodeId = 'node-B';
  draw();
  expect(transcript).toBeNull(); // the detail panel's loading branch unmounted the chat
  await settle();
  await settle();
  expect(textarea().props.value).toBe('');
  type('Draft for B');
  nodeId = 'node-A';
  draw();
  expect(transcript).toBeNull();
  await settle();
  await settle();
  expect(textarea().props.value).toBe('Draft for A');
});
