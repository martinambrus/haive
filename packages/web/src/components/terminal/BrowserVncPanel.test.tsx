import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BrowserVncPanel } from './BrowserVncPanel';

// This package uses Node tests. Keep hooks in slots and attach the panel's host refs.
const h = vi.hoisted(() => ({
  slots: [] as unknown[],
  at: 0,
  effects: [] as (() => unknown)[],
  tree: undefined as unknown,
  sockets: [] as WebSocket[],
  rfbs: [] as EventTarget[],
}));
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useState: (initial: unknown) => {
    const at = h.at++;
    if (!(at in h.slots)) h.slots[at] = initial;
    return [
      h.slots[at],
      (v: unknown) => {
        h.slots[at] = v;
      },
    ];
  },
  useRef: (initial: unknown) => {
    const at = h.at++;
    if (!(at in h.slots)) h.slots[at] = { current: initial };
    return h.slots[at];
  },
  useCallback: (fn: unknown) => fn,
  useEffect: (fn: () => unknown) => {
    h.effects.push(fn);
  },
}));
vi.mock('@/lib/api-client', () => ({
  api: {},
  apiWebSocketUrl: (path: string) => `ws://localhost${path}`,
}));
vi.mock('@/lib/use-persisted-toggle', () => ({
  usePersistedToggle: () => [true, vi.fn(), vi.fn()],
}));
vi.mock('@/lib/use-float-window', () => ({ useFloatWindow: () => ({}) }));
vi.mock('@/lib/use-split-pane', () => ({ useSplitPane: () => ({}) }));
vi.mock('@/lib/use-keyboard-fullscreen', () => ({
  useKeyboardFullscreen: () => ({ exit: vi.fn() }),
}));
vi.mock('@/lib/suppress-novnc-log', () => ({ suppressNovncCloseLog: vi.fn() }));
vi.mock('@/components/markdown/inline-markdown', () => ({ InlineMarkdown: () => null }));
vi.mock('./SplitTerminalPane', () => ({ SplitTerminalPane: () => null }));
vi.mock('@novnc/novnc', () => ({
  default: class extends EventTarget {
    constructor(_target: unknown, urlOrSocket: string | WebSocket) {
      super();
      // noVNC accepts a URL or an existing raw channel. Its public disconnect event
      // intentionally drops CloseEvent.code, matching the installed client's API.
      const socket = typeof urlOrSocket === 'string' ? new WebSocket(urlOrSocket) : urlOrSocket;
      socket.onclose = () =>
        this.dispatchEvent(new CustomEvent('disconnect', { detail: { clean: false } }));
      h.rfbs.push(this);
    }
    disconnect() {}
    focus() {}
  },
}));

class Socket extends EventTarget {
  onclose: ((e: CloseEvent) => unknown) | null = null;
  constructor(_url: string) {
    super();
    h.sockets.push(this as unknown as WebSocket);
  }
  close() {}
  drop(code: number, reason: string) {
    const event = Object.assign(new Event('close'), { code, reason }) as CloseEvent;
    this.dispatchEvent(event);
    this.onclose?.(event);
  }
}
type Element = { type: unknown; props: Record<string, unknown> };
function elements(node: unknown): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== 'object' || !('props' in node)) return [];
  const el = node as Element;
  return [el, ...elements(el.props.children)];
}
function draw() {
  h.at = 0;
  h.effects = [];
  h.tree = BrowserVncPanel({ taskId: 'task', autoCollapse: false });
  for (const el of elements(h.tree)) {
    const ref = el.props.ref as { current: unknown } | undefined;
    if (ref && typeof ref === 'object') ref.current = {};
  }
}
beforeEach(async () => {
  vi.useFakeTimers();
  vi.stubGlobal('WebSocket', Socket);
  vi.stubGlobal('document', { fullscreenElement: null });
  h.slots = [];
  h.sockets = [];
  h.rfbs = [];
  draw();
  for (const effect of h.effects) effect();
  await vi.advanceTimersByTimeAsync(0);
  h.rfbs[0]!.dispatchEvent(new Event('connect'));
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it.each(['arbitrary display copy', ''])(
  '1008 ends a live VNC session without reconnecting (reason %j)',
  async (reason) => {
    (h.sockets[0] as unknown as Socket).drop(1008, reason);
    draw();
    const error = elements(h.tree).find(
      (el) => el.type === 'p' && String(el.props.className).includes('text-amber-400'),
    );
    expect(error).toBeDefined();
    await vi.advanceTimersByTimeAsync(180_000);
    expect(h.sockets).toHaveLength(1);
  },
);

it('an ordinary live drop still reconnects', async () => {
  (h.sockets[0] as unknown as Socket).drop(1006, 'session_revoked');
  await vi.advanceTimersByTimeAsync(3000);
  expect(h.sockets).toHaveLength(2);
});
