import { describe, expect, it } from 'vitest';
import { isPortProxyPath } from '../src/routes/ide.js';

describe('editor port-proxy paths', () => {
  it.each([
    '/../proxy/80',
    '/.%2e/proxy/80',
    '/%2e./PrOxY/80',
    '/%2E%2E/absproxy/80',
    '/static/../proxy/80?x=1',
    '/static/%2e%2e/absproxy/80',
    '/./proxy/80',
    '/%2e/absproxy/80',
    '/proxy/80/../../socket',
    '/absproxy/80/%2e%2e/%2e%2e/x',
  ])('refuses a proxy remainder, raw or normalized: %s', (path) => {
    expect(isPortProxyPath(path)).toBe(true);
  });

  it.each(['/static/proxy/a.js', '/proxygen/80', '/socket?path=/proxy/80', '/'])(
    'keeps ordinary remainder %s',
    (path) => expect(isPortProxyPath(path)).toBe(false),
  );
});
