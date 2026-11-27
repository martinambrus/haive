import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  exchangeClaudeAuthCode,
  isClaudeRefreshRejected,
  postToken,
  refreshClaudeToken,
} from '../src/cli-providers/claude-oauth.js';

function respond(status: number, body: string) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(body, { status })),
  );
}

async function refusal(): Promise<unknown> {
  return refreshClaudeToken(randomBytes(16).toString('hex')).then(
    () => null,
    (err: unknown) => err,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('a refused Claude token refresh', () => {
  it('is a rejection when the body names invalid_grant as its error code', async () => {
    respond(
      400,
      JSON.stringify({ error: 'invalid_grant', error_description: 'Refresh token revoked' }),
    );
    expect(isClaudeRefreshRejected(await refusal())).toBe(true);
  });

  it('is not a rejection when only the description mentions invalid_grant', async () => {
    respond(
      400,
      JSON.stringify({ error: 'invalid_request', error_description: 'not an invalid_grant' }),
    );
    expect(isClaudeRefreshRejected(await refusal())).toBe(false);
  });

  it('is not a rejection for a server error or a body that is not JSON', async () => {
    respond(503, 'upstream invalid_grant gateway');
    expect(isClaudeRefreshRejected(await refusal())).toBe(false);
  });

  it.each([400, 401, 403, 429, 500, 503])(
    'classifies JSON invalid_grant only on a 400/401 refusal (%s)',
    async (status) => {
      respond(status, JSON.stringify({ error: 'invalid_grant' }));
      const err = (await refusal()) as { status: number; code: string | null };
      expect(err.status).toBe(status);
      expect(err.code).toBe(status === 400 || status === 401 ? 'invalid_grant' : null);
      expect(isClaudeRefreshRejected(err)).toBe(status === 400 || status === 401);
    },
  );

  it('keeps the status in its message', async () => {
    respond(400, JSON.stringify({ error: 'invalid_grant' }));
    expect(String(await refusal())).toContain('claude oauth refresh_token: http 400');
  });

  it('is not a rejection for an error that is not a token refusal', () => {
    expect(isClaudeRefreshRejected(new Error('invalid_grant'))).toBe(false);
  });
});

describe('a refused Claude token exchange never carries the endpoint text', () => {
  const tok = randomBytes(16).toString('hex');
  const echoes: [string, number, string][] = [
    [
      'an error_description',
      400,
      JSON.stringify({ error: 'invalid_grant', error_description: tok }),
    ],
    ['an error field that is itself the text', 400, JSON.stringify({ error: tok })],
    ['a plain-text body', 400, `denied ${tok}`],
    ['a server error', 503, `upstream ${tok}`],
  ];
  const surfaces = (err: unknown) => {
    const e = err as Error;
    return [
      String(err),
      e.message,
      e.stack ?? '',
      JSON.stringify(Object.fromEntries(Object.entries(e))),
    ];
  };

  it.each(echoes)('drops the text of %s', async (_name, status, body) => {
    respond(status, body);
    const err = await refusal();
    for (const surface of surfaces(err)) expect(surface).not.toContain(tok);
    expect(String(err)).toContain(`http ${status}`);
  });

  it('keeps invalid_grant as the code and still reads as a rejection', async () => {
    respond(400, echoes[0]![2]);
    const err = (await refusal()) as { code: string | null };
    expect(err.code).toBe('invalid_grant');
    expect(String(err)).toContain('(invalid_grant)');
    expect(isClaudeRefreshRejected(err)).toBe(true);
  });

  it('has no code for an error value outside the standard set', async () => {
    respond(400, echoes[1]![2]);
    expect(((await refusal()) as { code: string | null }).code).toBeNull();
    respond(400, JSON.stringify({ error: 'made_up_code' }));
    expect(((await refusal()) as { code: string | null }).code).toBeNull();
  });

  it('rejects a success body that is not JSON with a fixed message', async () => {
    respond(200, `${tok} not json`);
    const err = await refusal();
    for (const surface of surfaces(err)) expect(surface).not.toContain(tok);
    expect((err as Error).message).toBe('claude oauth: invalid token response');
  });

  it('rethrows a network failure unchanged', async () => {
    const boom = new TypeError('fetch failed');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(boom)),
    );
    expect(await refusal()).toBe(boom);
  });
});

describe('Claude OAuth token endpoint deadline', () => {
  it('keeps the 15 second default for both unchanged grant callers', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    respond(200, JSON.stringify({ access_token: 'synthetic-access' }));
    await refreshClaudeToken('synthetic-refresh');
    await exchangeClaudeAuthCode('synthetic-code', 'synthetic-verifier', null);
    expect(timeout.mock.calls).toEqual([[15_000], [15_000]]);
  });
  it.each(['headers', 'body'])(
    'bounds a stalled %s response for both grants',
    async (stall) => {
      const server = createServer((_req, res) => {
        if (stall === 'body') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.write('{');
        }
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('missing test endpoint');
      const realFetch = globalThis.fetch;
      const signals: (AbortSignal | null | undefined)[] = [];
      vi.stubGlobal('fetch', (_url: unknown, init?: RequestInit) => {
        signals.push(init?.signal);
        return realFetch(`http://127.0.0.1:${address.port}`, init);
      });
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = Symbol('unbounded request');
      const start = performance.now();
      try {
        const tokens = Promise.allSettled([
          postToken({ grant_type: 'refresh_token', refresh_token: 'synthetic-refresh' }, 50),
          postToken(
            {
              grant_type: 'authorization_code',
              code: 'synthetic-code',
              code_verifier: 'synthetic-verifier',
            },
            50,
          ),
        ]);
        const result = await Promise.race([
          tokens,
          new Promise<typeof deadline>((resolve) => {
            timer = setTimeout(() => resolve(deadline), 1500);
          }),
        ]);
        expect(result).not.toBe(deadline);
        expect(performance.now() - start).toBeLessThan(1500);
        expect(signals).toHaveLength(2);
        for (const signal of signals) expect(signal?.aborted).toBe(true);
        for (const outcome of result as PromiseSettledResult<unknown>[]) {
          expect(outcome.status).toBe('rejected');
          if (outcome.status === 'rejected')
            expect(outcome.reason.name).toMatch(/TimeoutError|AbortError/);
        }
      } finally {
        clearTimeout(timer);
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
    5000,
  );
});
