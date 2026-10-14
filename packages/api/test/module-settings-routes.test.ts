import { describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  stored: new Map<string, string>(),
}));

vi.mock('../src/middleware/auth.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/middleware/auth.js')>()),
  requireAuth: async (c: { set: (key: string, value: string) => void }, next: () => unknown) => {
    c.set('userId', '00000000-0000-4000-8000-0000000000a1');
    c.set('userRole', 'admin');
    await next();
  },
}));
vi.mock('@haive/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@haive/shared')>()),
  configService: {
    getFresh: async (key: string) => h.stored.get(key) ?? null,
    set: async (key: string, value: string) => {
      h.stored.set(key, value);
    },
  },
}));

vi.mock('../src/db.js', () => ({ getDb: () => ({}) }));
vi.mock('../src/modules/activation.js', () => ({
  deactivatedModuleIds: async () => new Set<string>(),
  isModuleDeactivated: async () => false,
}));

import { Hono } from 'hono';
import { moduleManifestSchema } from '@haive/shared/modularity';
import { moduleRoutes } from '../src/modules/loader.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';

const manifest = moduleManifestSchema.parse({
  id: 'acme',
  name: 'Acme',
  version: '1.0.0',
  schemaVersion: 1,
  globalSettings: {
    form: {
      title: 'Settings',
      fields: [
        { id: 'apiUrl', type: 'text', label: 'API URL' },
        { id: 'limit', type: 'text', label: 'Limit' },
      ],
    },
    defaults: { apiUrl: 'https://default.example', limit: '5' },
  },
});

const app = new Hono<AppEnv>();
app.route('/modules', moduleRoutes([{ packageName: 'acme', manifest, hasRoutes: false }]));
app.onError(errorHandler);

describe('GET /modules/:id/settings/:kind', () => {
  it('falls back to the default when the stored value is not JSON', async () => {
    h.stored.set('config:module:acme:global:apiUrl', 'not json');
    h.stored.set('config:module:acme:global:limit', JSON.stringify('9'));
    const res = await app.request('/modules/acme/settings/global');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { values: Record<string, unknown> };
    expect(body.values).toEqual({ apiUrl: 'https://default.example', limit: '9' });
  });
});
