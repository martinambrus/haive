import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CliAuthBannerModal } from './cli-auth-banner-modal';
import { buttons, createRenderer, fire, textOf, type Renderer } from '../../test/render-tree';

const h = vi.hoisted(() => ({ stateUpdate: vi.fn() }));
vi.mock('react', async (original) => {
  const { reactHooks } = await import('../../test/render-tree');
  return {
    ...(await original<typeof import('react')>()),
    ...reactHooks,
    useState(initial: unknown) {
      const [value, set] = reactHooks.useState(initial);
      const trackedSet = reactHooks.useMemo(
        () => (update: unknown) => {
          h.stateUpdate();
          (set as (update: unknown) => void)(update);
        },
        [set],
      );
      return [value, trackedSet];
    },
  };
});
vi.mock('@xterm/xterm', () => ({ Terminal: class {} }));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class {} }));
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class {} }));
vi.mock('@xterm/addon-clipboard', () => ({ ClipboardAddon: class {} }));
vi.mock('@/lib/api-client', () => ({ apiWebSocketUrl: (path: string) => `ws://localhost${path}` }));
vi.mock('@/lib/use-pending-cli-copy', () => ({
  usePendingCliCopy: () => ({ pendingChars: null }),
}));
vi.mock('@/lib/cli-jobs', () => ({ runCliProbe: vi.fn() }));
vi.mock('@/components/ui', async () => {
  const { createElement } = await import('react');
  return {
    Button: ({ children, ...props }: Record<string, unknown>) =>
      createElement('button', props, children as never),
    FormError: ({ message }: { message: string | null }) => message,
  };
});

