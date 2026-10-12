import { describe, expect, it, vi } from 'vitest';

vi.mock('@haive/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@haive/shared')>()),
  configService: { get: async () => null, getBoolean: async () => true },
}));
vi.mock('../src/db.js', () => ({ getDb: () => ({}) }));

const { createApiApp } = await import('../src/index.js');

const URL =
  '/repos/00000000-0000-4000-8000-0000000000c1/project-state/conflicts/00000000-0000-4000-8000-0000000000d1';

describe('an answer to a project-state conflict', () => {
  const app = createApiApp('http://localhost:3000');
  const post = (origin?: string) =>
    app.request(URL, {
      method: 'POST',
      headers: {
        host: 'localhost:3001',
        'content-type': 'application/json',
        ...(origin ? { origin } : {}),
      },
      body: JSON.stringify({ answer: 'take_theirs' }),
    });

  it('from another page is refused before anything else reads it', async () => {
    for (const origin of ['http://localhost:5173', 'null']) {
      const res = await post(origin);
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ error: 'Refused a request from another page' });
    }
  });

  it('from the app itself is past the origin gate: the route asks for a login instead', async () => {
    const res = await post('http://localhost:3000');
    expect(res.status).toBe(401);
  });
});
