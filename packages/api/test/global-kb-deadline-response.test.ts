import { logger } from '@haive/shared';
import { Hono } from 'hono';
import { afterEach, expect, it, vi } from 'vitest';
import { GlobalKbDeadlineError } from '@haive/shared/global-kb';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';

it('answers a global KB deadline with its stable code, retry guidance and no store details', async () => {
  const app = new Hono<AppEnv>();
  app.onError(errorHandler);
  app.get('/', () => {
    throw new GlobalKbDeadlineError(12);
  });
  const response = await app.request('/');
  expect(response.status).toBe(503);
  expect(response.headers.get('Retry-After')).toBe('1');
  expect(await response.json()).toEqual({
    code: 'GLOBAL_KB_DEADLINE',
    retryable: true,
    error: '[GLOBAL_KB_DEADLINE] global KB call exceeded 12 ms; retry the operation.',
  });
});

afterEach(() => vi.restoreAllMocks());
it.each([
  ['POST', '/global-kb/entries', false],
  ['POST', '/global-kb/enrich', false],
  ['GET', '/global-kb/entries', true],
  ['PATCH', '/global-kb/entries/a', true],
  ['PUT', '/global-kb/config', true],
  ['DELETE', '/global-kb/entries/a', true],
])('deadline response retry policy for %s %s', async (method, path, retryable) => {
  const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
  const app = new Hono<AppEnv>();
  app.onError(errorHandler);
  app.on(method!, path!, () => {
    throw new GlobalKbDeadlineError(12);
  });
  const response = await app.request(path!, { method });
  const body = (await response.json()) as { retryable: boolean; error: string };
  expect(body.retryable).toBe(retryable);
  expect(response.headers.get('Retry-After')).toBe(retryable ? '1' : null);
  if (!retryable) expect(body.error).not.toContain('retry the operation');
  expect(warn).toHaveBeenCalledWith({ errorClass: 'timeout' }, 'Global KB call timed out');
});
