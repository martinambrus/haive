import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ db: undefined as unknown, fetchFn: vi.fn() }));
vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/lib/probe-hosts.js', () => ({
  probeEgressFor: async () => ({ fetchFn: h.fetchFn }),
}));

import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { DEFAULT_EMBED_MODEL } from '@haive/shared/global-kb';
import { CONFIG_KEYS, configService, secretsService } from '@haive/shared';
import { signAccessToken } from '../src/auth/jwt.js';
import { createApiApp } from '../src/index.js';

const USER = '00000000-0000-4000-8000-000000000001';
const ADMIN = '00000000-0000-4000-8000-000000000002';
const OTHER = '00000000-0000-4000-8000-000000000003';
const PATH = '/admin/config/ollama-model-allowlist';
const KEY = CONFIG_KEYS.OLLAMA_MODEL_ALLOWLIST;
const stored = new Map<string, string>();
let fake: ReturnType<typeof createFakeDb>;
const app = createApiApp('http://localhost:3000');

beforeEach(() => {
  stored.clear();
  fake = createFakeDb({
    users: schema.users,
    cliProviders: schema.cliProviders,
    auditEvents: schema.auditEvents,
  });
  for (const [id, role] of [
    [USER, 'user'],
    [ADMIN, 'admin'],
    [OTHER, 'user'],
  ]) {
    fake.insert(schema.users, { id, role, status: 'active', tokenVersion: 0 });
  }
  h.db = fake.db;
  h.fetchFn.mockReset().mockImplementation(async () => new Response('{"status":"success"}\n'));
  vi.spyOn(configService, 'get').mockImplementation(async (key) => stored.get(key) ?? null);
  vi.spyOn(configService, 'getFresh').mockImplementation(async (key) => stored.get(key) ?? null);
  vi.spyOn(configService, 'getBoolean').mockImplementation(
    async (_key, fallback = false) => fallback,
  );
  vi.spyOn(configService, 'set').mockImplementation(async (key, value) => {
    stored.set(key, value);
  });
  vi.spyOn(secretsService, 'getJwtSecret').mockResolvedValue('ab'.repeat(32));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function request(path: string, user = USER, method = 'GET', body?: unknown, origin?: string) {
  const token = await signAccessToken({
    sub: user,
    role: user === ADMIN ? 'admin' : 'user',
    tv: 0,
  });
  return app.request(path, {
    method,
    headers: {
      cookie: `haive_access=${token}`,
      'content-type': 'application/json',
      ...(origin ? { origin } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
const pull = (model: string, user = USER) =>
  request('/tooling/pull-ollama-model', user, 'POST', { ollamaUrl: 'http://ollama:11434', model });
async function allowed(model: string, user = USER) {
  const res = await pull(model, user);
  expect(res.status).toBe(200);
  expect(await res.text()).toContain('event: done');
  expect(h.fetchFn).toHaveBeenCalledOnce();
  // The model sent upstream is exactly the one the policy checked.
  const [url, init] = h.fetchFn.mock.calls[0] as [string, { body: string }];
  expect(url).toMatch(/\/api\/pull$/);
  expect(JSON.parse(init.body)).toEqual({ model, stream: true });
}

describe('Ollama pull authorization before the stream and upstream request', () => {
  it('refuses an unlisted model with an actionable 403 and no upstream call', async () => {
    const res = await pull('unlisted:70b');
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      error: expect.stringMatching(/provider.*Global KB.*administrator/i),
    });
    expect(h.fetchFn).not.toHaveBeenCalled();
  });
  it('allows a model in the caller’s provider config', async () => {
    fake.insert(schema.cliProviders, { userId: USER, name: 'ollama', model: 'qwen3:8b' });
    await allowed('qwen3:8b');
  });
  it('does not borrow another user’s provider model', async () => {
    fake.insert(schema.cliProviders, { userId: OTHER, name: 'ollama', model: 'private:8b' });
    expect((await pull('private:8b')).status).toBe(403);
    expect(h.fetchFn).not.toHaveBeenCalled();
  });
  it('allows the Global KB embedding model', async () => {
    stored.set(CONFIG_KEYS.GLOBAL_KB_EMBED_MODEL, 'nomic-embed-text');
    await allowed('nomic-embed-text:latest');
  });
  it('keeps the onboarding embedding default pullable after the Global KB model changes', async () => {
    stored.set(CONFIG_KEYS.GLOBAL_KB_EMBED_MODEL, 'nomic-embed-text');
    await allowed(DEFAULT_EMBED_MODEL);
  });
  it('allows the effective Global KB default without a stored key', async () => {
    await allowed('qwen3-embedding:4b');
  });
  it.each([
    ['Qwen3', 'qwen3:latest'],
    ['qwen3:latest', 'QWEN3'],
    ['library/qwen3', 'registry.ollama.ai/library/QWEN3:latest'],
  ])('allows allowlisted %s when requested as %s', async (entry, model) => {
    stored.set(KEY, entry);
    await allowed(model);
  });
  it('does not extend a model’s permission to other tags', async () => {
    stored.set(KEY, 'qwen3:8b');
    expect((await pull('qwen3:70b')).status).toBe(403);
    expect(h.fetchFn).not.toHaveBeenCalled();
  });
  it('allows administrators any model without reading policy stores', async () => {
    vi.mocked(configService.get).mockImplementation(async (key) => {
      if (key === KEY || key === CONFIG_KEYS.GLOBAL_KB_EMBED_MODEL)
        throw new Error('policy store down');
      return null;
    });
    await allowed('anything:999b', ADMIN);
  });
});

describe('admin Ollama model allowlist', () => {
  it.each(['GET', 'PUT'])('refuses a non-admin %s', async (method) => {
    const res = await request(
      PATH,
      USER,
      method,
      method === 'PUT' ? { allowlist: 'qwen3' } : undefined,
    );
    expect(res.status).toBe(403);
    expect(configService.set).not.toHaveBeenCalled();
  });
  it('reads empty by default and saves with the sibling settings audit', async () => {
    expect(await (await request(PATH, ADMIN)).json()).toEqual({ allowlist: '' });
    const body = { allowlist: 'qwen3:8b\nnomic-embed-text' };
    expect((await request(PATH, ADMIN, 'PUT', body)).status).toBe(200);
    expect(await (await request(PATH, ADMIN)).json()).toEqual(body);
    expect(stored.get(KEY)).toBe(body.allowlist);
    expect(fake.rows(schema.auditEvents)).toEqual([
      expect.objectContaining({
        actorUserId: ADMIN,
        action: 'config.ollama_model_allowlist',
        targetType: 'system',
        metadata: { from: '', to: body.allowlist },
      }),
    ]);
  });
  it.each([
    {},
    { allowlist: 4 },
    { allowlist: '*' },
    { allowlist: '../bad' },
    { allowlist: 'bad model' },
    { allowlist: 'model:' },
    { allowlist: 'https://registry.example/ns/model' },
  ])('refuses malformed settings %j without a write', async (body) => {
    expect((await request(PATH, ADMIN, 'PUT', body)).status).toBe(400);
    expect(configService.set).not.toHaveBeenCalled();
    expect(fake.rows(schema.auditEvents)).toEqual([]);
  });
  it('refuses a foreign-origin admin PUT before a write', async () => {
    const res = await request(PATH, ADMIN, 'PUT', { allowlist: 'qwen3' }, 'http://localhost:5173');
    expect(res.status).toBe(403);
    expect(configService.set).not.toHaveBeenCalled();
  });
});
