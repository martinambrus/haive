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
