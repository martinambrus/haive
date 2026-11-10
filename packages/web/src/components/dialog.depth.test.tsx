// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { Dialog, DialogContent, DialogTitle } from './dialog';

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([{}] as unknown as DOMRectList);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it('5 nested dialogs mounted together paint and handle Escape in depth order', () => {
  function Scene() {
    const [outer, setOuter] = useState(true);
    const [inner, setInner] = useState(true);
    return (
      <Dialog open={outer} onOpenChange={setOuter}>
        <DialogContent>
          <DialogTitle>Outer</DialogTitle>
          <button>Outer action</button>
          <Dialog open={inner} onOpenChange={setInner}>
            <DialogContent>
              <DialogTitle>Inner</DialogTitle>
              <button>Inner action</button>
            </DialogContent>
          </Dialog>
        </DialogContent>
      </Dialog>
    );
  }
  render(<Scene />);
  const inner = screen
    .getByRole('heading', { name: 'Inner' })
    .closest('[data-haive-dialog]') as HTMLElement;
  const outer = screen
    .getByRole('heading', { name: 'Outer' })
    .closest('[data-haive-dialog]') as HTMLElement;
  expect(Number(inner.style.zIndex)).toBeGreaterThan(Number(outer.style.zIndex));
  fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
  expect(screen.queryByRole('heading', { name: 'Inner' })).toBeNull();
  expect(screen.getByRole('heading', { name: 'Outer' })).toBeTruthy();
});

it('keeps a later sibling dialog above an already open nested dialog', () => {
  function Scene() {
    const [later, setLater] = useState(false);
    return (
      <>
        <Dialog open onOpenChange={() => {}}>
          <DialogContent>
            <DialogTitle>Parent</DialogTitle>
            <Dialog open onOpenChange={() => {}}>
              <DialogContent>
                <DialogTitle>Child</DialogTitle>
                <button onClick={() => setLater(true)}>Open sibling</button>
              </DialogContent>
            </Dialog>
          </DialogContent>
        </Dialog>
        <Dialog open={later} onOpenChange={setLater}>
          <DialogContent>
            <DialogTitle>Later</DialogTitle>
            <button>Dismiss later</button>
          </DialogContent>
        </Dialog>
      </>
    );
  }
  render(<Scene />);
  fireEvent.click(screen.getByRole('button', { name: 'Open sibling' }));
  const layer = (name: string) =>
    Number(
      (screen.getByRole('heading', { name }).closest('[data-haive-dialog]') as HTMLElement).style
        .zIndex,
    );
  expect(layer('Later')).toBeGreaterThan(layer('Child'));
  fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
  expect(screen.queryByRole('heading', { name: 'Later' })).toBeNull();
});
