import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const USER = vi.hoisted(() => '00000000-0000-4000-8000-0000000000a1');
const h = vi.hoisted(() => ({
  db: undefined as unknown,
  role: 'user',
  add: vi.fn(async (..._args: unknown[]) => undefined),
}));

vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/middleware/auth.js', () => ({
  requireAuth: async (c: { set: (key: string, value: string) => void }, next: () => unknown) => {
    c.set('userId', USER);
    c.set('userRole', h.role);
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
import { configService, CONFIG_KEYS, DEFAULT_AGENT_RULES } from '@haive/shared';
import { cliProviderRoutes } from '../src/routes/cli-providers.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';

const PROVIDER = '00000000-0000-4000-8000-0000000000b1';

const app = new Hono<AppEnv>();
app.route('/', cliProviderRoutes);
app.onError(errorHandler);

function setup(row?: {
  name: string;
  model: string | null;
  modelfile?: string;
  envVars?: Record<string, string>;
}) {
  const fake = createFakeDb({
    auditEvents: schema.auditEvents,
    cliProviders: schema.cliProviders,
    cliPackageVersions: schema.cliPackageVersions,
    cliProviderSecrets: schema.cliProviderSecrets,
  });
  if (row) {
    fake.insert(schema.cliProviders, {
      id: PROVIDER,
      userId: USER,
      label: 'p',
      rulesContent: DEFAULT_AGENT_RULES,
      ...row,
    });
  }
  h.db = fake.db;
  return fake;
}

function post(body: Record<string, unknown>) {
  return app.request('/', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ label: 'p', authMode: 'api_key', ...body }),
  });
}

function patch(body: Record<string, unknown>) {
  return app.request(`/${PROVIDER}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  h.role = 'user';
  vi.spyOn(configService, 'get').mockImplementation(async (key) =>
    key === CONFIG_KEYS.OLLAMA_MODEL_ALLOWLIST ? 'allowed' : null,
  );
  h.add.mockReset();
  h.add.mockResolvedValue(undefined);
  vi.spyOn(configService, 'getFresh').mockResolvedValue('normal');
});

afterEach(() => vi.restoreAllMocks());

describe('in-stack Ollama provider save policy', () => {
  it.each(['create', 'patch', 'clone'])(
    'refuses a disallowed model on %s before any write or queue',
    async (operation) => {
      const fake = setup(operation === 'create' ? undefined : { name: 'ollama', model: 'blocked' });
      const before = structuredClone(fake.rows(schema.cliProviders));
      const res =
        operation === 'create'
          ? await post({ name: 'ollama', model: 'blocked' })
          : operation === 'patch'
            ? await patch({ label: 'edited' })
            : await app.request(`/${PROVIDER}/clone`, { method: 'POST' });
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({
        code: 'ollama_model_not_allowed',
        error: expect.any(String),
      });
      expect(fake.rows(schema.cliProviders)).toEqual(before);
      expect(fake.rows(schema.auditEvents)).toEqual([]);
      expect(h.add).not.toHaveBeenCalled();
    },
  );

  it.each(['create', 'patch', 'clone'])(
    'refuses a disallowed FROM on %s before any write or queue',
    async (operation) => {
      const values = { name: 'ollama', model: 'allowed', modelfile: 'FROM blocked' };
      const fake = setup(operation === 'create' ? undefined : values);
      const before = structuredClone(fake.rows(schema.cliProviders));
      const res =
        operation === 'create'
          ? await post(values)
          : operation === 'patch'
            ? await patch({ modelfile: 'FROM blocked\nPARAMETER num_ctx 32' })
            : await app.request(`/${PROVIDER}/clone`, { method: 'POST' });
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ code: 'ollama_model_not_allowed' });
      expect(fake.rows(schema.cliProviders)).toEqual(before);
      expect(fake.rows(schema.auditEvents)).toEqual([]);
      expect(h.add).not.toHaveBeenCalled();
    },
  );

  it('refuses replacing an allowed model with a disallowed model', async () => {
    const fake = setup({ name: 'ollama', model: 'allowed' });
    const before = structuredClone(fake.rows(schema.cliProviders));
    expect((await patch({ model: 'blocked' })).status).toBe(403);
    expect(fake.rows(schema.cliProviders)).toEqual(before);
    expect(h.add).not.toHaveBeenCalled();
  });

  it('checks a newly supplied FROM base rather than the stored base', async () => {
    const fake = setup({ name: 'ollama', model: 'allowed', modelfile: 'FROM allowed' });
    const before = structuredClone(fake.rows(schema.cliProviders));
    expect((await patch({ modelfile: 'FROM blocked' })).status).toBe(403);
    expect(fake.rows(schema.cliProviders)).toEqual(before);
    expect(h.add).not.toHaveBeenCalled();
  });

  it('refuses switching an external provider to the in-stack endpoint', async () => {
    const fake = setup({
      name: 'ollama',
      model: 'blocked',
      envVars: { ANTHROPIC_BASE_URL: 'https://external.example' },
    });
    const before = structuredClone(fake.rows(schema.cliProviders));
    expect((await patch({ envVars: {} })).status).toBe(403);
    expect(fake.rows(schema.cliProviders)).toEqual(before);
    expect(h.add).not.toHaveBeenCalled();
  });

  it.each(['create', 'patch', 'clone'])(
    'allows an allowlisted model and base on %s',
    async (operation) => {
      const values = { name: 'ollama', model: 'allowed', modelfile: 'FROM ALLOWED:latest' };
      setup(operation === 'create' ? undefined : values);
      const res =
        operation === 'create'
          ? await post(values)
          : operation === 'patch'
            ? await patch({ modelfile: 'FROM allowed' })
            : await app.request(`/${PROVIDER}/clone`, { method: 'POST' });
      expect(res.status).toBe(operation === 'patch' ? 200 : 201);
      expect(h.add.mock.calls.some(([name]) => name === 'cli-provision-ollama-model')).toBe(true);
    },
  );

  it('refuses a concurrent model substitution after the policy read', async () => {
    const fake = setup({ name: 'ollama', model: 'allowed' });
    vi.mocked(configService.get).mockImplementation(async (key) => {
      await fake.db
        .update(schema.cliProviders)
        .set({ model: 'blocked' })
        .where(eq(schema.cliProviders.id, PROVIDER));
      return key === CONFIG_KEYS.OLLAMA_MODEL_ALLOWLIST ? 'allowed' : null;
    });
    const res = await patch({ label: 'edited' });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'ollama_provider_changed' });
    expect(fake.rows(schema.cliProviders)[0]!.label).toBe('p');
    expect(fake.rows(schema.auditEvents)).toEqual([]);
    expect(h.add).not.toHaveBeenCalled();
  });

  it('allows an administrator an arbitrary model and base', async () => {
    h.role = 'admin';
    setup();
    expect(
      (await post({ name: 'ollama', model: 'blocked', modelfile: 'FROM blocked-base' })).status,
    ).toBe(201);
  });

  it('keeps external endpoints outside the save gate', async () => {
    setup();
    expect(
      (
        await post({
          name: 'ollama',
          model: 'blocked',
          modelfile: 'FROM blocked-base',
          envVars: { ANTHROPIC_BASE_URL: 'https://external.example' },
        })
      ).status,
    ).toBe(201);
    expect(h.add.mock.calls.some(([name]) => name === 'cli-provision-ollama-model')).toBe(true);
  });
});
