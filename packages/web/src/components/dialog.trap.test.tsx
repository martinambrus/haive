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
