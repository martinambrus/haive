import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { createRenderer, findAll, textOf } from '../../test/render-tree';
import { PasswordRecoveryForm } from './password-recovery-form';
import { AuthForm } from './auth-form';
import { decideRouteAccess } from '@/lib/route-access';
import ForgotPasswordPage from '@/app/(auth)/forgot-password/page';
import ResetPasswordPage from '@/app/(auth)/reset-password/page';

vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  ...(await import('../../test/render-tree')).reactHooks,
}));
const h = vi.hoisted(() => ({
  post: vi.fn(),
  router: { replace: vi.fn(), push: vi.fn(), refresh: vi.fn() },
}));
vi.mock('next/navigation', () => ({ useRouter: () => h.router }));
vi.mock('next/link', async () => {
  const { createElement } = await import('react');
  return {
    default: ({ href, children }: { href: string; children: unknown }) =>
      createElement('a', { href }, children as never),
  };
});
vi.mock('@/lib/api-client', () => ({ api: { post: h.post } }));
const RealFormData = FormData;
vi.stubGlobal(
  'FormData',
  class extends RealFormData {
    constructor(form?: { fields: Record<string, string> }) {
      super();
      for (const [key, value] of Object.entries(form?.fields ?? {})) this.append(key, value);
    }
  },
);
afterAll(() => vi.unstubAllGlobals());
beforeEach(() => {
  vi.resetAllMocks();
  h.post.mockResolvedValue({ ok: true });
});
const mount = (mode: 'forgot' | 'reset', token = '') =>
  createRenderer(() => createElement(PasswordRecoveryForm, { mode, token }));
async function submit(view: ReturnType<typeof mount>, fields: Record<string, string>) {
  const form = findAll(view.tree(), (n) => n.tag === 'form')[0]!;
  expect(form.props.method).toBe('post');
  await (form.props.onSubmit as (event: unknown) => Promise<void>)({
    preventDefault: vi.fn(),
    currentTarget: { fields },
  });
  view.draw();
}
describe('password recovery pages', () => {
  it('the public pages render the form and pass the URL token to submission', async () => {
    const forgot = createRenderer(() => ForgotPasswordPage());
    expect(
      findAll(forgot.tree(), (n) => n.tag === 'input' && n.props.name === 'email'),
    ).toHaveLength(1);
    const page = await ResetPasswordPage({
      searchParams: Promise.resolve({ token: 'page-token' }),
    });
    const reset = createRenderer(() => page);
    await submit(reset, { newPassword: 'new-page-password' });
    expect(h.post).toHaveBeenCalledExactlyOnceWith('/auth/reset-password', {
      token: 'page-token',
      newPassword: 'new-page-password',
    });
  });
  it('submits the email and shows the private confirmation through MarkdownView', async () => {
    const view = mount('forgot');
    await submit(view, { email: 'person@example.test' });
    expect(h.post).toHaveBeenCalledExactlyOnceWith('/auth/forgot-password', {
      email: 'person@example.test',
    });
    expect(textOf(view.tree())).toContain('If an account can be recovered');
    expect(
      findAll(view.tree(), (n) => String(n.props.className).includes('haive-md')).length,
    ).toBeGreaterThan(0);
  });
  it('submits the token and chosen password then redirects to the login notice', async () => {
    const view = mount('reset', 'opaque-token');
    await submit(view, { newPassword: 'long-new-password' });
    expect(h.post).toHaveBeenCalledExactlyOnceWith('/auth/reset-password', {
      token: 'opaque-token',
      newPassword: 'long-new-password',
    });
    expect(h.router.replace).toHaveBeenCalledExactlyOnceWith('/login?reset=success');
  });
  it('shows the refused token diagnosis and lets the user try again', async () => {
    h.post.mockRejectedValue(new Error('That reset link is invalid or expired.'));
    const view = mount('reset', 'bad');
    await submit(view, { newPassword: 'long-new-password' });
    expect(textOf(view.tree())).toContain('That reset link is invalid or expired.');
    expect(h.router.replace).not.toHaveBeenCalled();
  });
  it('a missing token offers a new request instead of submitting', () => {
    const view = mount('reset');
    expect(findAll(view.tree(), (n) => n.tag === 'form')).toHaveLength(0);
    expect(textOf(view.tree())).toContain('Request a new reset link');
  });
  it.each([false, true])('login recovery link follows mail availability %s', (enabled) => {
    const view = createRenderer(() =>
      createElement(AuthForm, {
        mode: 'login',
        initialStatus: { mode: 'closed', setupNeeded: false, setupTokenRequired: false },
        recoveryAvailable: enabled,
        passwordReset: true,
      }),
    );
    expect(
      findAll(view.tree(), (n) => n.tag === 'a' && n.props.href === '/forgot-password'),
    ).toHaveLength(enabled ? 1 : 0);
    expect(textOf(view.tree())).toContain('Your password has been reset');
  });
  it.each(['/forgot-password', '/reset-password'])(
    'allows %s with absent or stale cookies',
    (path) => {
      for (const hasAccessCookie of [false, true])
        expect(
          decideRouteAccess({
            path,
            hasAccessCookie,
            hasRefreshCookie: hasAccessCookie,
            sessionRejected: false,
          }),
        ).toEqual({ action: 'continue' });
    },
  );
});
