import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement, type ComponentProps } from 'react';
import { AuthForm } from './auth-form';
import { createRenderer, findAll, isDisabled, textOf, type Renderer } from '../../test/render-tree';

// AuthForm once React has attached handleSubmit: it cancels the native submit, posts the
// credentials to the api as JSON, then enters the app, or shows the api's message and enables the
// button again. method="post" covers only the window before that (auth-form-markup.test.tsx), so
// these cases must pass on both sides of that change.
vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  ...(await import('../../test/render-tree')).reactHooks,
}));
const h = vi.hoisted(() => ({
  router: { push: vi.fn(), replace: vi.fn(), refresh: vi.fn() },
  get: vi.fn(),
  post: vi.fn(),
}));
vi.mock('next/navigation', () => ({ useRouter: () => h.router }));
vi.mock('next/link', async () => {
  const { createElement } = await import('react');
  return {
    default: ({ href, children }: { href: string; children?: unknown }) =>
      createElement('a', { href }, children as never),
  };
});
vi.mock('@/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-client')>()),
  api: { get: h.get, post: h.post },
}));
// Node's FormData rejects a form argument, so the browser's `new FormData(form)` is stood in for by a
// subclass that takes the fields of the fake form `submit()` hands over.
const RealFormData = FormData;
vi.stubGlobal(
  'FormData',
  class extends RealFormData {
    constructor(form?: { fields: Record<string, string> }) {
      super();
      for (const [k, v] of Object.entries(form?.fields ?? {})) this.append(k, v);
    }
  },
);
afterAll(() => {
  vi.unstubAllGlobals();
});

const EMAIL = 'person@example.test';
const PASSWORD = 'a-long-enough-password';
const LIMITED = 'Too many sign-in attempts. Try again in 12 seconds.';

const mount = (props: ComponentProps<typeof AuthForm>) =>
  createRenderer(() => createElement(AuthForm, props));

async function submit(view: Renderer, fields: Record<string, string>, preventDefault = vi.fn()) {
  const form = findAll(view.tree(), (host) => host.tag === 'form')[0]!;
  const onSubmit = form.props.onSubmit as (event: {
    preventDefault: () => void;
    currentTarget: { fields: Record<string, string> };
  }) => Promise<void>;
  await onSubmit({ preventDefault, currentTarget: { fields } });
  view.draw();
}

const submitButton = (view: Renderer) =>
  findAll(view.tree(), (host) => host.tag === 'button' && host.props.type === 'submit')[0]!;

beforeEach(() => {
  vi.resetAllMocks();
  h.post.mockResolvedValue({ user: {} });
});

describe('AuthForm after React has attached handleSubmit', () => {
  it('signs in: cancels the native submit, posts the credentials, enters the app', async () => {
    const view = mount({
      mode: 'login',
      initialStatus: { setupNeeded: false, setupTokenRequired: false, mode: 'open' },
    });
    const preventDefault = vi.fn();
    await submit(view, { email: EMAIL, password: PASSWORD }, preventDefault);

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(h.post).toHaveBeenCalledExactlyOnceWith('/auth/login', {
      email: EMAIL,
      password: PASSWORD,
    });
    expect(h.router.push).toHaveBeenCalledExactlyOnceWith('/dashboard');
    expect(h.router.refresh).toHaveBeenCalledOnce();
  });

  it('shows the message the api gave and enables the button again', async () => {
    h.post.mockRejectedValue({ message: LIMITED });
    const view = mount({
      mode: 'login',
      initialStatus: { setupNeeded: false, setupTokenRequired: false, mode: 'open' },
    });
    await submit(view, { email: EMAIL, password: PASSWORD });

    const alerts = findAll(view.tree(), (host) => host.props.role === 'alert');
    expect(alerts.map((alert) => textOf(alert))).toEqual([LIMITED]);
    expect(isDisabled(submitButton(view))).toBe(false);
  });

  it('posts the setup token with the first account', async () => {
    const view = mount({
      mode: 'setup',
      initialStatus: { setupNeeded: true, setupTokenRequired: true, mode: 'closed' },
    });
    await submit(view, { email: EMAIL, password: PASSWORD, setupToken: 'setup-secret' });

    expect(h.post).toHaveBeenCalledExactlyOnceWith('/auth/register', {
      email: EMAIL,
      password: PASSWORD,
      setupToken: 'setup-secret',
    });
  });

  it('posts the invite token with an invited registration', async () => {
    const view = mount({
      mode: 'register',
      initialStatus: { setupNeeded: false, setupTokenRequired: false, mode: 'closed' },
      initialInviteToken: 'tok',
    });
    await submit(view, { email: EMAIL, password: PASSWORD });

    expect(h.post).toHaveBeenCalledExactlyOnceWith('/auth/register', {
      email: EMAIL,
      password: PASSWORD,
      inviteToken: 'tok',
    });
  });
});
