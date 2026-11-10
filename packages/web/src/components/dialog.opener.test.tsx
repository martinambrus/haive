// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { Pencil } from 'lucide-react';
import { Dialog, DialogContent, DialogTitle } from './dialog';
import { ActionMenu } from './action-menu';

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([{}] as unknown as DOMRectList);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it('4 returns focus to the persistent ActionMenu trigger after a row opens a dialog', () => {
  function Scene() {
    const [open, setOpen] = useState(false);
    return (
      <>
        <ActionMenu
          label="Task actions"
          items={[
            { key: 'edit', label: 'Edit task', icon: Pencil, onClick: () => setOpen(true) },
            { key: 'other', label: 'Other', icon: Pencil },
          ]}
        />
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogContent>
            <DialogTitle>Edit task</DialogTitle>
            <button>Save</button>
          </DialogContent>
        </Dialog>
      </>
    );
  }
  render(<Scene />);
  const trigger = screen.getByRole('button', { name: 'Task actions' });
  fireEvent.click(trigger);
  const row = screen.getByRole('menuitem', { name: 'Edit task' });
  row.focus();
  fireEvent.click(row);
  expect(document.activeElement).not.toBe(document.body);
  fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
  expect(document.activeElement).toBe(trigger);
});

it('10 restores the actual opener when the opening commit moves its keyed node', () => {
  function Scene() {
    const [open, setOpen] = useState(false);
    return (
      <>
        {(open ? ['other', 'open'] : ['open', 'other']).map((id) => (
          <button key={id} onClick={() => setOpen(true)}>
            {id}
          </button>
        ))}
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogContent>
            <DialogTitle>Moved opener</DialogTitle>
            <button>Done</button>
          </DialogContent>
        </Dialog>
      </>
    );
  }
  render(<Scene />);
  const opener = screen.getByRole('button', { name: 'open' });
  opener.focus();
  fireEvent.click(opener);
  fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
  expect(document.activeElement).toBe(opener);
});

it('registers a document focusin guard only while open, even with multiple closed dialogs', () => {
  const add = vi.spyOn(document, 'addEventListener');
  const remove = vi.spyOn(document, 'removeEventListener');
  const scene = (open: boolean) => (
    <>
      <Dialog open={open} onOpenChange={() => {}}>
        <button>Done</button>
      </Dialog>
      <Dialog open={false} onOpenChange={() => {}}>
        Closed
      </Dialog>
    </>
  );
  const liveGuards = () => {
    const listeners = new Set(
      add.mock.calls.filter(([type]) => type === 'focusin').map(([, fn]) => fn),
    );
    for (const [type, fn] of remove.mock.calls) {
      if (type === 'focusin') listeners.delete(fn);
    }
    return listeners.size;
  };
  const view = render(scene(false));
  expect(liveGuards()).toBe(0);
  view.rerender(scene(true));
  expect(liveGuards()).toBe(1);
  view.rerender(scene(false));
  expect(liveGuards()).toBe(0);
});

it('does not restore an unrelated focus from an earlier interaction on a programmatic open', async () => {
  const scene = (open: boolean) => (
    <>
      <button>Unrelated</button>
      <Dialog open={open} onOpenChange={() => {}} aria-label="Programmatic">
        <button>Done</button>
      </Dialog>
    </>
  );
  const view = render(scene(false));
  const unrelated = screen.getByRole('button', { name: 'Unrelated' });
  unrelated.focus();
  fireEvent.click(unrelated);
  unrelated.blur();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(document.activeElement).toBe(document.body);
  view.rerender(scene(true));
  view.rerender(scene(false));
  expect(document.activeElement).toBe(document.body);
});
