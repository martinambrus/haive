// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { TabNav } from '../../../web-kit/src/tabs';
afterEach(cleanup);
it('marks only the active route tab as the current page', () => {
  render(
    <TabNav
      active="/repos"
      items={[
        { href: '/repos', label: 'Repositories' },
        { href: '/tasks', label: 'Tasks' },
      ]}
    />,
  );
  expect(screen.getByRole('link', { name: 'Repositories' }).getAttribute('aria-current')).toBe(
    'page',
  );
  expect(screen.getByRole('link', { name: 'Tasks' }).hasAttribute('aria-current')).toBe(false);
});
it('exposes the active local view as a pressed button', () => {
  render(
    <TabNav
      active="details"
      items={[
        { key: 'details', label: 'Details' },
        { key: 'chat', label: 'Chat' },
      ]}
    />,
  );
  expect(screen.getByRole('button', { name: 'Details', pressed: true })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Chat', pressed: false })).toBeTruthy();
});
