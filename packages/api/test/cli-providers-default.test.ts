import { expect, it, vi } from 'vitest';

const USER = vi.hoisted(() => '00000000-0000-4000-8000-0000000000a1');
const h = vi.hoisted(() => ({
  db: undefined as unknown,
  getJob: vi.fn(async (_id: string): Promise<unknown> => undefined),
}));

vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/middleware/auth.js', () => ({
  requireAuth: async (c: { set: (key: string, value: string) => void }, next: () => unknown) => {
    c.set('userId', USER);
    await next();
  },
}));
vi.mock('../src/queues.js', () => ({
  getCliExecQueue: () => ({ getJob: h.getJob }),
}));

import { Hono } from 'hono';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { cliProviderRoutes } from '../src/routes/cli-providers.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';

const app = new Hono<AppEnv>();
app.route('/', cliProviderRoutes);
app.onError(errorHandler);

it.each([
  [
    'newest created last',
    [
      ['old', true, '2026-10-01'],
      ['new', true, '2026-10-20'],
    ],
    'old',
  ],
  [
    'creation tie',
    [
      ['z', true, '2026-10-01'],
      ['a', true, '2026-10-01'],
    ],
    'a',
  ],
  [
    'disabled oldest',
    [
      ['disabled', false, '2026-09-01'],
      ['new', true, '2026-10-20'],
      ['old', true, '2026-10-01'],
    ],
    'old',
  ],
  ['none enabled', [['disabled', false, '2026-09-01']], null],
] as const)('returns the shared default: %s', async (_name, rows, expected) => {
  const ids: Record<string, string> = {
    old: '00000000-0000-4000-8000-000000000001',
    new: '00000000-0000-4000-8000-000000000002',
    a: '00000000-0000-4000-8000-000000000003',
    z: '00000000-0000-4000-8000-000000000004',
    disabled: '00000000-0000-4000-8000-000000000005',
  };
  const fake = createFakeDb({ cliProviders: schema.cliProviders });
  for (const [id, enabled, createdAt] of rows)
    fake.insert(schema.cliProviders, {
      id: ids[id],
      userId: USER,
      name: 'codex',
      rulesContent: '',
      label: id,
      enabled,
      createdAt: new Date(createdAt),
    });
  fake.insert(schema.cliProviders, {
    id: '00000000-0000-4000-8000-0000000000f1',
    userId: '00000000-0000-4000-8000-0000000000f2',
    name: 'codex',
    rulesContent: '',
    enabled: true,
    createdAt: new Date('2020-01-01'),
  });
  h.db = fake.db;
  const res = await app.request('/');
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    defaultProviderId: string | null;
    providers: { id: string }[];
  };
  expect(body.defaultProviderId).toBe(expected ? ids[expected] : null);
  if (_name === 'creation tie') expect(body.providers.map((p) => p.id)).toEqual([ids.a, ids.z]);
  expect(body.providers.map((p) => p.id)).not.toContain('00000000-0000-4000-8000-0000000000f1');
});
