// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { CliAuthBannerModal } from './cli-auth-banner-modal';
import { TaskHistoryPanel, type useTaskHistory } from './task-history';
vi.mock('@xterm/xterm', () => ({ Terminal: class {} }));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class {} }));
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class {} }));
vi.mock('@xterm/addon-clipboard', () => ({ ClipboardAddon: class {} }));
vi.mock('@/lib/use-pending-cli-copy', () => ({
  usePendingCliCopy: () => ({ pendingChars: null }),
}));
vi.mock('@/lib/api-client', () => ({ apiWebSocketUrl: (path: string) => `ws://localhost${path}` }));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it('3 signs in through a named shared dialog and restores the opener on Escape', () => {
  vi.stubGlobal(
    'WebSocket',
    class {
      close() {}
    },
  );
  function Scene() {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button onClick={() => setOpen(true)}>Sign in</button>
        <CliAuthBannerModal
          open={open}
          providerId="p"
          providerLabel="Claude"
          providerName="claude-code"
          onClose={() => setOpen(false)}
        />
      </>
    );
  }
  render(<Scene />);
  const opener = screen.getByRole('button', { name: 'Sign in' });
  opener.focus();
  fireEvent.click(opener);
  const dialog = screen.getByRole('dialog', { name: 'Sign in — Claude' });
  expect(dialog.closest('[data-haive-dialog]')).toBeTruthy();
  fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(document.activeElement).toBe(opener);
});
it('3 implementation history shares the dialog focus guard and returns to its bell', () => {
  function Scene() {
    const [open, setOpen] = useState(false);
    const history = {
      open,
      setOpen,
      taskId: 't',
      panelId: 'history',
      ready: true,
      entries: [],
      error: null,
      dividerAfterId: null,
    } as unknown as ReturnType<typeof useTaskHistory>;
    return (
      <>
        <button data-task-history-bell onClick={() => setOpen(true)}>
          History
        </button>
        <button>Outside history</button>
        <TaskHistoryPanel history={history} roundLabels={new Map()} onSelectStep={() => {}} />
      </>
    );
  }
  render(<Scene />);
  const bell = screen.getByRole('button', { name: 'History' });
  bell.focus();
  fireEvent.click(bell);
  const dialog = screen.getByRole('dialog', { name: 'Implementation history' });
  screen.getByRole('button', { name: 'Outside history' }).focus();
  expect(dialog.contains(document.activeElement)).toBe(true);
  fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
  expect(document.activeElement).toBe(bell);
});
