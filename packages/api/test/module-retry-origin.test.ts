import { describe, expect, it, vi } from 'vitest';

vi.mock('@haive/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@haive/shared')>()),
  configService: { get: async () => null, getBoolean: async () => true },
}));
vi.mock('../src/db.js', () => ({ getDb: () => ({}) }));

const { createApiApp } = await import('../src/index.js');
const { moduleRoutes } = await import('../src/modules/loader.js');

describe('a module retry', () => {
  const app = createApiApp('http://localhost:3000');
  app.route('/modules', moduleRoutes([]));
  const post = (origin?: string) =>
    app.request('/modules/alpha/retry', {
      method: 'POST',
      headers: { host: 'localhost:3001', ...(origin ? { origin } : {}) },
    });

  it('A9 from another page is refused before anything else reads it', async () => {
    for (const origin of ['http://localhost:5173', 'null']) {
      const res = await post(origin);
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ error: 'Refused a request from another page' });
    }
  });

  it('A10 from the app itself is past the origin gate: the route asks for a login instead', async () => {
    expect((await post('http://localhost:3000')).status).toBe(401);
  });
});
