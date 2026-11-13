import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import {
  createRenderer,
  findAll,
  fire,
  textOf,
  buttons,
  type Renderer,
} from '../../../../../test/render-tree';
import UsersPage from './page';
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  ...(await import('../../../../../test/render-tree')).reactHooks,
}));
vi.mock('react-dom', async (original) => ({
  ...(await original<typeof import('react-dom')>()),
  createPortal: (children: unknown) => children,
}));
vi.mock('@/lib/use-page-title', () => ({ usePageTitle: () => {} }));
vi.mock('@/components/markdown/markdown-view', () => ({
  MarkdownView: ({ body }: { body: string }) => body,
}));
const h = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), copy: vi.fn() }));
vi.mock('@/lib/api-client', () => ({ api: { get: h.get, post: h.post } }));
const orphan = {
  id: 'orphan',
  email: null,
  emailReadable: false,
  name: 'Lost User',
  gitName: 'Git Person',
  gitEmail: 'git@example.test',
  role: 'user',
  status: 'active',
  tokenVersion: 1,
  createdAt: '2026-11-13T00:00:00Z',
};
let view: Renderer;
let events: EventTarget;
let mounted = true;
beforeEach(() => {
  mounted = true;
  events = new EventTarget();
  vi.stubGlobal('document', {
    body: {},
    activeElement: null,
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
  });
  vi.stubGlobal('navigator', { clipboard: { writeText: h.copy } });
  h.copy.mockReset().mockResolvedValue(undefined);
  h.post.mockReset();
  h.get.mockImplementation(async (path: string) =>
    path === '/admin/users'
      ? {
          users: [
            orphan,
            { ...orphan, id: 'readable', email: 'ok@example.test', emailReadable: true },
          ],
        }
      : path === '/admin/invites'
        ? { invites: [] }
        : { mode: 'closed' },
  );
});
afterEach(() => {
  mounted = false;
  view?.draw();
  vi.unstubAllGlobals();
});
async function mount() {
  view = createRenderer(() => (mounted ? createElement(UsersPage) : null));
  await view.flush();
  await view.flush();
}
async function open() {
  await mount();
  expect(buttons(view.tree(), /^Relink$/i)).toHaveLength(1);
  fire.click(buttons(view.tree(), /^Relink$/i)[0]!);
  await view.flush();
}
function submit() {
  fire.type(
    findAll(view.tree(), (n) => n.props.id === 'relink-email')[0]!,
    ' person@example.test ',
  );
  view.draw();
  const form = findAll(view.tree(), (n) => n.tag === 'form').at(-1)!;
  (form.props.onSubmit as (e: { preventDefault: () => void }) => void)({ preventDefault() {} });
}
it('offers Relink only for an orphan and shows its identifying fields', async () => {
  await mount();
  expect(buttons(view.tree(), /^Relink$/i)).toHaveLength(1);
  const copy = textOf(view.tree());
  for (const field of ['Lost User', 'Git Person', 'git@example.test'])
    expect(copy).toContain(field);
});
it('Escape closes the shared dialog without submitting', async () => {
  await open();
  expect(findAll(view.tree(), (n) => n.props.role === 'dialog')).toHaveLength(1);
  const event = new Event('keydown');
  Object.defineProperty(event, 'key', { value: 'Escape' });
  events.dispatchEvent(event);
  await view.flush();
  expect(findAll(view.tree(), (n) => n.props.role === 'dialog')).toHaveLength(0);
  expect(h.post).not.toHaveBeenCalled();
});
it.each(['mailed', 'manual', 'failed'])(
  'submits and displays the structured %s delivery',
  async (delivery) => {
    const link = 'https://haive.example/reset-password?token=secret';
    h.post.mockResolvedValue({ ok: true, delivery, ...(delivery === 'mailed' ? {} : { link }) });
    await open();
    submit();
    await view.flush();
    await view.flush();
    expect(h.post).toHaveBeenCalledWith('/admin/users/orphan/relink', {
      email: 'person@example.test',
    });
    if (delivery === 'mailed') {
      expect(textOf(view.tree())).toContain('Reset link emailed');
      expect(textOf(view.tree())).not.toContain(link);
    } else {
      expect(textOf(view.tree())).toContain(link);
      expect(textOf(view.tree())).toMatch(/shown once/);
      if (delivery === 'failed') expect(textOf(view.tree())).toContain('Mail delivery failed');
      fire.click(buttons(view.tree(), /^Copy link$/i)[0]!);
      await view.flush();
      expect(h.copy).toHaveBeenCalledWith(link);
      const event = new Event('keydown');
      Object.defineProperty(event, 'key', { value: 'Escape' });
      events.dispatchEvent(event);
      await view.flush();
      expect(textOf(view.tree())).not.toContain(link);
    }
  },
);
it('keeps a rejected relink open with its error', async () => {
  h.post.mockRejectedValue(new Error('That email is already linked to another account.'));
  await open();
  submit();
  await view.flush();
  expect(textOf(view.tree())).toContain('That email is already linked to another account.');
  expect(findAll(view.tree(), (n) => n.props.id === 'relink-email')).toHaveLength(1);
});
