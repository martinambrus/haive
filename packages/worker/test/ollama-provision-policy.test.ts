import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { schema, type Database } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { configService, CONFIG_KEYS, logger } from '@haive/shared';
import { ensureOllamaModels, provisionOllamaProvider } from '../src/sandbox/ollama-provision.js';

const USER = '00000000-0000-4000-8000-000000000001';
const ADMIN = '00000000-0000-4000-8000-000000000002';
let fake: ReturnType<typeof createFakeDb>;
const fetchFn = vi.fn();
const warnings: string[] = [];

beforeEach(() => {
  fake = createFakeDb({ users: schema.users, cliProviders: schema.cliProviders });
  fake.insert(schema.users, { id: USER, role: 'user' });
  fake.insert(schema.users, { id: ADMIN, role: 'admin' });
  fetchFn
    .mockReset()
    .mockImplementation(async (url: string) =>
      url.endsWith('/api/tags')
        ? Response.json({ models: [] })
        : new Response('{"status":"success"}\n'),
    );
  vi.stubGlobal('fetch', fetchFn);
  vi.spyOn(configService, 'get').mockImplementation(async (key) =>
    key === CONFIG_KEYS.OLLAMA_MODEL_ALLOWLIST ? 'allowed' : null,
  );
  warnings.length = 0;
  const key = Object.getOwnPropertySymbols(logger).find(
    (key) => key.description === 'pino.stream',
  )!;
  const stream = (logger as unknown as Record<symbol, { write: (line: string) => void }>)[key]!;
  vi.spyOn(stream, 'write').mockImplementation((line) => {
    warnings.push(line);
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function provider(id: string, userId = USER, model = 'blocked', modelfile: string | null = null) {
  const row = {
    id: randomUUID(),
    label: id,
    userId,
    name: 'ollama',
    model,
    modelfile,
    envVars: null,
    enabled: true,
  };
  fake.insert(schema.cliProviders, row);
  return row;
}
it('boot skips a disallowed non-admin provider and continues provisioning the admin provider', async () => {
  const blocked = provider('blocked-user');
  provider('admin', ADMIN);
  await ensureOllamaModels(fake.db as unknown as Database);
  const pulls = fetchFn.mock.calls.filter(([url]) => url.endsWith('/api/pull'));
  expect(pulls).toHaveLength(1);
  expect(JSON.parse(pulls[0]![1].body).model).toBe('blocked');
  expect(warnings.join('\n')).toContain(blocked.id);
  expect(warnings.join('\n')).toContain('blocked');
  expect(
    fake.rows(schema.cliProviders).find((row) => row.id === blocked.id)!.modelProvisionStatus,
  ).toBe('failed');
});
it('checks a queued provider owner’s current role, including demotion', async () => {
  const row = provider('demoted', ADMIN);
  await fake.db.update(schema.users).set({ role: 'user' }).where(eq(schema.users.id, ADMIN));
  expect((await provisionOllamaProvider(fake.db as unknown as Database, row)).ok).toBe(false);
  expect(fetchFn).not.toHaveBeenCalled();
});
it('does not trust a missing owner', async () => {
  const row = provider('orphan', '00000000-0000-4000-8000-000000000099');
  expect((await provisionOllamaProvider(fake.db as unknown as Database, row)).ok).toBe(false);
  expect(fetchFn).not.toHaveBeenCalled();
});
it('checks the parsed FROM base before any daemon request', async () => {
  const row = provider('custom', USER, 'allowed', 'FROM blocked');
  expect((await provisionOllamaProvider(fake.db as unknown as Database, row)).ok).toBe(false);
  expect(fetchFn).not.toHaveBeenCalled();
});
it('continues to build an allowed model with an allowed FROM base', async () => {
  const row = provider('allowed', USER, 'allowed', 'FROM ALLOWED:latest');
  expect((await provisionOllamaProvider(fake.db as unknown as Database, row)).ok).toBe(true);
  expect(fetchFn.mock.calls.some(([url]) => url.endsWith('/api/create'))).toBe(true);
});
it('skips external and cloud providers without reading owner or policy', async () => {
  const external = {
    ...provider('external'),
    envVars: { ANTHROPIC_BASE_URL: 'https://external.example' },
  };
  const cloud = provider('cloud', USER, 'model:cloud');
  vi.spyOn(configService, 'get').mockRejectedValue(new Error('must not read'));
  expect((await provisionOllamaProvider(fake.db as unknown as Database, external)).ok).toBe(true);
  expect((await provisionOllamaProvider(fake.db as unknown as Database, cloud)).ok).toBe(true);
  expect(fetchFn).not.toHaveBeenCalled();
});

it('keeps administrators independent of the policy store', async () => {
  vi.mocked(configService.get).mockRejectedValue(new Error('policy store down'));
  const row = provider('admin', ADMIN, 'anything', 'FROM arbitrary-base');
  expect((await provisionOllamaProvider(fake.db as unknown as Database, row)).ok).toBe(true);
  expect(configService.get).not.toHaveBeenCalled();
});
