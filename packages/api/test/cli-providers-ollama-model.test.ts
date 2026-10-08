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
import { DEFAULT_AGENT_RULES } from '@haive/shared';
import { cliProviderRoutes } from '../src/routes/cli-providers.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';

const PROVIDER = '00000000-0000-4000-8000-0000000000b1';
const MESSAGE = 'An ollama provider needs a model (set the model field).';

const app = new Hono<AppEnv>();
app.route('/', cliProviderRoutes);
app.onError(errorHandler);

function setup(row?: { name: string; model: string | null }) {
  const fake = createFakeDb({
    cliProviders: schema.cliProviders,
    cliPackageVersions: schema.cliPackageVersions,
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
  h.add.mockReset();
  h.add.mockResolvedValue(undefined);
});

describe('saving an ollama provider without a model', () => {
  it.each([[{}], [{ model: null }], [{ model: '   ' }]])(
    'refuses a create with model %j',
    async (extra) => {
      const fake = setup();
      const res = await post({ name: 'ollama', ...extra });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe(MESSAGE);
      expect(fake.rows(schema.cliProviders)).toHaveLength(0);
    },
  );

  it.each([[null], ['   ']])('refuses an update that clears the model to %j', async (model) => {
    const fake = setup({ name: 'ollama', model: 'qwen3-coder:30b' });
    const res = await patch({ model });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(MESSAGE);
    expect(fake.rows(schema.cliProviders)[0]!.model).toBe('qwen3-coder:30b');
  });

  it('still saves an ollama provider that has a model', async () => {
    setup();
    const res = await post({ name: 'ollama', model: 'qwen3-coder:30b' });
    expect(res.status).toBe(201);
  });

  it('still updates an ollama provider to another model', async () => {
    const fake = setup({ name: 'ollama', model: 'qwen3-coder:30b' });
    const res = await patch({ model: 'qwen3-coder:480b-cloud' });
    expect(res.status).toBe(200);
    expect(fake.rows(schema.cliProviders)[0]!.model).toBe('qwen3-coder:480b-cloud');
  });

  it('still saves a provider of another CLI without a model', async () => {
    setup();
    const res = await post({ name: 'claude-code', authMode: 'subscription' });
    expect(res.status).toBe(201);
  });

  it('still lets a provider of another CLI clear its model', async () => {
    setup({ name: 'claude-code', model: 'claude-opus' });
    const res = await patch({ model: null });
    expect(res.status).toBe(200);
  });

  it('leaves an existing modelless ollama row editable when the update does not touch the model', async () => {
    setup({ name: 'ollama', model: null });
    const res = await patch({ enabled: false });
    expect(res.status).toBe(200);
  });
});

describe('cloning an ollama provider', () => {
  const clone = () => app.request(`/${PROVIDER}/clone`, { method: 'POST' });

  it('refuses to clone one without a model, and adds no row', async () => {
    const fake = setup({ name: 'ollama', model: null });
    const res = await clone();
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(MESSAGE);
    expect(fake.rows(schema.cliProviders)).toHaveLength(1);
  });
});
