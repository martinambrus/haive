import { Hono } from 'hono';
import { expect, it } from 'vitest';
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
