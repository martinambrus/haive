// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { PlanDetailPanel } from './plan-detail-panel';
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/lib/api-client', async (original) => ({
  ...(await original<typeof import('@/lib/api-client')>()),
  getPlanNode: async () => ({
    node: {
      id: 'n',
      title: 'Checkout',
      status: 'todo',
      rolledStatus: 'todo',
      kind: 'component',
      taskable: true,
      blockedBy: [],
      sequence: 1,
      version: 1,
      body: null,
    },
    ancestry: [],
    children: [],
    edges: [],
    codeLinks: [],
    tasks: [],
  }),
}));
afterEach(cleanup);
it('1 names the panel close and exposes the selected view without changing its label for unread badges', async () => {
  const close = vi.fn();
  const select = vi.fn();
  render(
    <PlanDetailPanel
      repositoryId="r"
      nodeId="n"
      tree={[]}
      tab="details"
      onTabChange={select}
      unreadCount={3}
      onRead={() => {}}
      onChanged={() => {}}
      onNavigate={() => {}}
      onClose={close}
      chatDrafts={new Map()}
    />,
  );
  const button = await screen.findByRole('button', { name: 'Close plan details' });
  fireEvent.click(button);
  expect(close).toHaveBeenCalledOnce();
  expect(screen.getByRole('button', { name: 'details', pressed: true })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'chat', pressed: false }));
  expect(select).toHaveBeenCalledWith('chat');
});
