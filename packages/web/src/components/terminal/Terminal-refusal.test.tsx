// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Terminal } from './Terminal';
import { InteractiveShell } from './InteractiveShell';

const h = vi.hoisted(() => ({ writeln: vi.fn() }));

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    rows = 24;
    cols = 80;
    loadAddon() {}
    attachCustomKeyEventHandler() {}
    open() {}
    refresh() {}
    focus() {}
    onData() {
      return { dispose() {} };
    }
    writeln = h.writeln;
    write() {}
    dispose() {}
  },
}));
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit() {}
  },
}));
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class {} }));
vi.mock('@xterm/addon-clipboard', () => ({ ClipboardAddon: class {} }));
vi.mock('@/lib/api-client', () => ({
  api: {},
  apiWebSocketUrl: (path: string) => `ws://localhost${path}`,
}));
vi.mock('@/lib/terminal-wheel', () => ({ attachWheelScroll: () => () => {} }));
const attach = () => () => {};
vi.mock('@/lib/use-terminal-copy', () => ({
  useTerminalCopy: () => ({ attach, copy: vi.fn(), hasSelection: false, copied: false }),
}));
vi.mock('@/lib/use-pending-cli-copy', () => ({
  usePendingCliCopy: () => ({ pendingChars: null }),
}));

class FakeWebSocket {
  static OPEN = 1;
  static instances: FakeWebSocket[] = [];
  readyState = 1;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(_url: string) {
    FakeWebSocket.instances.push(this);
  }
  send() {}
  close() {}
}
beforeEach(() => {
  FakeWebSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeWebSocket);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal('requestAnimationFrame', () => 1);
  vi.stubGlobal('cancelAnimationFrame', () => {});
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const messages: Array<[number, string]> = [
  [4420, 'The container is not running. Start it before opening the terminal.'],
  [4421, 'The container has no Docker binding. Recreate it before opening the terminal.'],
  [4422, 'The task has ended. Its terminal is disabled.'],
  [
    4423,
    'Terminals are unavailable for read-only local repositories. Import a writable copy to use a terminal.',
  ],
  [4424, 'The repository is not ready. Wait until it is ready before opening the terminal.'],
];
describe.each([
  ['Terminal', () => <Terminal containerId="container" />],
  ['InteractiveShell task', () => <InteractiveShell taskId="task" cliProviderId="provider" />],
  [
    'InteractiveShell repo',
    () => <InteractiveShell scope="repo" repositoryId="repo" cliProviderId="provider" />,
  ],
] as const)('%s refusal display', (_name, element) => {
  it.each(messages)('shows a specific sentence for close code %s', (code, message) => {
    render(element());
    const ws = FakeWebSocket.instances[0]!;
    act(() => ws.onclose?.({ code, reason: 'untrusted reason' }));
    expect(screen.getByText(message)).toBeTruthy();
    expect(screen.getByText('error')).toBeTruthy();
    expect(screen.queryByText('untrusted reason')).toBeNull();
  });
  it('keeps transport errors generic for unknown close codes', () => {
    render(element());
    const ws = FakeWebSocket.instances[0]!;
    act(() => {
      ws.onerror?.();
      ws.onclose?.({ code: 1006, reason: '' });
    });
    expect(screen.getByText('websocket error')).toBeTruthy();
    expect(screen.getByText('error')).toBeTruthy();
  });
  it('ignores a refusal after unmount', () => {
    const view = render(element());
    const ws = FakeWebSocket.instances[0]!;
    view.unmount();
    h.writeln.mockClear();
    act(() => ws.onclose?.({ code: 4420, reason: '' }));
    expect(h.writeln).not.toHaveBeenCalled();
  });
});
