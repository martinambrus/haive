// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { SidebarTasks } from './sidebar-tasks';
vi.mock('next/navigation', () => ({ usePathname: () => '/tasks' }));
vi.mock('@/lib/api-client', () => ({
  api: {
    get: async () => ({
      tasks: [
        {
          id: 't',
          title: 'Draft task',
          status: 'created',
          repositoryId: 'r',
          repositoryName: 'Repo',
        },
      ],
      total: 1,
    }),
  },
}));
afterEach(cleanup);
const mount = () =>
  render(
    <SidebarTasks
      tree={{
        folders: [{ id: 'f', name: 'Ideas', parentId: null, order: 0 }],
        placements: {},
        order: {},
        closed: [],
      }}
      onTreeChange={() => {}}
      filters={[]}
      onToggleFilter={() => {}}
      originLabel={null}
    />,
  );
it('11 labels a created task not started', async () => {
  mount();
  const link = await screen.findByRole('link', { name: /Draft task/ });
  expect(link.title).toContain('not started');
  expect(link.title).not.toContain('queued');
});
