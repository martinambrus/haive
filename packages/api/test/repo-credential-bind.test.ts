import { beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/middleware/auth.js', () => ({
  requireAuth: async (c: { set(k: string, v: string): void }, next: () => Promise<void>) => {
    c.set('userId', '00000000-0000-4000-8000-000000000001');
    await next();
  },
}));
vi.mock('../src/middleware/maintenance.js', () => ({
  requireNewWorkAllowed: async (_c: unknown, next: () => Promise<void>) => next(),
  admitNewWork: vi.fn(),
  assertNewWorkAllowed: vi.fn(),
}));
import { Hono } from 'hono';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { repoRoutes } from '../src/routes/repos.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';
const userId = '00000000-0000-4000-8000-000000000001';
const credentialsId = '00000000-0000-4000-8000-000000000002';
let fake: ReturnType<typeof createFakeDb>;
const app = new Hono<AppEnv>();
app.route('/repos', repoRoutes);
app.onError(errorHandler);
beforeEach(() => {
  fake = createFakeDb({
    repositories: schema.repositories,
    repoCredentials: schema.repoCredentials,
  });
  fake.insert(schema.repoCredentials, { id: credentialsId, userId, host: 'github.com' });
  h.db = fake.db;
});
it.each(['https://other.example.test/owner/repo', 'https://github.com:8443/owner/repo'])(
  'refuses a mismatched bind on create: %s',
  async (remoteUrl) => {
    const response = await app.request('/repos', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'git_https', remoteUrl, credentialsId }),
    });
    expect(response.status).toBe(400);
    expect(fake.rows(schema.repositories)).toHaveLength(0);
  },
);
