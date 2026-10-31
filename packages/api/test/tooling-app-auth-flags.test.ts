import { describe, expect, it, vi } from 'vitest';

const USER = vi.hoisted(() => '00000000-0000-4000-8000-0000000000a1');
const h = vi.hoisted(() => ({
  db: undefined as unknown,
  secrets: {} as Record<string, string>,
  get: vi.fn(async (): Promise<string | null> => {
    throw new Error('Failed to decrypt user secret');
  }),
}));

vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/middleware/auth.js', () => ({
  requireAuth: async (c: { set: (key: string, value: string) => void }, next: () => unknown) => {
    c.set('userId', USER);
    await next();
  },
}));

vi.mock('@haive/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@haive/shared')>()),
  userSecretsService: {
    get: h.get,
    listForUser: async () =>
      Object.keys(h.secrets).map((keyName) => ({ keyName, fingerprint: null })),
  },
}));

import { Hono } from 'hono';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { toolingUpgradeRoutes } from '../src/routes/tooling-upgrades.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';

const REPO = '00000000-0000-4000-8000-0000000000c1';
const USERNAME = 'stored-user-7f3';
const PASSWORD = 'stored-pass-9c1';

const app = new Hono<AppEnv>();
app.route('/', toolingUpgradeRoutes);
app.onError(errorHandler);

async function toolingConfig(secrets: Record<string, string>) {
  const fake = createFakeDb({
    repositories: schema.repositories,
    auditEvents: schema.auditEvents,
    onboardingArtifacts: schema.onboardingArtifacts,
    projectStateOutbox: schema.projectStateOutbox,
    envTemplates: schema.envTemplates,
    toolPackageVersions: schema.toolPackageVersions,
    stepGuidance: schema.stepGuidance,
  });
  fake.insert(schema.repositories, { id: REPO, userId: USER, name: 'r', source: 'local_path' });
  h.db = fake.db;
  h.secrets = secrets;
  const res = await app.request(`/${REPO}/tooling-config`);
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

const username = { [`app_auth:${REPO}:username`]: USERNAME };
const password = { [`app_auth:${REPO}:password`]: PASSWORD };

describe('the app-login credential flags of GET tooling-config', () => {
  it.each([
    [
      'only a username',
      username,
      { appAuthUsernameSet: true, appAuthPasswordSet: false, appAuthCredentialsSet: false },
    ],
    [
      'only a password',
      password,
      { appAuthUsernameSet: false, appAuthPasswordSet: true, appAuthCredentialsSet: false },
    ],
    [
      'both',
      { ...username, ...password },
      { appAuthUsernameSet: true, appAuthPasswordSet: true, appAuthCredentialsSet: true },
    ],
    [
      'neither',
      {},
      { appAuthUsernameSet: false, appAuthPasswordSet: false, appAuthCredentialsSet: false },
    ],
  ])('with %s stored', async (_what, secrets, expected) => {
    expect(await toolingConfig(secrets)).toMatchObject(expected);
  });

  it('reads presence without decrypting, so a secret that no longer decrypts still reads as stored', async () => {
    expect(await toolingConfig(password)).toMatchObject({ appAuthPasswordSet: true });
    expect(h.get).not.toHaveBeenCalled();
  });

  it('answers with booleans only, never a stored value', async () => {
    const body = JSON.stringify(await toolingConfig({ ...username, ...password }));
    expect(body).not.toContain(USERNAME);
    expect(body).not.toContain(PASSWORD);
  });
});
