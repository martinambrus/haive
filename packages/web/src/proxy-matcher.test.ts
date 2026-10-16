import { describe, expect, it } from 'vitest';
import { unstable_doesMiddlewareMatch } from 'next/experimental/testing/server';
import { config } from './proxy';

const matches = (url: string) => unstable_doesMiddlewareMatch({ config, url });

describe('the proxy matcher', () => {
  it.each([
    '/settings/integrations/callback/module.alpha.drive',
    '/settings/integrations/callback/github',
    '/dashboard',
  ])('runs the proxy on %s', (url) => {
    expect(matches(url)).toBe(true);
  });

  it.each(['/favicon.ico', '/_next/static/x.js', '/logo.svg'])('skips %s', (url) => {
    expect(matches(url)).toBe(false);
  });
});
