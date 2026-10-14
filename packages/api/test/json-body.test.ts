import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { AppEnv } from '../src/context.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import { jsonBodyErrors } from '../src/middleware/json-body.js';

function app(): Hono<AppEnv> {
  const a = new Hono<AppEnv>();
  a.use('*', jsonBodyErrors);
  a.post('/echo', async (c) => c.json({ got: await c.req.json() }));
  a.post('/raw', async (c) => c.json({ text: await c.req.text() }));
  a.post('/inner', async () => {
    JSON.parse('{oops');
    return new Response(null);
  });
  a.onError(errorHandler);
  return a;
}

const post = (path: string, body: string) =>
  app().request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });

describe('jsonBodyErrors', () => {
  it('answers a body that is not JSON with 400 and a named code', async () => {
    const res = await post('/echo', '{bad');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'The request body is not valid JSON',
      code: 'invalid_json',
    });
  });

  it('passes a valid body through unchanged', async () => {
    const res = await post('/echo', '{"a":1}');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ got: { a: 1 } });
  });

  it('leaves the raw body to a route that reads text', async () => {
    const res = await post('/raw', '{bad');
    expect(await res.json()).toEqual({ text: '{bad' });
  });

  it("keeps a route's own JSON.parse failure a server error", async () => {
    expect((await post('/inner', '{}')).status).toBe(500);
  });
});
