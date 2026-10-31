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
import { getTableName } from 'drizzle-orm';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import {
  decrypt,
  decryptDek,
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

function setup(
  stored: string | null = STORED,
  row: { host?: string; provider?: string | null } = {},
) {
  const fake = createFakeDb({
    repoCredentials: schema.repoCredentials,
    integrationConnections: schema.integrationConnections,
    auditEvents: schema.auditEvents,
  });
  const dek = generateDek();
  fake.insert(schema.repoCredentials, {
    id: CREDENTIAL,
    userId: USER,
    label: 'work',
    host: row.host ?? HOST,
    provider: row.provider === undefined ? 'gitea' : row.provider,
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
  ['a user and password on the credential host', 'https://user:pass@git.example.com/api/v1'],
  ['a user alone on the credential host', 'https://user@git.example.com/api/v1'],
  ['a query', 'https://git.example.com/api/v1?x=1'],
  ['an empty query', 'https://git.example.com/api/v1?'],
  ['a fragment', 'https://git.example.com/api/v1#frag'],
  ['an empty fragment', 'https://git.example.com/api/v1#'],
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

type ForgeApiCase = [name: string, host: string, provider: string | undefined, apiBaseUrl: string];

const FORGE_API_ACCEPTED: ForgeApiCase[] = [
  ['github.com with github set', 'github.com', 'github', 'https://api.github.com'],
  ['github.com with a blank provider', 'github.com', '', 'https://api.github.com'],
  ['github.com with no provider', 'github.com', undefined, 'https://api.github.com'],
  ['github.com typed in capitals', 'GitHub.com', 'github', 'https://api.github.com'],
  ['github.com with a sub path', 'github.com', 'github', 'https://api.github.com/v3'],
  [
    'bitbucket.org with bitbucket_cloud set',
    'bitbucket.org',
    'bitbucket_cloud',
    'https://api.bitbucket.org/2.0',
  ],
  ['bitbucket.org with a blank provider', 'bitbucket.org', '', 'https://api.bitbucket.org/2.0'],
  [
    'GitHub Enterprise on its own host',
    'ghe.example.com',
    'github',
    'https://ghe.example.com/api/v3',
  ],
];

const FORGE_API_REFUSED: ForgeApiCase[] = [
  ['another host for github.com', 'github.com', 'github', 'https://evil.example'],
  ['api.github.com over http', 'github.com', 'github', 'http://api.github.com'],
  [
    'a host that only starts with api.github.com',
    'github.com',
    'github',
    'https://api.github.com.evil.example',
  ],
  ['api.github.com as userinfo', 'github.com', 'github', 'https://api.github.com@evil.example'],
  ['another port on api.github.com', 'github.com', 'github', 'https://api.github.com:8443'],
  [
    'the Bitbucket Cloud api host for github.com',
    'github.com',
    'github',
    'https://api.bitbucket.org/2.0',
  ],
  [
    'api.github.com when github.com is set to gitlab',
    'github.com',
    'gitlab',
    'https://api.github.com',
  ],
  ['api.github.com for GitHub Enterprise', 'ghe.example.com', 'github', 'https://api.github.com'],
  ['api.github.com for a self-hosted gitea', 'git.example.com', 'gitea', 'https://api.github.com'],
  [
    'api.github.com for a self-hosted host with no provider',
    'git.example.com',
    undefined,
    'https://api.github.com',
  ],
  [
    'api.bitbucket.org over http',
    'bitbucket.org',
    'bitbucket_cloud',
    'http://api.bitbucket.org/2.0',
  ],
  [
    'another host for bitbucket.org',
    'bitbucket.org',
    'bitbucket_cloud',
    'https://evil.example/2.0',
  ],
  [
    'api.bitbucket.org when bitbucket.org is set to gitea',
    'bitbucket.org',
    'gitea',
    'https://api.bitbucket.org/2.0',
  ],
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

  it.each(FORGE_API_ACCEPTED)(
    'takes the API base of %s',
    async (_name, host, provider, apiBaseUrl) => {
      const fake = setup();

      const res = await create({ host, provider, apiBaseUrl });

      expect(res.status).toBe(201);
      expect(fake.rows(schema.repoCredentials).find((r) => r.label === 'new')?.apiBaseUrl).toBe(
        apiBaseUrl,
      );
    },
  );

  it.each(FORGE_API_REFUSED)(
    'refuses %s with a 400 and stores nothing',
    async (_name, host, provider, apiBaseUrl) => {
      const fake = setup();
      const before = fake.rows(schema.repoCredentials).length;

      const res = await create({ host, provider, apiBaseUrl });

      expect(res.status).toBe(400);
      const body = (await res.json()) as { issues: { path: string }[] };
      expect(body.issues.map((i) => i.path)).toContain('apiBaseUrl');
      expect(fake.rows(schema.repoCredentials)).toHaveLength(before);
    },
  );
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

  it.each(FORGE_API_ACCEPTED)(
    'takes the API base of %s',
    async (_name, host, provider, apiBaseUrl) => {
      const fake = setup(null, { host, provider: provider || null });

      const res = await update({ host, apiBaseUrl });

      expect(res.status).toBe(200);
      expect(rowOf(fake).apiBaseUrl).toBe(apiBaseUrl);
    },
  );

  it.each(FORGE_API_REFUSED)(
    'refuses %s with a 400 and changes nothing',
    async (_name, host, provider, apiBaseUrl) => {
      const fake = setup(null, { host, provider: provider || null });

      const res = await update({ host, apiBaseUrl });

      expect(res.status).toBe(400);
      const body = (await res.json()) as { issues: { path: string }[] };
      expect(body.issues.map((i) => i.path)).toContain('apiBaseUrl');
      expect(rowOf(fake)).toMatchObject({ label: 'work', apiBaseUrl: null });
    },
  );

  it('judges the URL against the stored provider when the request names none', async () => {
    const fake = setup(null, { provider: 'bitbucket_cloud' });

    const res = await update({ apiBaseUrl: 'https://api.bitbucket.org/2.0' });

    expect(res.status).toBe(200);
    expect(rowOf(fake).apiBaseUrl).toBe('https://api.bitbucket.org/2.0');
  });

  it.each([[''], ['gitea']])(
    'judges the URL against the provider the request names (%j), not the stored one',
    async (provider) => {
      const fake = setup(null, { provider: 'bitbucket_cloud' });

      const res = await update({ provider, apiBaseUrl: 'https://api.bitbucket.org/2.0' });

      expect(res.status).toBe(400);
      expect(rowOf(fake)).toMatchObject({ provider: 'bitbucket_cloud', apiBaseUrl: null });
    },
  );

  it('judges the stored URL against a new host when the request leaves the URL out', async () => {
    const fake = setup();

    const res = await update({ host: 'other.example.com' });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { issues: { path: string }[] };
    expect(body.issues.map((i) => i.path)).toContain('apiBaseUrl');
    expect(rowOf(fake)).toMatchObject({ host: HOST, apiBaseUrl: STORED });
  });

  it('judges the stored URL against a new provider when the request leaves the URL out', async () => {
    const fake = setup('https://api.github.com', { host: 'github.com', provider: 'github' });

    const res = await update({ host: 'github.com', provider: 'gitea' });

    expect(res.status).toBe(400);
    expect(rowOf(fake)).toMatchObject({ provider: 'github', apiBaseUrl: 'https://api.github.com' });
  });

  it('moves a credential that has no URL to a new host', async () => {
    const fake = setup(null);

    const res = await update({ host: 'other.example.com' });

    expect(res.status).toBe(200);
    expect(rowOf(fake)).toMatchObject({ host: 'other.example.com', apiBaseUrl: null });
  });

  it('moves a credential to a new host when the request clears the stored URL', async () => {
    const fake = setup();

    const res = await update({ host: 'other.example.com', apiBaseUrl: '' });

    expect(res.status).toBe(200);
    expect(rowOf(fake)).toMatchObject({ host: 'other.example.com', apiBaseUrl: null });
  });

  it('keeps a stored URL that still fits the host and provider the row ends up with', async () => {
    const fake = setup('https://api.github.com', { host: 'github.com', provider: 'github' });

    const res = await update({ host: 'github.com', label: 'renamed' });

    expect(res.status).toBe(200);
    expect(rowOf(fake)).toMatchObject({ label: 'renamed', apiBaseUrl: 'https://api.github.com' });
  });
});

const HOST_REFUSED: [string, string][] = [
  ['the forge host as userinfo', 'github.com@evil.example'],
  ['a path', 'github.com/evil'],
  ['a space inside', 'a b'],
  ['a label that starts with a hyphen', '-x.com'],
  ['a label that ends with a hyphen', 'x-.com'],
  ['an empty label', 'x..com'],
  ['a trailing dot', 'git.example.com.'],
  ['port 0', 'host:0'],
  ['a port above 65535', 'host:65536'],
  ['a decimal IPv4 address', '2130706433'],
  ['a hex IPv4 address', '0x7f.1'],
  ['a numeric last label', 'git.example.com.1'],
  ['the https default port', 'git.example.com:443'],
  ['a port that is not a number', 'host:http'],
  ['a colon with no port', 'host:'],
  ['a scheme', 'https://git.example.com'],
  ['a query', 'git.example.com?x=1'],
  ['an underscore', 'git_host.example.com'],
  ['an empty host', ''],
  ['a blank host', '   '],
];

const HOST_ACCEPTED: [name: string, sent: string, stored: string][] = [
  ['a host name', 'git.example.com', 'git.example.com'],
  ['a host in capitals with surrounding space', ' GitHub.com ', 'github.com'],
  ['a host with a port', 'git.example.com:8443', 'git.example.com:8443'],
  ['a host with a port, in capitals', 'GIT.Example.com:8443', 'git.example.com:8443'],
  ['the lowest port', 'git.example.com:1', 'git.example.com:1'],
  ['the highest port', 'git.example.com:65535', 'git.example.com:65535'],
  ['a name with no dot', 'localhost:3000', 'localhost:3000'],
  ['an address', '192.168.1.10:3000', '192.168.1.10:3000'],
  ['hyphens inside a label', 'my-git.example.com', 'my-git.example.com'],
  ['a punycode label', 'xn--bcher-kva.example', 'xn--bcher-kva.example'],
];

describe('the host of a credential', () => {
  it.each(HOST_REFUSED)('refuses %s on create with a 400 on host', async (_name, host) => {
    const fake = setup(null);
    const before = fake.rows(schema.repoCredentials).length;

    const res = await create({ host });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { issues: { path: string }[] };
    expect(body.issues.map((i) => i.path)).toContain('host');
    expect(fake.rows(schema.repoCredentials)).toHaveLength(before);
  });

  it.each(HOST_REFUSED)('refuses %s on edit with a 400 on host', async (_name, host) => {
    const fake = setup(null);

    const res = await update({ host });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { issues: { path: string }[] };
    expect(body.issues.map((i) => i.path)).toContain('host');
    expect(rowOf(fake)).toMatchObject({ label: 'work', host: HOST });
  });

  it.each(HOST_ACCEPTED)(
    'takes %s on create and stores it trimmed and lower case',
    async (_name, host, stored) => {
      const fake = setup(null);

      const res = await create({ host });

      expect(res.status).toBe(201);
      const body = (await res.json()) as { credential: { host: string } };
      expect(body.credential.host).toBe(stored);
      expect(fake.rows(schema.repoCredentials).find((r) => r.label === 'new')?.host).toBe(stored);
      expect(new URL(`https://${stored}/`).host).toBe(stored);
    },
  );

  it.each(HOST_ACCEPTED)(
    'takes %s on edit and stores it trimmed and lower case',
    async (_name, host, stored) => {
      const fake = setup(null);

      const res = await update({ host });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { credential: { host: string } };
      expect(body.credential.host).toBe(stored);
      expect(rowOf(fake).host).toBe(stored);
    },
  );
});

type Handle = ReturnType<typeof setup>['db'];

// The fake's for() records nothing, so the handle is wrapped to log what the route asks of it.
function recorded(handle: Handle, events: string[], scope: 'db' | 'tx' = 'db'): Handle {
  const credentials = handle.query.repoCredentials;
  return {
    ...handle,
    query: {
      ...handle.query,
      repoCredentials: {
        findFirst: (opts) => {
          events.push(`${scope} reads repo_credentials`);
          return credentials.findFirst(opts);
        },
        findMany: (opts) => {
          events.push(`${scope} reads repo_credentials`);
          return credentials.findMany(opts);
        },
      },
    },
    select: (fields) => ({
      from: (table) => {
        const query = handle.select(fields).from(table);
        const { for: lockRows, then: run } = query;
        let lock = '';
        query.for = (strength, config) => {
          lock = ` for ${strength}`;
          return lockRows(strength, config);
        };
        query.then = (ok, bad) => {
          events.push(`${scope} selects ${getTableName(table)}${lock}`);
          return run(ok, bad);
        };
        return query;
      },
    }),
    update: (table) => {
      events.push(`${scope} updates ${getTableName(table)}`);
      return handle.update(table);
    },
    transaction: async (fn) => {
      events.push('begin');
      try {
        const result = await handle.transaction((tx) => fn(recorded(tx, events, 'tx')));
        events.push('commit');
        return result;
      } catch (err) {
        events.push('rollback');
        throw err;
      }
    },
  };
}

describe('the row an edit reads, judges and updates', () => {
  it('is read FOR UPDATE inside the transaction that updates it, and nowhere else', async () => {
    const fake = setup();
    const events: string[] = [];
    h.db = recorded(fake.db, events);

    const res = await update({ label: 'renamed' });

    expect(res.status).toBe(200);
    expect(rowOf(fake)).toMatchObject({ label: 'renamed' });
    expect(events).toEqual([
      'begin',
      'tx selects repo_credentials for update',
      'tx selects integration_connections',
      'tx updates repo_credentials',
      'commit',
    ]);
  });

  it.each([
    [{ username: 'new-ci' }, 'new-ci', 'tok'],
    [{ secret: 'new-tok' }, 'ci', 'new-tok'],
    [{ username: 'new-ci', secret: 'new-tok' }, 'new-ci', 'new-tok'],
  ])('writes a new username or secret, %j, under the same lock', async (body, username, secret) => {
    const fake = setup();
    const events: string[] = [];
    h.db = recorded(fake.db, events);

    const res = await update(body);

    expect(res.status).toBe(200);
    const row = rowOf(fake);
    const dek = decryptDek(row.encryptedDek as string, KEK);
    expect(decrypt(row.usernameEncrypted as string, dek)).toBe(username);
    expect(decrypt(row.secretEncrypted as string, dek)).toBe(secret);
    expect(events).toEqual([
      'begin',
      'tx selects repo_credentials for update',
      'tx selects integration_connections',
      'tx updates repo_credentials',
      'commit',
    ]);
  });

  it.each([
    ['a stored URL the new host does not fit', CREDENTIAL, { host: 'other.example.com' }, 400],
    ['a credential that does not exist', '00000000-0000-4000-8000-0000000000c9', {}, 404],
  ])('judges %s against the locked row and rolls back', async (_name, id, body, status) => {
    const fake = setup();
    const events: string[] = [];
    h.db = recorded(fake.db, events);

    const res = await app.request(`/${id}`, {
      method: 'PUT',
      ...json({ label: 'renamed', host: HOST, ...body }),
    });

    expect(res.status).toBe(status);
    expect(rowOf(fake)).toMatchObject({ label: 'work', host: HOST, apiBaseUrl: STORED });
    expect(events).toEqual(['begin', 'tx selects repo_credentials for update', 'rollback']);
  });
});