class FakeWebSocket {
  static OPEN = 1;
  static instances: FakeWebSocket[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(_url: string) {
    FakeWebSocket.instances.push(this);
  }
  close = vi.fn(() => {
    this.readyState = 3;
    this.onclose?.();
  });
  send = vi.fn();
  frame(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}
let view: Renderer;
let open: boolean;
let mounted: boolean;
let onClose: ReturnType<typeof vi.fn<() => void>>;
let socket: FakeWebSocket;

beforeEach(() => {
  vi.useFakeTimers();
  FakeWebSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeWebSocket);
  vi.stubGlobal('document', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  open = true;
  mounted = true;
  onClose = vi.fn(() => {
    open = false;
  });
  view = createRenderer(() =>
    mounted ? (
      <CliAuthBannerModal
        open={open}
        providerId="provider"
        providerLabel="Claude"
        providerName="claude-code"
        onClose={onClose}
      />
    ) : null,
  );
  socket = FakeWebSocket.instances[0]!;
});
afterEach(() => {
  mounted = false;
  view.draw();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function assertClosedError() {
  view.draw();
  expect(textOf(view.tree())).toContain('Connection closed');
  expect(buttons(view.tree(), 'retry')).toHaveLength(1);
  expect(textOf(view.tree())).not.toContain('Waiting for a free CLI slot');
}

async function exhaustUrlAttempts() {
  for (let attempt = 1; attempt <= 3; attempt++) {
    socket = FakeWebSocket.instances.at(-1)!;
    socket.readyState = FakeWebSocket.OPEN;
    socket.onopen?.();
    socket.frame({ type: 'phase', phase: 'awaiting-token' });
    view.draw();
    await vi.advanceTimersByTimeAsync(30_000);
    view.draw();
  }
}

describe('CLI auth banner socket close', () => {
  it.each(['connecting', 'starting', 'awaiting-token', 'awaiting-approval', 'submitting'])(
    'offers retry after a server close during %s',
    (phase) => {
      if (phase !== 'connecting') socket.frame({ type: 'phase', phase });
      view.draw();
      socket.close();
      assertClosedError();
      fire.click(buttons(view.tree(), 'retry')[0]!);
      view.draw();
      expect(FakeWebSocket.instances).toHaveLength(2);
      expect(textOf(view.tree())).toContain('Connecting...');
      expect(textOf(view.tree())).not.toContain('Connection closed');
    },
  );

  it('uses the most recent phase when frames and close arrive before a render', () => {
    socket.frame({ type: 'auth-url', url: 'https://claude.ai/oauth/authorize' });
    socket.frame({ type: 'auth-success' });
    socket.close();
    view.draw();
    expect(textOf(view.tree())).toContain('Authentication successful');
    expect(buttons(view.tree(), 'retry')).toHaveLength(0);
  });

  it('clears the queued panel when the socket closes', () => {
    socket.frame({ type: 'queue', running: 1, agents: 1, service: 0, ahead: 0 });
    view.draw();
    socket.close();
    assertClosedError();
  });

  it.each(['success', 'saved', 'error'])('preserves the final %s phase on close', (phase) => {
    socket.frame(
      phase === 'success'
        ? { type: 'auth-success' }
        : phase === 'saved'
          ? { type: 'saved', result: { cli: { authStatus: 'ok' } } }
          : { type: 'error', message: 'Existing failure' },
    );
    // Deliberately close before rendering to exercise queued state updates.
    socket.close();
    view.draw();
    expect(textOf(view.tree())).not.toContain('Connection closed');
    expect(textOf(view.tree())).toContain(
      phase === 'success'
        ? 'Authentication successful'
        : phase === 'saved'
          ? 'Signed in and verified'
          : 'Existing failure',
    );
  });

  it('fix4 ignores late message and close callbacks after the modal is hidden', () => {
    h.stateUpdate.mockClear();
    open = false;
    view.draw();
    expect(socket.close).toHaveBeenCalledWith(1000, 'unmount');
    socket.frame({ type: 'auth-url', url: 'https://claude.ai/oauth/authorize' });
    socket.onclose?.();
    socket.onerror?.();
    expect(h.stateUpdate).not.toHaveBeenCalled();
  });

  it('ignores its own Close button and late close events after reopening', () => {
    fire.click(buttons(view.tree(), 'close')[0]!);
    view.draw();
    open = true;
    view.draw();
    socket.onclose?.();
    socket.onerror?.();
    view.draw();
    expect(textOf(view.tree())).toContain('Connecting...');
    expect(textOf(view.tree())).not.toContain('Connection closed');
  });

  it('fix4 ignores late message and close callbacks after unmount', () => {
    h.stateUpdate.mockClear();
    mounted = false;
    view.draw();
    socket.frame({ type: 'error', message: 'Late failure' });
    socket.onclose?.();
    socket.onerror?.();
    expect(h.stateUpdate).not.toHaveBeenCalled();
  });

  it('fix4 ignores frames, errors and closes from a socket disposed by Retry', () => {
    socket.frame({ type: 'error', message: 'Retryable failure' });
    view.draw();
    fire.click(buttons(view.tree(), 'retry')[0]!);
    view.draw();
    const before = textOf(view.tree());
    h.stateUpdate.mockClear();
    socket.frame({ type: 'error', message: 'Late failure' });
    socket.onclose?.();
    socket.onerror?.();
    expect(h.stateUpdate).not.toHaveBeenCalled();
    expect(textOf(view.draw()) === before).toBe(true);
  });

  it('fix3 preserves the URL-wait give-up error after a later server close', async () => {
    await exhaustUrlAttempts();
    expect(buttons(view.tree(), 'retry')).toHaveLength(1);
    const before = textOf(view.tree());
    socket.close();
    view.draw();
    expect(textOf(view.tree()) === before).toBe(true);
  });

  it('preserves the explicit connection timeout error', async () => {
    await vi.advanceTimersByTimeAsync(15_000);
    view.draw();
    expect(textOf(view.tree())).toContain('Connection timed out');
    expect(textOf(view.tree())).not.toContain('Connection closed');
  });
});
