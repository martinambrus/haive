// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { Pencil } from 'lucide-react';
import { ActionMenu } from './action-menu';
afterEach(cleanup);
it('1 a single menu navigation action is one named link without a nested button', () => {
  const onClick = vi.fn();
  render(
    <ActionMenu
      items={[{ key: 'view', label: 'View task', icon: Pencil, href: '/tasks/one', onClick }]}
    />,
  );
  const link = screen.getByRole('link', { name: 'View task' });
  expect(link.querySelector('button')).toBeNull();
  expect(link.getAttribute('href')).toBe('/tasks/one');
  fireEvent.click(link);
  expect(onClick).toHaveBeenCalledOnce();
});

it.each([false, true])(
  'keeps disabled navigation actions inert in a single action or menu: %s',
  (menu) => {
    const onClick = vi.fn();
    render(
      <ActionMenu
        items={[
          {
            key: 'view',
            label: 'View task',
            icon: Pencil,
            href: '/tasks/one',
            disabled: true,
            onClick,
          },
          ...(menu ? [{ key: 'other', label: 'Other action', icon: Pencil }] : []),
        ]}
      />,
    );
    if (menu) fireEvent.click(screen.getByRole('button', { name: 'Actions' }));
    const action = screen.getByRole(menu ? 'menuitem' : 'link', { name: 'View task' });
    expect(action.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(action);
    expect(onClick).not.toHaveBeenCalled();
  },
);
