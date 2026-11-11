import { afterEach, describe, expect, it, vi } from 'vitest';
import { logger } from '@haive/shared/logger';
import { resolveServerApiBase } from './api-base.server';
import { apiProxyTarget } from './api-proxy.server';
import { fetchRegistrationStatus } from './registration-status.server';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('shared server API configuration', () => {
  it('shares the invalid-configuration diagnostic across separately loaded server bundles', async () => {
    vi.stubEnv('API_URL_INTERNAL', 'duplicate-bundle.invalid');
    const firstLog = vi.spyOn(logger, 'error').mockImplementation(() => {});
    expect(() => resolveServerApiBase()).toThrow(/Invalid server API URL/);
    vi.resetModules();
    const otherLogger = (await import('@haive/shared/logger')).logger;
    const otherLog = vi.spyOn(otherLogger, 'error').mockImplementation(() => {});
    const otherBundle = await import('./api-base.server');
    expect(() => otherBundle.resolveServerApiBase()).toThrow(/Invalid server API URL/);
    expect(firstLog).toHaveBeenCalledOnce();
    expect(otherLog).not.toHaveBeenCalled();
  });

  it('uses the same public-only base for proxy targets and server registration reads', async () => {
    vi.stubEnv('API_URL_INTERNAL', undefined);
    vi.stubEnv('NEXT_PUBLIC_API_URL', 'http://build.invalid');
    vi.stubEnv('HAIVE_PUBLIC_API_URL', 'https://public-api.test/prefix/');
    const fetcher = vi.fn().mockResolvedValue(Response.json({ mode: 'closed' }));
    vi.stubGlobal('fetch', fetcher);
    expect(resolveServerApiBase()).toBe('https://public-api.test/prefix');
    expect(apiProxyTarget('http://web.test/api/haive/auth/me')?.href).toBe(
      'https://public-api.test/prefix/auth/me',
    );
    expect(await fetchRegistrationStatus()).toEqual({ mode: 'closed' });
    expect(fetcher.mock.calls[0]![0]).toBe(
      'https://public-api.test/prefix/auth/registration-status',
    );
    vi.stubEnv('API_URL_INTERNAL', 'http://internal-api.test/');
    expect(resolveServerApiBase()).toBe('http://internal-api.test');
  });

  it.each(['api.test', '//api.test', 'ftp://api.test'])(
    'refuses malformed or non-HTTP upstream %s once',
    (value) => {
      vi.stubEnv('API_URL_INTERNAL', value);
      const log = vi.spyOn(logger, 'error').mockImplementation(() => {});
      expect(() => resolveServerApiBase()).toThrow(/Invalid server API URL/);
      expect(() => resolveServerApiBase()).toThrow(/Invalid server API URL/);
      expect(log).toHaveBeenCalledOnce();
    },
  );
});
