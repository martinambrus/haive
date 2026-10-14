import { describe, expect, it, vi } from 'vitest';

vi.mock('@haive/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@haive/shared')>()),
  configService: { get: async () => null, getBoolean: async () => false },
}));
vi.mock('../src/db.js', () => ({ getDb: () => ({}) }));

const { createApiApp } = await import('../src/index.js');

describe('a request body that is not JSON, through the whole app', () => {
  it('answers 400 invalid_json on a route that reads JSON', async () => {
    const res = await createApiApp('http://localhost:3000').request('/auth/login', {
      method: 'POST',
      headers: {
        host: 'localhost:3001',
        origin: 'http://localhost:3000',
        'content-type': 'application/json',
      },
      body: '{bad',
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'The request body is not valid JSON',
      code: 'invalid_json',
    });
  });
});
