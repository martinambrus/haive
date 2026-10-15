import { beforeEach, describe, expect, it, vi } from 'vitest';

const USER = vi.hoisted(() => '00000000-0000-4000-8000-0000000000a1');
const h = vi.hoisted(() => ({ db: undefined as unknown }));

vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/middleware/auth.js', () => ({
  requireAuth: async (c: { set: (key: string, value: string) => void }, next: () => unknown) => {
    c.set('userId', USER);
    await next();
  },
}));

import { Hono } from 'hono';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import {
  encrypt,
  encryptDek,
  generateDek,
  generateEncryptionKey,
  secretsService,
} from '@haive/shared';
import { repoCredentialsRoutes } from '../src/routes/repo-credentials.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';

const KEK = generateEncryptionKey();
const CREDENTIAL = '00000000-0000-4000-8000-0000000000c1';
const HOST = 'git.example.com';
const STORED = 'https://git.example.com/api/v1';

const app = new Hono<AppEnv>();
app.route('/', repoCredentialsRoutes);
app.onError(errorHandler);

function setup(stored: string | null = STORED) {
  const fake = createFakeDb({
    repoCredentials: schema.repoCredentials,
    auditEvents: schema.auditEvents,
  });
  const dek = generateDek();
  fake.insert(schema.repoCredentials, {
    id: CREDENTIAL,
    userId: USER,
    label: 'work',
    host: HOST,
    provider: 'gitea',
    apiBaseUrl: stored,
    usernameEncrypted: encrypt('ci', dek),
    secretEncrypted: encrypt('tok', dek),
    encryptedDek: encryptDek(dek, KEK),
  });
  h.db = fake.db;
  return fake;
}

const json = (body: Record<string, unknown>) => ({
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

const create = (body: Record<string, unknown>) =>
  app.request('/', {
    method: 'POST',
    ...json({
      label: 'new',
      host: HOST,
      username: 'ci',
      secret: 'tok',
      provider: 'gitea',
      ...body,
    }),
  });

const update = (body: Record<string, unknown>) =>
  app.request(`/${CREDENTIAL}`, {
    method: 'PUT',
    ...json({ label: 'work', host: HOST, ...body }),
  });

const REFUSED: [string, string][] = [
  ['plain http', 'http://git.example.com/api/v1'],
  ['another host', 'https://other.example.com/api/v1'],
  [
    'a host that only starts with the credential host',
    'https://git.example.com.evil.example/api/v1',
  ],
  ['the credential host as userinfo', 'https://git.example.com@evil.example/api/v1'],
  ['a backslash that ends the host early', 'https://evil.example\\@git.example.com/api/v1'],
  ['another port', 'https://git.example.com:8443/api/v1'],
  ['a javascript url', 'javascript:alert(1)'],
  ['a data url', 'data:text/plain,git.example.com'],
  ['ftp', 'ftp://git.example.com/api/v1'],
  ['no scheme', 'git.example.com/api/v1'],
  ['a scheme-relative url', '//git.example.com/api/v1'],
  ['https with no host', 'https://'],
];

const ACCEPTED: [string, string, string][] = [
  ['an https url on the credential host', 'https://git.example.com/api/v1', STORED],
  [
    'the same host spelled in capitals',
    'HTTPS://GIT.EXAMPLE.COM/api/v1',
    'HTTPS://GIT.EXAMPLE.COM/api/v1',
  ],
  [
    'the default port spelled out',
    'https://git.example.com:443/api/v1',
    'https://git.example.com:443/api/v1',
  ],
  [
    'a url with a sub path',
    'https://git.example.com/gitea/api/v1',
    'https://git.example.com/gitea/api/v1',
  ],
  ['a url with surrounding space', `  ${STORED}  `, STORED],
];

beforeEach(() => {
  vi.spyOn(secretsService, 'getMasterKek').mockResolvedValue(KEK);
});

const rowOf = (fake: ReturnType<typeof setup>) => fake.rows(schema.repoCredentials)[0]!;

describe('creating a credential with an API base URL', () => {
  it.each(REFUSED)('refuses %s with a 400 and stores nothing', async (_name, apiBaseUrl) => {
    const fake = setup();
    const before = fake.rows(schema.repoCredentials).length;

    const res = await create({ apiBaseUrl });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { issues: { path: string }[] };
    expect(body.issues.map((i) => i.path)).toContain('apiBaseUrl');
    expect(fake.rows(schema.repoCredentials)).toHaveLength(before);
  });

  it.each(ACCEPTED)('takes %s', async (_name, apiBaseUrl, stored) => {
    const fake = setup();

    const res = await create({ apiBaseUrl });

    expect(res.status).toBe(201);
    const created = fake.rows(schema.repoCredentials).find((r) => r.label === 'new');
    expect(created?.apiBaseUrl).toBe(stored);
  });

  it.each([[''], ['   '], [undefined]])(
    'takes a blank API base URL (%j) as none',
    async (apiBaseUrl) => {
      const fake = setup();

      const res = await create({ apiBaseUrl });

      expect(res.status).toBe(201);
      expect(
        fake.rows(schema.repoCredentials).find((r) => r.label === 'new')?.apiBaseUrl,
      ).toBeNull();
    },
  );

  it('compares the port too: a host with a port takes a url with that port', async () => {
    const fake = setup();

    const res = await create({
      host: 'git.example.com:8443',
      apiBaseUrl: 'https://git.example.com:8443/api/v1',
    });

    expect(res.status).toBe(201);
    expect(fake.rows(schema.repoCredentials).find((r) => r.label === 'new')?.apiBaseUrl).toBe(
      'https://git.example.com:8443/api/v1',
    );
  });
});

describe('updating a credential with an API base URL', () => {
  it.each(REFUSED)('refuses %s with a 400 and changes nothing', async (_name, apiBaseUrl) => {
    const fake = setup();

    const res = await update({ label: 'renamed', apiBaseUrl });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { issues: { path: string }[] };
    expect(body.issues.map((i) => i.path)).toContain('apiBaseUrl');
    expect(rowOf(fake)).toMatchObject({ label: 'work', apiBaseUrl: STORED });
  });

  it.each(ACCEPTED)('takes %s', async (_name, apiBaseUrl, stored) => {
    const fake = setup(null);

    const res = await update({ apiBaseUrl });

    expect(res.status).toBe(200);
    expect(rowOf(fake).apiBaseUrl).toBe(stored);
  });

  it.each([[''], ['   ']])('clears the API base URL on a blank one (%j)', async (apiBaseUrl) => {
    const fake = setup();

    const res = await update({ apiBaseUrl });

    expect(res.status).toBe(200);
    expect(rowOf(fake).apiBaseUrl).toBeNull();
  });

  it('keeps the API base URL when the request does not mention it', async () => {
    const fake = setup();

    const res = await update({ label: 'renamed' });

    expect(res.status).toBe(200);
    expect(rowOf(fake)).toMatchObject({ label: 'renamed', apiBaseUrl: STORED });
  });

  it('judges the URL against the host the request names, not the stored one', async () => {
    const fake = setup();

    const stale = await update({ host: 'other.example.com', apiBaseUrl: STORED });
    expect(stale.status).toBe(400);
    expect(rowOf(fake)).toMatchObject({ host: HOST, apiBaseUrl: STORED });

    const moved = await update({
      host: 'other.example.com',
      apiBaseUrl: 'https://other.example.com/api/v1',
    });
    expect(moved.status).toBe(200);
    expect(rowOf(fake)).toMatchObject({
      host: 'other.example.com',
      apiBaseUrl: 'https://other.example.com/api/v1',
    });
  });
});
