import { beforeEach, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import UsersPage from './users/page';
import AuditPage from './audit/page';
import AccountPage from '../settings/account/page';
import { createRenderer, findAll, fire, textOf } from '../../../../test/render-tree';

vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  ...(await import('../../../../test/render-tree')).reactHooks,
}));
vi.mock('@/lib/use-page-title', () => ({ usePageTitle: () => {} }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {} }) }));
vi.mock('@/components/markdown/markdown-view', () => ({
  MarkdownView: ({ body }: { body: string }) => body,
}));
const h = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn(), audit: vi.fn() }));
vi.mock('@/lib/api-client', async (original) => ({
  ...(await original<typeof import('@/lib/api-client')>()),
  api: { get: h.get, put: h.put },
  listAuditEvents: h.audit,
}));
const user = {
  id: '12345678-0000-4000-8000-000000000001',
  email: null,
  emailReadable: false,
  role: 'user',
  status: 'active',
  createdAt: '2026-11-13T00:00:00Z',
};
beforeEach(() => {
  h.put.mockReset().mockResolvedValue({ ok: true });
  h.get.mockImplementation(async (path: string) => {
    if (path === '/admin/users') return { users: [user] };
    if (path === '/admin/invites') return { invites: [] };
    if (path === '/admin/config/registration-mode') return { mode: 'closed' };
    if (path === '/user-settings/account')
      return {
        name: 'Admin',
        email: null,
        emailReadable: false,
        phone: null,
        phoneReadable: false,
      };
    throw new Error(`Unexpected read ${path}`);
  });
  h.audit.mockResolvedValue({
    events: [
      {
        id: 'event-1',
        actorUserId: user.id,
        actorEmail: null,
        actorEmailReadable: false,
        action: 'user.update',
        targetType: 'user',
        targetId: user.id,
        metadata: null,
        createdAt: user.createdAt,
      },
    ],
    total: 1,
    facets: { actions: [], targetTypes: [] },
  });
});
async function mount(page: typeof UsersPage) {
  const view = createRenderer(() => createElement(page));
  await view.flush();
  await view.flush();
  return view;
}
it('labels an unreadable user email in the admin list', async () => {
  const view = await mount(UsersPage);
  expect(textOf(view.tree())).toContain('unreadable, needs relink (12345678)');
});
it('labels an unreadable audit actor and its filter option', async () => {
  const view = await mount(AuditPage);
  expect(
    findAll(
      view.tree(),
      (node) => node.tag === 'td' && textOf(node) === 'unreadable, needs relink',
    ),
  ).toHaveLength(1);
  expect(
    findAll(
      view.tree(),
      (node) => node.tag === 'option' && textOf(node) === 'unreadable, needs relink (12345678)',
    ),
  ).toHaveLength(1);
});
it('labels unreadable contact fields and preserves the old phone when only saving a name', async () => {
  const view = await mount(AccountPage);
  const email = findAll(view.tree(), (node) => node.props.id === 'account-email')[0]!;
  expect(email.props.value).toBe('unreadable, needs relink');
  expect(textOf(view.tree())).toContain('Phone: unreadable, needs relink');
  fire.click(
    findAll(view.tree(), (node) => node.tag === 'button' && textOf(node) === 'Save profile')[0]!,
  );
  await view.flush();
  expect(h.put).toHaveBeenCalledWith('/user-settings/account', { name: 'Admin' });
});
