import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { describe, expect, it } from 'vitest';
import { HttpError, type AppEnv } from '../src/context.js';
import { errorHandler } from '../src/middleware/error-handler.js';

function appThrowing(err: unknown): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.get('/', () => {
    throw err;
  });
  app.onError(errorHandler);
  return app;
}

describe('errorHandler', () => {
  it.each([
    [413, 'Payload Too Large'],
    [429, 'Too many requests'],
  ] as const)(
    'answers a Hono HTTPException with its own status %i as JSON',
    async (status, message) => {
      const res = await appThrowing(new HTTPException(status, { message })).request('/');
      expect(res.status).toBe(status);
      expect(await res.json()).toEqual({ error: message, code: null });
    },
  );

  it('keeps answering an HttpError with its status and code', async () => {
    const res = await appThrowing(new HttpError(409, 'Taken', 'taken')).request('/');
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'Taken', code: 'taken' });
  });

  it('keeps answering anything else as a 500', async () => {
    const res = await appThrowing(new Error('boom')).request('/');
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal server error' });
  });
});
