import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { AdminMailCard } from './admin-mail-card';
import { api } from '@/lib/api-client';
import {
  buttons,
  createRenderer,
  findAll,
  fire,
  textOf,
  type Renderer,
} from '../../test/render-tree';

vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  ...(await import('../../test/render-tree')).reactHooks,
}));
vi.mock('react-dom', async (original) => ({
  ...(await original<typeof import('react-dom')>()),
  createPortal: (children: unknown) => children,
}));
vi.mock('@/lib/api-client', () => ({ api: { get: vi.fn(), put: vi.fn(), post: vi.fn() } }));
const saved = {
  enabled: true,
  smtpHost: 'mailpit',
  smtpPort: 1025,
  secure: false,
  user: '',
  from: 'haive@example.test',
  fromName: 'Haive',
  passwordSet: true,
};
let view: Renderer;
let events: EventTarget;
let mounted = true;
beforeEach(() => {
  vi.clearAllMocks();
  mounted = true;
  events = new EventTarget();
  vi.stubGlobal('document', {
    body: {},
    activeElement: null,
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
  });
  vi.mocked(api.get).mockResolvedValue(saved);
  vi.mocked(api.put).mockResolvedValue(saved);
  vi.mocked(api.post).mockResolvedValue({ ok: true });
});
afterEach(() => {
  mounted = false;
  view?.draw();
  vi.unstubAllGlobals();
});
async function mount() {
  view = createRenderer(() => (mounted ? createElement(AdminMailCard) : null));
  view.draw();
  await view.flush();
  return view;
}
const field = (label: string) =>
  findAll(view.tree(), (node) => node.tag === 'input' && node.props['aria-label'] === label)[0]!;
const submit = () => {
  const form = findAll(view.tree(), (node) => node.tag === 'form')[0]!;
  (form.props.onSubmit as (event: { preventDefault: () => void }) => void)({ preventDefault() {} });
};
describe('admin Mail card', () => {
  it('renders settings and saves while omitting a blank password', async () => {
    await mount();
    expect(textOf(view.tree())).toContain('Mail');
    expect(field('SMTP host').props.value).toBe('mailpit');
    expect(field('SMTP password').props.type).toBe('password');
    expect(field('SMTP password').props.value).toBe('');
    fire.type(field('SMTP host'), 'relay.internal');
    view.draw();
    submit();
    await view.flush();
    expect(api.put).toHaveBeenCalledWith('/admin/mail', {
      ...saved,
      smtpHost: 'relay.internal',
      passwordSet: undefined,
    });
  });
  it('sends an entered password once and clears it after saving', async () => {
    await mount();
    fire.type(field('SMTP password'), 'new-password');
    view.draw();
    submit();
    await view.flush();
    expect(api.put).toHaveBeenCalledWith(
      '/admin/mail',
      expect.objectContaining({ password: 'new-password' }),
    );
    expect(field('SMTP password').props.value).toBe('');
  });
  it('opens the test dialog, sends to the typed address and displays a typed refusal', async () => {
    vi.mocked(api.post).mockResolvedValue({
      ok: false,
      code: 'mail_disabled',
      error: 'Mail is disabled.',
    });
    await mount();
    fire.click(buttons(view.tree(), /^send test$/i)[0]!);
    view.draw();
    fire.type(field('Test recipient'), 'test@example.test');
    view.draw();
    const forms = findAll(view.tree(), (node) => node.tag === 'form');
    (forms.at(-1)!.props.onSubmit as (event: { preventDefault: () => void }) => void)({
      preventDefault() {},
    });
    await view.flush();
    expect(api.post).toHaveBeenCalledWith('/admin/mail/test', { to: 'test@example.test' });
    expect(textOf(view.tree())).toContain('Mail is disabled.');
  });
  it('Escape closes the shared test dialog', async () => {
    await mount();
    fire.click(buttons(view.tree(), /^send test$/i)[0]!);
    view.draw();
    expect(findAll(view.tree(), (node) => node.props.role === 'dialog')).toHaveLength(1);
    const event = new Event('keydown');
    Object.defineProperty(event, 'key', { value: 'Escape' });
    events.dispatchEvent(event);
    view.draw();
    expect(findAll(view.tree(), (node) => node.props.role === 'dialog')).toHaveLength(0);
    expect(api.post).not.toHaveBeenCalled();
  });
});
