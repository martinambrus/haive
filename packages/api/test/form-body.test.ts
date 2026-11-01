import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

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
  configService: {
    get: async () => null,
    getFresh: async () => null,
    getBoolean: async () => true,
  },
  userSecretsService: { get: async () => null, listForUser: async () => [] },
}));

import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import type { AppEnv } from '../src/context.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import { formBodyErrors } from '../src/middleware/form-body.js';

// The real app, so the form is read behind the same middleware a request meets in production.
const { createApiApp } = await import('../src/index.js');

interface Sent {
  headers?: Record<string, string>;
  body?: string | FormData | URLSearchParams;
}

const JSON_BODY: Sent = {
  headers: { 'content-type': 'application/json' },
  body: '{"name":"alpha"}',
};
const GARBAGE_MULTIPART: Sent = {
  headers: { 'content-type': 'multipart/form-data; boundary=abc' },
  body: 'this is not a multipart body',
};
const NOT_A_FORM: [string, Sent][] = [
  ['a JSON body', JSON_BODY],
  ['no body and no content type', {}],
  ['text/plain', { headers: { 'content-type': 'text/plain' }, body: 'name=alpha' }],
  [
    'multipart without a boundary',
    { headers: { 'content-type': 'multipart/form-data' }, body: 'name=alpha' },
  ],
  ['multipart with a garbage body', GARBAGE_MULTIPART],
];

/** The status and the `code` of a JSON answer, and whether it names the problem in a string: all
 *  a refusal is asserted on, never its wording. */
async function answer(res: Response) {
  const body = (await res.json().catch(() => null)) as { error?: unknown; code?: unknown } | null;
  return { status: res.status, code: body?.code, named: typeof body?.error === 'string' };
}

const REFUSED = { status: 400, code: 'invalid_form', named: true };

function miniApp(): Hono<AppEnv> {
  const a = new Hono<AppEnv>();
  a.use('*', formBodyErrors);
  a.post('/form', async (c) => {
    const form = await c.req.formData();
    const file = form.get('file');
    return c.json({
      name: form.get('name'),
      file: file instanceof File ? { name: file.name, text: await file.text() } : null,
    });
  });
  a.post('/json', async (c) => c.json({ got: await c.req.json() }));
  a.post('/inner', async (c) => {
    await c.req.formData();
    throw new TypeError('the route’s own failure');
  });
  a.onError(errorHandler);
  return a;
}

const post = (route: string, { headers, body }: Sent = {}) =>
  miniApp().request(route, { method: 'POST', headers, body });

describe('formBodyErrors', () => {
  it.each(NOT_A_FORM)('answers %s with 400 and a named code', async (_what, sent) => {
    expect(await answer(await post('/form', sent))).toEqual(REFUSED);
  });

  it('passes a multipart body, a field and a file, through to the route', async () => {
    const form = new FormData();
    form.set('name', 'alpha');
    form.set('file', new File(['hello'], 'a.txt', { type: 'text/plain' }));

    const res = await post('/form', { body: form });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ name: 'alpha', file: { name: 'a.txt', text: 'hello' } });
  });

  it('passes a urlencoded body through to the route', async () => {
    const res = await post('/form', { body: new URLSearchParams({ name: 'beta' }) });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ name: 'beta', file: null });
  });

  it('leaves a route that reads JSON able to read it', async () => {
    const res = await post('/json', { ...JSON_BODY, body: '{"a":1}' });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ got: { a: 1 } });
  });

  it("keeps a route's own TypeError a server error", async () => {
    const form = new FormData();
    form.set('name', 'alpha');

    expect((await post('/inner', { body: form })).status).toBe(500);
  });

  it('maps only a TypeError: any other failure of the form read stays a server error', async () => {
    const a = new Hono<AppEnv>();
    a.use('*', async (c, next) => {
      c.req.formData = async () => {
        throw new RangeError('the body is too large');
      };
      await next();
    });
    a.use('*', formBodyErrors);
    a.post('/form', async (c) => c.json({ name: (await c.req.formData()).get('name') }));
    a.onError(errorHandler);

    expect((await a.request('/form', { method: 'POST' })).status).toBe(500);
  });
});

const REPO = '00000000-0000-4000-8000-0000000000c1';
const TABLES = {
  repositories: schema.repositories,
  userNotificationSettings: schema.userNotificationSettings,
};
const SOUND_PATH = '/user-settings/notifications/sound';

const web = createApiApp('http://localhost:3000');

function setup() {
  const fake = createFakeDb(TABLES);
  fake.insert(schema.repositories, { id: REPO, userId: USER, name: 'repo', source: 'local_path' });
  fake.insert(schema.userNotificationSettings, { userId: USER, soundEnabled: false });
  h.db = fake.db;
  return fake;
}

/** Every table the fake holds, as it stands: what a refused request is compared to. */
const everything = (fake: ReturnType<typeof setup>) =>
  Object.values(TABLES).map((table) => fake.rows(table));

const send = (route: string, { headers, body }: Sent) =>
  web.request(route, { method: 'POST', headers: { host: 'localhost:3001', ...headers }, body });

describe.each([{ name: `POST ${SOUND_PATH}`, route: SOUND_PATH }])(
  '$name through the whole app',
  ({ route }) => {
    it.each([
      ['a JSON body', JSON_BODY],
      ['a garbage multipart body', GARBAGE_MULTIPART],
    ])('answers 400 invalid_form for %s, and writes nothing', async (_what, sent) => {
      const fake = setup();
      const before = everything(fake);

      const res = await send(route, sent);

      // Soft, so a request that is refused wrongly AND wrote shows both.
      expect.soft(await answer(res)).toEqual(REFUSED);
      expect.soft(everything(fake)).toEqual(before);
    });

    it('lets a form without the file reach the handler, which answers its own 400', async () => {
      const fake = setup();
      const before = everything(fake);
      const form = new FormData();
      form.set('note', 'there is no file in this form');

      const res = await send(route, { body: form });

      expect.soft(await answer(res)).toEqual({ status: 400, code: null, named: true });
      expect.soft(everything(fake)).toEqual(before);
    });
  },
);

describe(`POST ${SOUND_PATH} with a real upload`, () => {
  let storage: string;
  let previousRoot: string | undefined;
  beforeAll(async () => {
    storage = await mkdtemp(path.join(tmpdir(), 'form-body-'));
    previousRoot = process.env.REPO_STORAGE_ROOT;
    process.env.REPO_STORAGE_ROOT = storage;
  });
  afterAll(async () => {
    if (previousRoot === undefined) delete process.env.REPO_STORAGE_ROOT;
    else process.env.REPO_STORAGE_ROOT = previousRoot;
    await rm(storage, { recursive: true, force: true });
  });

  it('still answers 201 and stores the sound', async () => {
    const fake = setup();
    const form = new FormData();
    form.set(
      'sound',
      new File([new Uint8Array([73, 68, 51, 4, 0, 0])], 'chime.mp3', { type: 'audio/mpeg' }),
    );

    const res = await send(SOUND_PATH, { body: form });

    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ hasCustomSound: true, soundFilename: 'chime.mp3' });
    expect(fake.rows(schema.userNotificationSettings)).toMatchObject([
      { userId: USER, soundMime: 'audio/mpeg', soundFilename: 'chime.mp3' },
    ]);
  });
});

// The public API mount must retire the buffered upload as well as the isolated router.
it('returns 404 for the retired repository upload through the app and keeps state', async () => {
  const fake = setup();
  const before = everything(fake);
  expect((await send('/repos/upload', JSON_BODY)).status).toBe(404);
  expect(everything(fake)).toEqual(before);
});
