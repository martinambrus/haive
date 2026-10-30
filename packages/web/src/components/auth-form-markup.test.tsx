import { describe, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AuthForm } from './auth-form';

// The server renders these forms, and a browser submits them natively until React attaches
// handleSubmit. Without method="post" that submit is a GET, which puts the email, password and
// setup token in the URL, the history and every access log. Next answers a urlencoded POST on
// these routes and refuses a multipart one, so the form must also never set an enctype.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
}));

const RENDERS: Array<{
  name: string;
  props: ComponentProps<typeof AuthForm>;
  inside: string[];
}> = [
  {
    name: 'login',
    props: {
      mode: 'login',
      initialStatus: { setupNeeded: false, setupTokenRequired: false, mode: 'open' },
    },
    inside: ['type="password"'],
  },
  {
    name: 'register',
    props: {
      mode: 'register',
      initialStatus: { setupNeeded: false, setupTokenRequired: false, mode: 'closed' },
      initialInviteToken: 'tok',
    },
    inside: ['type="password"'],
  },
  {
    name: 'setup',
    props: {
      mode: 'setup',
      initialStatus: { setupNeeded: true, setupTokenRequired: true, mode: 'closed' },
    },
    inside: ['type="password"', 'name="setupToken"'],
  },
];

describe.each(RENDERS)('AuthForm $name, as the server renders it', ({ props, inside }) => {
  it('is the credentials form, posted natively and with no enctype', () => {
    const html = renderToStaticMarkup(<AuthForm {...props} />);
    const [, attrs = '', body = ''] = /<form\b([^>]*)>([\s\S]*?)<\/form>/.exec(html) ?? [];

    for (const part of inside) expect(body).toContain(part);
    expect(attrs).toContain('method="post"');
    expect(attrs).not.toMatch(/enctype/i);
  });
});
