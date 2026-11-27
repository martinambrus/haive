// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { Dialog } from './dialog';

afterEach(cleanup);

it('bounds the shared panel to the viewport and lets long content scroll', () => {
  render(
    <Dialog open onOpenChange={() => {}} aria-label="Long warning">
      <p>Warning</p>
      <button>Continue</button>
    </Dialog>,
  );
  const panel = screen.getByRole('dialog');
  expect(panel.className.split(' ')).toContain('max-h-[calc(100dvh-2rem)]');
  expect(panel.className.split(' ')).toContain('overflow-y-auto');
  expect(panel.contains(screen.getByRole('button', { name: 'Continue' }))).toBe(true);
});

it('preserves callers that provide their own height, positioning and scrolling', () => {
  render(
    <Dialog
      open
      onOpenChange={() => {}}
      aria-label="Custom panel"
      className="fixed bottom-3 top-14 max-h-[80dvh] overflow-y-hidden md:max-h-[calc(100dvh-5rem)]"
    >
      Content
    </Dialog>,
  );
  const classes = screen.getByRole('dialog').className.split(' ');
  expect(classes).toContain('fixed');
  expect(classes).toContain('bottom-3');
  expect(classes).toContain('top-14');
  expect(classes).toContain('max-h-[80dvh]');
  expect(classes).toContain('md:max-h-[calc(100dvh-5rem)]');
  expect(classes).toContain('overflow-y-hidden');
  expect(classes).not.toContain('max-h-[calc(100dvh-2rem)]');
  expect(classes).not.toContain('overflow-y-auto');
});
