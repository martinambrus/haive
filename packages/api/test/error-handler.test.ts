import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { logger } from '@haive/shared';
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

describe('errorHandler, a path id that is not a uuid', () => {
  const UUID = '8f1c2a52-6a3e-4c1e-9d0b-5b1f0f6d7a11';
  const driverError = (code: string) => Object.assign(new Error(`pg ${code}`), { code });
  const drizzleError = (code: string) =>
    Object.assign(new Error('Failed query'), { cause: driverError(code) });
  const SHAPES = [
    ['a bare driver error', driverError],
    ['a drizzle-wrapped error', drizzleError],
  ] as const;

  function appThrowingOn(route: string, err: unknown): Hono<AppEnv> {
    const app = new Hono<AppEnv>();
    app.get(route, () => {
      throw err;
    });
    app.onError(errorHandler);
    return app;
  }

  beforeEach(() => {
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe.each(SHAPES)('%s', (_shape, make) => {
    it('answers invalid_text_representation with 404 and does not log it', async () => {
      const logged = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
      const res = await appThrowingOn('/:id', make('22P02')).request('/abc');
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'Not found', code: null });
      expect(logged).not.toHaveBeenCalled();
    });

    it('answers 404 when only one of several params is not a uuid', async () => {
      const app = appThrowingOn('/:id/nodes/:nodeId', make('22P02'));
      expect((await app.request(`/${UUID}/nodes/abc`)).status).toBe(404);
      expect((await app.request(`/abc/nodes/${UUID}`)).status).toBe(404);
    });

    it('logs one warn line with the method, the route and the malformed param names, and no error line', async () => {
      const logged = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
      const app = appThrowingOn('/:id/nodes/:nodeId', make('22P02'));
      const res = await app.request(`/${UUID}/nodes/secret-value`);
      expect(res.status).toBe(404);
      expect(vi.mocked(logger.warn)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(logger.warn).mock.calls[0]?.[0]).toEqual({
        method: 'GET',
        route: '/:id/nodes/:nodeId',
        params: ['nodeId'],
      });
      expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).not.toContain('secret-value');
      expect(logged).not.toHaveBeenCalled();
    });

    it('names every malformed param on the warn line', async () => {
      const app = appThrowingOn('/:id/nodes/:nodeId', make('22P02'));
      expect((await app.request('/abc/nodes/def')).status).toBe(404);
      expect(vi.mocked(logger.warn)).toHaveBeenCalledTimes(1);
      const fields = vi.mocked(logger.warn).mock.calls[0]?.[0] as { params: string[] };
      expect([...fields.params].sort()).toEqual(['id', 'nodeId']);
    });

    it('writes no warn line where it keeps a 500 (passes before and after)', async () => {
      vi.spyOn(logger, 'error').mockImplementation(() => undefined);
      await appThrowingOn('/:id', make('22P02')).request(`/${UUID}`);
      await appThrowingOn('/', make('22P02')).request('/');
      await appThrowingOn('/:id', make('23505')).request('/abc');
      expect(vi.mocked(logger.warn)).not.toHaveBeenCalled();
    });

    it('keeps a 500, logged, when every param is a uuid (passes before and after)', async () => {
      const logged = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
      const app = appThrowingOn('/:id/nodes/:nodeId', make('22P02'));
      const res = await app.request(`/${UUID}/nodes/${UUID.toUpperCase()}`);
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: 'Internal server error' });
      expect(logged).toHaveBeenCalledTimes(1);
    });

    it('keeps a 500 when the route has no params (passes before and after)', async () => {
      vi.spyOn(logger, 'error').mockImplementation(() => undefined);
      expect((await appThrowingOn('/', make('22P02')).request('/')).status).toBe(500);
    });

    it.each(['22012', '22P03', '23505', '42P01'])(
      'keeps %s a 500 with a malformed param (passes before and after)',
      async (code) => {
        vi.spyOn(logger, 'error').mockImplementation(() => undefined);
        expect((await appThrowingOn('/:id', make(code)).request('/abc')).status).toBe(500);
      },
    );
  });

  it('keeps an error without a code a 500 with a malformed param (passes before and after)', async () => {
    vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    expect((await appThrowingOn('/:id', new Error('boom')).request('/abc')).status).toBe(500);
  });
});
