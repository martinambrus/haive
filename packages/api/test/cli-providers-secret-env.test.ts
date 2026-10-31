import { beforeEach, describe, expect, it, vi } from 'vitest';

const USER = vi.hoisted(() => '00000000-0000-4000-8000-0000000000a1');
const h = vi.hoisted(() => ({
  db: undefined as unknown,
  add: vi.fn(async (..._args: unknown[]) => undefined),
}));

vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/middleware/auth.js', () => ({
  requireAuth: async (c: { set: (key: string, value: string) => void }, next: () => unknown) => {
    c.set('userId', USER);
    await next();
  },
}));
vi.mock('../src/queues.js', () => ({
  getCliExecQueue: () => ({ add: h.add }),
  getUsagePollQueue: () => ({ add: vi.fn() }),
}));

import { Hono } from 'hono';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { configService, DEFAULT_AGENT_RULES, envelopeDecrypt, secretsService } from '@haive/shared';
import { cliProviderRoutes } from '../src/routes/cli-providers.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';

const PROVIDER = '00000000-0000-4000-8000-0000000000b1';
const KEK = 'ab'.repeat(32);
const SECRET_VALUE = 'sk-test-value-123';

const app = new Hono<AppEnv>();
app.route('/', cliProviderRoutes);
app.onError(errorHandler);

function setup(existing = false) {
  const fake = createFakeDb({
    auditEvents: schema.auditEvents,
    cliProviders: schema.cliProviders,
    cliPackageVersions: schema.cliPackageVersions,
    cliProviderSecrets: schema.cliProviderSecrets,
  });
  if (existing) {
    fake.insert(schema.cliProviders, {
      id: PROVIDER,
      userId: USER,
      name: 'claude-code',
      label: 'p',
      rulesContent: DEFAULT_AGENT_RULES,
      envVars: { ANTHROPIC_BASE_URL: 'https://old.example' },
    });
  }
  h.db = fake.db;
  return fake;
}

function send(method: string, path: string, body: Record<string, unknown>) {
  return app.request(path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const ENV = { ANTHROPIC_BASE_URL: 'https://api.example', ANTHROPIC_API_KEY: SECRET_VALUE };

beforeEach(() => {
  h.add.mockReset();
  h.add.mockResolvedValue(undefined);
  vi.spyOn(secretsService, 'getMasterKek').mockResolvedValue(KEK);
  vi.spyOn(configService, 'getFresh').mockResolvedValue('normal');
});

function secretValues(fake: ReturnType<typeof setup>): Record<string, string> {
  return Object.fromEntries(
    fake
      .rows(schema.cliProviderSecrets)
      .map((r) => [
        r.secretName as string,
        envelopeDecrypt(
          { encryptedValue: r.encryptedValue as string, encryptedDek: r.encryptedDek as string },
          KEK,
        ),
      ]),
  );
}

describe('a provider saved through the API with a secret-looking env key', () => {
  it('create stores the key as a secret, not in envVars, and never echoes it', async () => {
    const fake = setup();
    const res = await send('POST', '/', {
      name: 'claude-code',
      label: 'p',
      authMode: 'api_key',
      envVars: ENV,
    });
    expect(res.status).toBe(201);
    expect(JSON.stringify(await res.json())).not.toContain(SECRET_VALUE);
    expect(fake.rows(schema.cliProviders)[0]!.envVars).toEqual({
      ANTHROPIC_BASE_URL: 'https://api.example',
    });
    expect(secretValues(fake)).toEqual({ ANTHROPIC_API_KEY: SECRET_VALUE });
  });

  it('update stores the key as a secret, not in envVars, and never echoes it', async () => {
    const fake = setup(true);
    const res = await send('PATCH', `/${PROVIDER}`, { envVars: ENV });
    expect(res.status).toBe(200);
    expect(JSON.stringify(await res.json())).not.toContain(SECRET_VALUE);
    expect(fake.rows(schema.cliProviders)[0]!.envVars).toEqual({
      ANTHROPIC_BASE_URL: 'https://api.example',
    });
    expect(secretValues(fake)).toEqual({ ANTHROPIC_API_KEY: SECRET_VALUE });
  });

  it('update overwrites a secret of the same name', async () => {
    const fake = setup(true);
    await send('PATCH', `/${PROVIDER}`, { envVars: { ANTHROPIC_API_KEY: 'old-value' } });
    await send('PATCH', `/${PROVIDER}`, { envVars: ENV });
    expect(secretValues(fake)).toEqual({ ANTHROPIC_API_KEY: SECRET_VALUE });
    expect(fake.rows(schema.cliProviderSecrets)).toHaveLength(1);
  });

  it('update without envVars leaves envVars and secrets alone', async () => {
    const fake = setup(true);
    const res = await send('PATCH', `/${PROVIDER}`, { label: 'renamed' });
    expect(res.status).toBe(200);
    expect(fake.rows(schema.cliProviders)[0]!.envVars).toEqual({
      ANTHROPIC_BASE_URL: 'https://old.example',
    });
    expect(fake.rows(schema.cliProviderSecrets)).toHaveLength(0);
  });
});

describe('cloning a provider saved before the split', () => {
  it('gives the clone the legacy key as a secret, never in envVars', async () => {
    const fake = setup();
    fake.insert(schema.cliProviders, {
      id: PROVIDER,
      userId: USER,
      name: 'claude-code',
      label: 'p',
      rulesContent: DEFAULT_AGENT_RULES,
      envVars: ENV,
    });
    const res = await send('POST', `/${PROVIDER}/clone`, {});
    expect(res.status).toBe(201);
    expect(JSON.stringify(await res.json())).not.toContain(SECRET_VALUE);
    const clone = fake.rows(schema.cliProviders).find((r) => r.id !== PROVIDER)!;
    expect(clone.envVars).toEqual({ ANTHROPIC_BASE_URL: 'https://api.example' });
    const cloneSecrets = fake
      .rows(schema.cliProviderSecrets)
      .filter((r) => r.providerId === clone.id)
      .map((r) => r.secretName);
    expect(cloneSecrets).toEqual(['ANTHROPIC_API_KEY']);
  });
});

describe('POST /:providerId/secrets', () => {
  it('answers 201 for a new secret and 200 when it overwrites one, never echoing the value', async () => {
    const fake = setup(true);
    const first = await send('POST', `/${PROVIDER}/secrets`, {
      secretName: 'API_KEY',
      value: 'old-value',
    });
    expect(first.status).toBe(201);
    const second = await send('POST', `/${PROVIDER}/secrets`, {
      secretName: 'API_KEY',
      value: SECRET_VALUE,
    });
    expect(second.status).toBe(200);
    const body = (await second.json()) as { secret: Record<string, unknown> };
    expect(JSON.stringify(body)).not.toContain(SECRET_VALUE);
    expect(body.secret).toMatchObject({ secretName: 'API_KEY' });
    expect(secretValues(fake)).toEqual({ API_KEY: SECRET_VALUE });
  });
});
