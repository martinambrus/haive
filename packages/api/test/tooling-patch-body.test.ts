import { describe, expect, it, vi } from 'vitest';

const USER = vi.hoisted(() => '00000000-0000-4000-8000-0000000000a1');
const h = vi.hoisted(() => ({ db: undefined as unknown }));

vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/middleware/auth.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/middleware/auth.js')>()),
  requireAuth: async (c: { set: (key: string, value: string) => void }, next: () => unknown) => {
    c.set('userId', USER);
    await next();
  },
}));
vi.mock('@haive/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@haive/shared')>()),
  configService: { get: async () => null, getBoolean: async () => true },
  userSecretsService: { get: async () => null, listForUser: async () => [] },
}));

import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';

// The real app, so the body is read behind the same middleware a request meets in production.
const { createApiApp } = await import('../src/index.js');

const REPO = '00000000-0000-4000-8000-0000000000c1';
const SAVED_AT = new Date('2026-01-01T00:00:00Z');
const TABLES = { repositories: schema.repositories, projectStateOutbox: schema.projectStateOutbox };

const web = createApiApp('http://localhost:3000');

function setup() {
  const fake = createFakeDb(TABLES);
  fake.insert(schema.repositories, {
    id: REPO,
    userId: USER,
    name: 'repo',
    source: 'local_path',
    rtkEnabled: true,
    rtkVersion: '0.1.0',
    updatedAt: SAVED_AT,
  });
  h.db = fake.db;
  return fake;
}

/** Every table the fake holds, as it stands: what a refused request is compared to. */
const everything = (fake: ReturnType<typeof setup>) =>
  Object.values(TABLES).map((table) => fake.rows(table));

/** `raw` is the body exactly as it goes on the wire; undefined sends none. */
const patch = (raw?: string) =>
  web.request(`/repositories/${REPO}/tooling`, {
    method: 'PATCH',
    headers: { host: 'localhost:3001', 'content-type': 'application/json' },
    ...(raw === undefined ? {} : { body: raw }),
  });

describe('PATCH tooling reads its body', () => {
  it('still applies a body that is a JSON object', async () => {
    const fake = setup();

    const res = await patch(JSON.stringify({ rtkVersion: '0.2.0' }));

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ repositoryId: REPO, ok: true });
    expect(fake.rows(schema.repositories)[0]!.rtkVersion).toBe('0.2.0');
  });

  it.each([
    ['null', 'null'],
    ['a list', '[{"rtkVersion":"0.2.0"}]'],
    ['an empty list', '[]'],
    ['a string', '"rtkVersion"'],
    ['a number', '5'],
    ['a boolean', 'true'],
  ])('answers 400 for a JSON body that is %s, and writes nothing', async (_what, raw) => {
    const fake = setup();
    const before = everything(fake);

    const res = await patch(raw);

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'invalid_body' });
    expect(everything(fake)).toEqual(before);
  });

  it.each([
    ['text that is not JSON', 'rtkVersion=0.2.0'],
    ['JSON cut short', '{"rtkVersion":'],
    ['an empty body', ''],
  ])('answers 400 for %s, and writes nothing', async (_what, raw) => {
    const fake = setup();
    const before = everything(fake);

    const res = await patch(raw);

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'invalid_json' });
    expect(everything(fake)).toEqual(before);
  });

  it('answers 400 for a request with no body at all', async () => {
    const fake = setup();
    const before = everything(fake);

    expect((await patch()).status).toBe(400);

    expect(everything(fake)).toEqual(before);
  });
});
