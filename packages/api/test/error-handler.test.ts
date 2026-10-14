import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { describe, expect, it } from 'vitest';
import { HttpError, type AppEnv } from '../src/context.js';
import { errorHandler } from '../src/middleware/error-handler.js';

function appThrowing(err: unknown, contextHeader?: [string, string]): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.get('/', (c) => {
    if (contextHeader) c.header(...contextHeader);
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

  it('answers with the response an HTTPException carries, its headers and the context ones kept', async () => {
    const thrown = new Response('Too many requests', {
      status: 429,
      headers: { 'Retry-After': '30' },
    });
    const res = await appThrowing(new HTTPException(429, { res: thrown }), [
      'X-Request-Id',
      'r-1',
    ]).request('/');
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('30');
    expect(res.headers.get('X-Request-Id')).toBe('r-1');
    expect(await res.text()).toBe('Too many requests');
  });

  it.each([409, 413, 429, 501, 502, 503, 504])(
    'keeps answering an HttpError with its status %i and code',
    async (status) => {
      const res = await appThrowing(new HttpError(status, 'Refused', 'refused')).request('/');
      expect(res.status).toBe(status);
      expect(await res.json()).toEqual({ error: 'Refused', code: 'refused' });
    },
  );

  it('keeps answering anything else as a 500', async () => {
    const res = await appThrowing(new Error('boom')).request('/');
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal server error' });
  });
});
