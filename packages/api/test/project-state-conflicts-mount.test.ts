import { describe, expect, it, vi } from 'vitest';

const USER = vi.hoisted(() => '00000000-0000-4000-8000-0000000000a1');
const REPO = '00000000-0000-4000-8000-0000000000c1';
const h = vi.hoisted(() => ({ db: undefined as unknown }));

vi.mock('@haive/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@haive/shared')>()),
  configService: { get: async () => null, getBoolean: async () => true },
}));
vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/middleware/auth.js', () => ({
  requireAuth: async (c: { set: (key: string, value: string) => void }, next: () => unknown) => {
    c.set('userId', USER);
    await next();
  },
  requireAuthAllowingPasswordChange: async (
    c: { set: (key: string, value: string) => void },
    next: () => unknown,
  ) => {
    c.set('userId', USER);
    await next();
  },
  requireAdmin: async (_c: unknown, next: () => unknown) => next(),
}));

const { schema } = await import('@haive/database');
const { createFakeDb } = await import('@haive/database/testing');
const { createApiApp } = await import('../src/index.js');

describe('the conflicts route in the running app', () => {
  it('is mounted under /repos and answered by its own router, not by the repository routes', async () => {
    const fake = createFakeDb({
      repositories: schema.repositories,
      projectStateConflicts: schema.projectStateConflicts,
    });
    fake.insert(schema.repositories, { id: REPO, userId: USER, name: 'mine' });
    h.db = fake.db;

    const res = await createApiApp('http://localhost:3000').request(
      `/repos/${REPO}/project-state/conflicts`,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ conflicts: [] });
  });
});
