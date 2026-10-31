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

// The real app, so the blob is checked behind the same middleware a request meets in production.
const { createApiApp } = await import('../src/index.js');

const KEPT = '{"keep":true}';
const TABLES = { userIdeSettings: schema.userIdeSettings, userUiPrefs: schema.userUiPrefs };

const web = createApiApp('http://localhost:3000');

/** Both blobs hold a row, so a refused write that still lands shows as a changed row. */
function setup() {
  const fake = createFakeDb(TABLES);
  fake.insert(schema.userIdeSettings, { userId: USER, settingsJson: KEPT });
  fake.insert(schema.userUiPrefs, { userId: USER, settingsJson: KEPT });
  h.db = fake.db;
  return fake;
}

/** Every table the fake holds, as it stands: what a refused request is compared to. */
const everything = (fake: ReturnType<typeof setup>) =>
  Object.values(TABLES).map((table) => fake.rows(table));

interface Route {
  method: 'PUT' | 'PATCH';
  path: string;
  /** The table whose blob the route writes. */
  table: typeof schema.userIdeSettings | typeof schema.userUiPrefs;
}

const PATCH_UI_PREFS: Route = {
  method: 'PATCH',
  path: '/user-settings/ui-prefs',
  table: schema.userUiPrefs,
};
const PUTS: Route[] = [
  { method: 'PUT', path: '/user-settings/ui-prefs', table: schema.userUiPrefs },
  { method: 'PUT', path: '/user-settings/ide', table: schema.userIdeSettings },
];

const send = (target: Route, settingsJson: unknown) =>
  web.request(target.path, {
    method: target.method,
    headers: { host: 'localhost:3001', 'content-type': 'application/json' },
    body: JSON.stringify({ settingsJson }),
  });

/** The status and the whole parsed body, so a PUT is compared to the PATCH on its code and its
 *  message too. */
async function answer(res: Response) {
  return { status: res.status, body: (await res.json().catch(() => null)) as unknown };
}

/** The text a client sends as `settingsJson`: each parses as JSON, to something that is not an
 *  object. */
const NOT_AN_OBJECT: [string, string][] = [
  ['null', 'null'],
  ['an empty list', '[]'],
  ['a list of an object', '[{"a":1}]'],
  ['a string', '"text"'],
  ['a number', '5'],
  ['a boolean', 'true'],
];
const NOT_JSON: [string, string] = ['text that is not JSON', '{bad'];

// The PATCH is the oracle: its refusal of a blob that is not an object is the contract a PUT meets.
describe.each(PUTS)('$method $path', (target) => {
  it.each([...NOT_AN_OBJECT, NOT_JSON])(
    'answers a settingsJson that is %s as the PATCH does, and keeps the stored blob',
    async (_what, text) => {
      const fake = setup();
      const before = everything(fake);

      const oracle = await answer(await send(PATCH_UI_PREFS, text));
      const res = await answer(await send(target, text));

      // Hard, so the comparison below cannot pass because both sides accepted the blob.
      expect(oracle.status).toBe(400);
      // Soft, so a blob that is accepted wrongly AND overwrote the stored one shows both.
      expect.soft(res).toEqual(oracle);
      expect.soft(everything(fake)).toEqual(before);
    },
  );

  it.each(['{}', '{"a":1}'])('still accepts %s and stores it', async (text) => {
    const fake = setup();

    const res = await answer(await send(target, text));

    expect.soft(res).toEqual({ status: 200, body: { ok: true } });
    expect.soft(fake.rows(target.table).map((row) => row.settingsJson)).toEqual([text]);
  });

  it('still answers 400 for a settingsJson that is not a string', async () => {
    const fake = setup();
    const before = everything(fake);

    const res = await send(target, 5);

    expect.soft(res.status).toBe(400);
    expect.soft(everything(fake)).toEqual(before);
  });

  it('still answers 413 for a settingsJson over 64 KiB', async () => {
    const fake = setup();
    const before = everything(fake);

    const res = await send(target, 'a'.repeat(64 * 1024 + 1));

    expect.soft(res.status).toBe(413);
    expect.soft(everything(fake)).toEqual(before);
  });
});

describe(`${PATCH_UI_PREFS.method} ${PATCH_UI_PREFS.path}`, () => {
  it.each(['{}', '{"a":1}'])('still accepts %s', async (text) => {
    setup();

    expect(await answer(await send(PATCH_UI_PREFS, text))).toEqual({
      status: 200,
      body: { ok: true },
    });
  });
});
