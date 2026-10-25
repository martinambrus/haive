import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { proxy } from './proxy';

afterEach(() => vi.unstubAllEnvs());

describe('a delayed rejected-session navigation', () => {
  it('allows login without deleting cookies another request may have rotated', () => {
    const response = proxy(
      new NextRequest('http://localhost:46100/login?session=expired', {
        headers: { cookie: 'haive_access=new-access; haive_refresh=new-refresh' },
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.getSetCookie()).toEqual([]);
  });
});
