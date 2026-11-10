// @vitest-environment jsdom
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { TabNav } from './tabs.js';
import { Button, LinkButton } from './ui.js';
afterEach(cleanup);
it('names the active route and the selected local view', () => {
  const onSelect = vi.fn();
  render(
    createElement(TabNav, {
      active: '/repos',
      items: [
        { href: '/repos', label: 'Repositories' },
        { href: '/tasks', label: 'Tasks' },
      ],
    }),
  );
  expect(screen.getByRole('link', { name: 'Repositories' }).getAttribute('aria-current')).toBe(
    'page',
  );
  expect(screen.getByRole('link', { name: 'Tasks' }).hasAttribute('aria-current')).toBe(false);
  cleanup();
  render(
    createElement(TabNav, {
      active: 'details',
      items: [
        { key: 'details', label: 'Details' },
        { key: 'chat', label: 'Chat' },
      ],
      onSelect,
    }),
  );
  expect(screen.getByRole('button', { name: 'Details', pressed: true })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Chat', pressed: false }));
  expect(onSelect).toHaveBeenCalledWith('chat');
});
it('renders a navigation action as one named link with the same Button appearance', () => {
  render(
    createElement(
      'div',
      null,
      createElement(LinkButton, { href: '/tasks', variant: 'secondary', size: 'sm' }, 'All tasks'),
      createElement(Button, { variant: 'secondary', size: 'sm' }, 'Run'),
    ),
  );
  const link = screen.getByRole('link', { name: 'All tasks' });
  expect(link.querySelector('button')).toBeNull();
  expect(link.getAttribute('href')).toBe('/tasks');
  expect(link.className).toBe(screen.getByRole('button', { name: 'Run' }).className);
});
