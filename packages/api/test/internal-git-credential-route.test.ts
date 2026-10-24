import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const SECRET = 'git-credential-route-test-secret';

const h = vi.hoisted(() => ({
  repo: null as {
    userId: string;
    credentialsSecretId: string | null;
    remoteUrl: string | null;
  } | null,
  cred: null as {
    userId: string;
    host: string;
    usernameEncrypted: string;
    secretEncrypted: string;
    encryptedDek: string;
  } | null,
  lookups: 0,
}));

vi.mock('../src/db.js', () => ({
  getDb: () => ({
    query: {
      repositories: {
        findFirst: async () => {
          h.lookups += 1;
          return h.repo;
        },
      },
      repoCredentials: {
        findFirst: async () => {
          h.lookups += 1;
          return h.cred;
        },
      },
    },
  }),
}));

import { createHmac } from 'node:crypto';
import { Hono } from 'hono';
import {
  encrypt,
  encryptDek,
  generateDek,
  generateEncryptionKey,
  secretsService,
  signRepoGitCredToken,
} from '@haive/shared';
import { TASK_TOKEN_AUDIENCES, signTaskToken } from '@haive/shared/task-token';
import { internalRoutes } from '../src/routes/internal.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';

const app = new Hono<AppEnv>();
app.route('/internal', internalRoutes);
app.onError(errorHandler);

const KEK = generateEncryptionKey();
const USERNAME = 'x-access-token';
const PASSWORD = 'ghp_route_test_password';
const REPO_ID = 'repo-1';
const USER_ID = 'user-1';

async function post(
  token: string | null,
  headers: Record<string, string> = {},
  target: unknown = { protocol: 'https', host: 'github.com' },
): Promise<Response> {
  return app.request('/internal/git-credential', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: JSON.stringify(target),
  });
}

const v1Token = (repositoryId = REPO_ID, userId = USER_ID, ttlSeconds?: number): string =>
  signRepoGitCredToken(repositoryId, userId, SECRET, ttlSeconds);

/** The two-part form from before v1, `<payload>.<hmac(raw secret, payload)>`, which nothing signs now. */
function legacyToken(repositoryId = REPO_ID, userId = USER_ID, ttlSeconds = 60): string {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const payload = Buffer.from(JSON.stringify({ repositoryId, userId, exp })).toString('base64url');
  return `${payload}.${createHmac('sha256', SECRET).update(payload).digest('base64url')}`;
}

/** A v1 token keyed with the raw secret, as the legacy form was, rather than the derived key. */
function v1WithRawKey(): string {
  const exp = Math.floor(Date.now() / 1000) + 60;
  const payload = Buffer.from(
    JSON.stringify({ repositoryId: REPO_ID, userId: USER_ID, exp }),
  ).toString('base64url');
  return `v1.${payload}.${createHmac('sha256', SECRET).update(`v1.${payload}`).digest('base64url')}`;
}

/** A task token whose payload also carries the git claims, so only its MAC key keeps it out. */
function taskTokenWithGitClaims(aud: string): string {
  const exp = Math.floor(Date.now() / 1000) + 60;
  const payload = Buffer.from(
    JSON.stringify({ aud, taskId: 'task-1', repositoryId: REPO_ID, userId: USER_ID, exp }),
  ).toString('base64url');
  const key = createHmac('sha256', SECRET).update(`haive-task-token:${aud}`).digest();
  return `v1.${payload}.${createHmac('sha256', key).update(`v1.${payload}`).digest('base64url')}`;
}

beforeEach(() => {
  vi.stubEnv('CONFIG_ENCRYPTION_KEY', SECRET);
  vi.spyOn(secretsService, 'getMasterKek').mockResolvedValue(KEK);
  const dek = generateDek();
  h.repo = {
    userId: USER_ID,
    credentialsSecretId: 'cred-1',
    remoteUrl: 'https://github.com/acme/app.git',
  };
  h.cred = {
    userId: USER_ID,
    host: 'github.com',
    usernameEncrypted: encrypt(USERNAME, dek),
    secretEncrypted: encrypt(PASSWORD, dek),
    encryptedDek: encryptDek(dek, KEK),
  };
  h.lookups = 0;
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('POST /internal/git-credential', () => {
  it('accepts host case and the explicit default port Git sends', async () => {
    h.repo!.remoteUrl = 'https://github.com:443/acme/app.git';
    const res = await post(v1Token(), {}, { protocol: 'https', host: 'GITHUB.COM:443' });
    expect(res.status).toBe(200);
  });
  it.each([
    {},
    { protocol: 'https', host: 'other.example.test' },
    { protocol: 'http', host: 'github.com' },
    { protocol: 'https', host: 'github.com:8443' },
  ])('emits nothing for an unbound target %j', async (target) => {
    const res = await post(v1Token(), {}, target);
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
  });
  it('emits nothing after the credential host drifts', async () => {
    h.cred!.host = 'other.example.test';
    expect((await post(v1Token())).status).toBe(204);
  });
  it('serves a v1 token the credential bound to the repository', async () => {
    const token = v1Token();

    const res = await post(token);

    expect(token.startsWith('v1.')).toBe(true);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ username: USERNAME, password: PASSWORD });
  });

  it('refuses the legacy two-part token, however fresh and well signed', async () => {
    const token = legacyToken();

    const res = await post(token);

    expect(token.split('.')).toHaveLength(2);
    expect(res.status).toBe(401);
    expect(h.lookups).toBe(0);
  });

  it('answers 404 when a v1 token names a user who does not own the repository', async () => {
    const res = await post(v1Token(REPO_ID, 'user-2'));

    expect(res.status).toBe(404);
  });

  it.each([...TASK_TOKEN_AUDIENCES])('refuses a %s task token', async (aud) => {
    const res = await post(signTaskToken({ aud, taskId: REPO_ID }, SECRET));

    expect(res.status).toBe(401);
    expect(h.lookups).toBe(0);
  });

  it.each([...TASK_TOKEN_AUDIENCES])(
    'refuses a %s task token whose payload carries the git claims',
    async (aud) => {
      const res = await post(taskTokenWithGitClaims(aud));

      expect(res.status).toBe(401);
      expect(h.lookups).toBe(0);
    },
  );

  it.each([
    ['an expired v1 token', () => v1Token(REPO_ID, USER_ID, -1)],
    [
      'a v1 token signed with another secret',
      () => signRepoGitCredToken(REPO_ID, USER_ID, 'other-secret'),
    ],
    ['a v1 token keyed with the raw secret', v1WithRawKey],
    ['a malformed token', () => 'v1.not.a-token'],
  ])('refuses %s', async (_name, mint) => {
    const res = await post(mint());

    expect(res.status).toBe(401);
    expect(h.lookups).toBe(0);
  });

  it.each([
    ['no Authorization header', {}],
    ['an empty Bearer token', { authorization: 'Bearer ' }],
    ['another scheme', { authorization: `Basic ${v1Token()}` }],
    ['no scheme', { authorization: v1Token() }],
  ])('refuses %s', async (_name, headers) => {
    const res = await post(null, headers);

    expect(res.status).toBe(401);
    expect(h.lookups).toBe(0);
  });
});
