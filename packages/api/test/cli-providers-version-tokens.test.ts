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
    c.set('userRole', 'admin');
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
import { configService, DEFAULT_AGENT_RULES } from '@haive/shared';
import { cliProviderRoutes } from '../src/routes/cli-providers.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';

const PROVIDER = '00000000-0000-4000-8000-0000000000b1';

const app = new Hono<AppEnv>();
app.route('/', cliProviderRoutes);
app.onError(errorHandler);

function setup(row?: { name: string; model: string | null; cliVersion?: string | null }) {
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
  h.add.mockReset();
  h.add.mockResolvedValue(undefined);
  vi.spyOn(configService, 'getFresh').mockResolvedValue('normal');
});

const HOSTILE = [
  '1.2.3\nRUN id',
  '$(id)',
  '`id`',
  '1.2.3;id',
  '"1.2.3"',
  "'1.2.3'",
  '-latest',
  '1 2',
  '1\0x',
  '１.2.3',
  '1.2.3\n',
  ' 1.2.3',
];
describe('CLI provider version writes', () => {
  it.each(HOSTILE)('refuses explicit create/update pin %j without writes', async (cliVersion) => {
    const fake = setup({ name: 'codex', model: null, cliVersion: '1.2.3' });
    const before = fake.rows(schema.cliProviders);
    expect((await post({ name: 'codex', authMode: 'subscription', cliVersion })).status).toBe(400);
    expect((await patch({ cliVersion })).status).toBe(400);
    expect(fake.rows(schema.cliProviders)).toEqual(before);
    expect(h.add).not.toHaveBeenCalled();
  });
  it('refuses a cached latest pin and a clone of an invalid stored pin', async () => {
    const fake = setup({ name: 'codex', model: null, cliVersion: '$(id)' });
    fake.insert(schema.cliPackageVersions, {
      name: 'codex',
      versions: ['1.2.3'],
      latestVersion: '$(id)',
    });
    expect((await post({ name: 'codex', authMode: 'subscription' })).status).toBe(400);
    expect((await patch({ cliVersion: null })).status).toBe(400);
    expect((await app.request(`/${PROVIDER}/clone`, { method: 'POST' })).status).toBe(400);
    expect(fake.rows(schema.cliProviders)).toHaveLength(1);
    expect(h.add).not.toHaveBeenCalled();
  });
  it('omits unsafe cached versions from the picker', async () => {
    const fake = setup();
    fake.insert(schema.cliPackageVersions, {
      name: 'codex',
      versions: ['1.2.3', '$(id)', '1.2.3\n'],
      latestVersion: '$(id)',
    });
    const res = await app.request('/catalog');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      providers: {
        name: string;
        versionCache: { versions: string[]; latestVersion: string | null } | null;
      }[];
    };
    expect(body.providers.find((v) => v.name === 'codex')?.versionCache).toMatchObject({
      versions: ['1.2.3'],
      latestVersion: null,
    });
  });
});
