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
