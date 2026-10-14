import { afterEach, describe, expect, it, vi } from 'vitest';
import { isClaudeRefreshRejected, refreshClaudeToken } from '../src/cli-providers/claude-oauth.js';

function respond(status: number, body: string) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(body, { status })),
  );
}

async function refusal(): Promise<unknown> {
  return refreshClaudeToken('rt').then(
    () => null,
    (err: unknown) => err,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
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

  it('keeps the message it had, status and body excerpt included', async () => {
    respond(400, JSON.stringify({ error: 'invalid_grant' }));
    expect(String(await refusal())).toContain('claude oauth refresh_token: http 400');
  });

  it('is not a rejection for an error that is not a token refusal', () => {
    expect(isClaudeRefreshRejected(new Error('invalid_grant'))).toBe(false);
  });
});
