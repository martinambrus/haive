import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CliAuthBannerModal } from './cli-auth-banner-modal';
import { buttons, createRenderer, fire, textOf, type Renderer } from '../../test/render-tree';

vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  ...(await import('../../test/render-tree')).reactHooks,
}));
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
    socket.close();
    assertClosedError();
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

  it('ignores the close initiated when the modal is hidden', () => {
    open = false;
    view.draw();
    expect(socket.close).toHaveBeenCalledWith(1000, 'unmount');
    expect(textOf(view.tree())).toBe('');
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

  it('ignores close callbacks from an unmounted session', () => {
    mounted = false;
    view.draw();
    socket.onclose?.();
    expect(textOf(view.draw())).toBe('');
  });

  it('preserves the explicit connection timeout error', async () => {
    await vi.advanceTimersByTimeAsync(15_000);
    view.draw();
    expect(textOf(view.tree())).toContain('Connection timed out');
    expect(textOf(view.tree())).not.toContain('Connection closed');
  });
});
