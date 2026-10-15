import { describe, expect, it, vi } from 'vitest';

const USER = vi.hoisted(() => '00000000-0000-4000-8000-0000000000a1');
const h = vi.hoisted(() => ({ db: undefined as unknown }));

vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/middleware/auth.js', () => ({
  requireAuth: async (c: { set: (key: string, value: string) => void }, next: () => unknown) => {
    c.set('userId', USER);
    await next();
  },
}));

vi.mock('@haive/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@haive/shared')>()),
  userSecretsService: { get: async () => null, listForUser: async () => [] },
}));

import { Hono } from 'hono';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { toolingUpgradeRoutes } from '../src/routes/tooling-upgrades.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';

const REPO = '00000000-0000-4000-8000-0000000000c1';
const OTHER_USER = '00000000-0000-4000-8000-0000000000a2';

const app = new Hono<AppEnv>();
app.route('/', toolingUpgradeRoutes);
app.onError(errorHandler);

function setup(verifyCommands: Record<string, unknown> | null = null, userId = USER) {
  const fake = createFakeDb({
    repositories: schema.repositories,
    projectStateOutbox: schema.projectStateOutbox,
    envTemplates: schema.envTemplates,
    toolPackageVersions: schema.toolPackageVersions,
    stepGuidance: schema.stepGuidance,
  });
  fake.insert(schema.repositories, {
    id: REPO,
    userId,
    name: 'r',
    source: 'local_path',
    verifyCommands,
  });
  h.db = fake.db;
  return fake;
}

const patch = (body: Record<string, unknown>) =>
  app.request(`/${REPO}/tooling`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
const stored = (fake: ReturnType<typeof setup>) =>
  fake.rows(schema.repositories)[0]!.verifyCommands;

describe('declared verify commands', () => {
  it('GET returns the stored object, {} when none is stored', async () => {
    setup({ test: 'make t', lint: null });
    const res = await app.request(`/${REPO}/tooling-config`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { verifyCommands: unknown }).verifyCommands).toEqual({
      test: 'make t',
      lint: null,
    });
    setup(null);
    const empty = await app.request(`/${REPO}/tooling-config`);
    expect(((await empty.json()) as { verifyCommands: unknown }).verifyCommands).toEqual({});
  });

  it('PATCH stores a valid object, replacing the previous one', async () => {
    const fake = setup({ test: 'old', lint: 'old' });
    expect((await patch({ verifyCommands: { typecheck: ' tsc ', lint: null } })).status).toBe(200);
    expect(stored(fake)).toEqual({ typecheck: 'tsc', lint: null });
  });

  it('PATCH {} stores NULL', async () => {
    const fake = setup({ test: 'x' });
    expect((await patch({ verifyCommands: {} })).status).toBe(200);
    expect(stored(fake)).toBeNull();
  });

  it('PATCH without verifyCommands leaves it untouched', async () => {
    const fake = setup({ test: 'x' });
    expect((await patch({ rtkEnabled: true })).status).toBe(200);
    expect(stored(fake)).toEqual({ test: 'x' });
  });

  it.each([
    ['an unknown key', { build: 'make' }],
    ['a newline', { test: 'a\nb' }],
    ['a NUL', { test: 'a\u0000b' }],
    ['more than 2000 characters', { test: 'a'.repeat(2001) }],
    ['an empty string', { test: '' }],
    ['a non-object', 'make'],
    ['null', null],
  ])('PATCH answers 400 for %s and stores nothing', async (_name, value) => {
    const fake = setup({ test: 'x' });
    expect((await patch({ verifyCommands: value })).status).toBe(400);
    expect(stored(fake)).toEqual({ test: 'x' });
  });

  it("answers 404 on another user's repository", async () => {
    const fake = setup({ test: 'x' }, OTHER_USER);
    expect((await patch({ verifyCommands: { test: 'y' } })).status).toBe(404);
    expect((await app.request(`/${REPO}/tooling-config`)).status).toBe(404);
    expect(stored(fake)).toEqual({ test: 'x' });
  });
});
