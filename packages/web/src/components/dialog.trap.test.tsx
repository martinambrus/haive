// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Dialog, DialogContent, DialogTitle } from './dialog';
import { ToastStack } from './notifications/toast-stack';

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([{}] as unknown as DOMRectList);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it.each([0, 3])(
  '6/9 keeps focus inside after native Tab leaves a none-checked radio / positive tabindex group: %s',
  (tabIndex) => {
    render(
      <>
        <button>Outside</button>
        <Dialog open onOpenChange={() => {}}>
          <DialogContent>
            <DialogTitle>Choices</DialogTitle>
            <input type="radio" name="choice" aria-label="One" tabIndex={tabIndex} />
            <input type="radio" name="choice" aria-label="Two" tabIndex={tabIndex} />
            <button>Last</button>
          </DialogContent>
        </Dialog>
      </>,
    );
    screen.getByRole('radio', { name: 'Two' }).focus();
    fireEvent.keyDown(document.activeElement!, { key: 'Tab' });
    // Emulate native navigation beyond the group; JSDOM does not implement Tab navigation.
    screen.getByRole('button', { name: 'Outside' }).focus();
    expect(
      screen
        .getByRole('heading', { name: 'Choices' })
        .closest('[data-haive-dialog]')!
        .contains(document.activeElement),
    ).toBe(true);
  },
);

it('lets portaled toast controls keep focus and work while a dialog is open', () => {
  const onOpen = vi.fn();
  const onDismiss = vi.fn();
  render(
    <>
      <button>Outside</button>
      <Dialog open onOpenChange={() => {}} aria-label="Working">
        <button>Inside</button>
      </Dialog>
      <ToastStack
        toasts={Array.from({ length: 4 }, (_, n) => ({
          key: String(n),
          taskId: String(n),
          title: `Task ${n}`,
          status: 'completed' as const,
          message: 'Completed',
        }))}
        onOpen={onOpen}
        onDismiss={onDismiss}
      />
    </>,
  );
  const dialog = screen.getByRole('dialog', { name: 'Working' });
  screen.getByRole('button', { name: 'Inside' }).focus();
  fireEvent.keyDown(document.activeElement!, { key: 'Tab', shiftKey: true });
  const more = screen.getByRole('button', { name: '+1 more' });
  more.focus();
  expect(document.activeElement).toBe(more);
  const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
  more.dispatchEvent(tab);
  expect(tab.defaultPrevented).toBe(false);
  fireEvent.click(more);
  expect(screen.getByRole('button', { name: 'Show less' })).toBe(more);

  const open = screen.getByRole('button', { name: /Completed\s*Task 0/ });
  open.focus();
  expect(document.activeElement).toBe(open);
  fireEvent.click(open);
  expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ key: '0' }));

  const dismiss = screen.getByRole('button', { name: 'Dismiss notification: Task 0' });
  dismiss.focus();
  expect(document.activeElement).toBe(dismiss);
  fireEvent.click(dismiss);
  expect(onDismiss).toHaveBeenCalledWith('0');

  const all = screen.getByRole('button', { name: 'Dismiss all' });
  all.focus();
  expect(document.activeElement).toBe(all);
  fireEvent.click(all);
  expect(onDismiss.mock.calls.map(([key]) => key)).toEqual(['0', '0', '1', '2', '3']);
  screen.getByRole('button', { name: 'Outside' }).focus();
  expect(dialog.contains(document.activeElement)).toBe(true);
});
