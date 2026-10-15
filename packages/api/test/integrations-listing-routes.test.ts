import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ db: undefined as unknown }));

vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/lib/integration-provider.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/integration-provider.js')>()),
  connectableMethods: async () => [],
}));

import { Hono } from 'hono';
import type { PgTable } from 'drizzle-orm/pg-core';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { secretsService } from '@haive/shared';
import { listIntegrationProviders } from '@haive/shared/integrations';
import { ACCESS_COOKIE } from '../src/auth/cookies.js';
import { signAccessToken } from '../src/auth/jwt.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import { integrationsRoutes } from '../src/routes/integrations.js';
import type { AppEnv } from '../src/context.js';

type Caller = { id: string; role: 'admin' | 'user' };

const USER: Caller = { id: '00000000-0000-4000-8000-0000000000a1', role: 'user' };
const OTHER: Caller = { id: '00000000-0000-4000-8000-0000000000a2', role: 'user' };
const ADMIN: Caller = { id: '00000000-0000-4000-8000-0000000000a3', role: 'admin' };

const app = new Hono<AppEnv>();
app.route('/integrations', integrationsRoutes);
app.onError(errorHandler);

function setup() {
  const fake = createFakeDb({
    users: schema.users,
    integrationUserSettings: schema.integrationUserSettings,
    integrationProviderConfigs: schema.integrationProviderConfigs,
    integrationCategoryPreferences: schema.integrationCategoryPreferences,
  });
  for (const { id, role } of [USER, OTHER, ADMIN]) {
    fake.insert(schema.users, { id, role, status: 'active', tokenVersion: 0 });
  }
  const reads: PgTable[] = [];
  const select = fake.db.select.bind(fake.db);
  fake.db.select = (fields) => {
    const query = select(fields);
    return { from: (table) => (reads.push(table), query.from(table)) };
  };
  h.db = fake.db;
  return { fake, reads };
}

async function get(path: string, caller?: Caller) {
  const token = caller && (await signAccessToken({ sub: caller.id, role: caller.role, tv: 0 }));
  const res = await app.request(path, {
    headers: token ? { cookie: `${ACCESS_COOKIE}=${token}` } : {},
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}

describe('integration listing routes', () => {
  beforeEach(() => {
    vi.spyOn(secretsService, 'getJwtSecret').mockResolvedValue('cd'.repeat(32));
  });
  afterEach(() => vi.restoreAllMocks());

  describe('GET /integrations/defaults', () => {
    it('lists the admin default rows to a plain signed-in user, and none of anyone own preferences', async () => {
      const { fake } = setup();
      const prefs = schema.integrationCategoryPreferences;
      fake.insert(prefs, { userId: null, categoryId: 'forge', providerId: 'gitea' });
      fake.insert(prefs, { userId: USER.id, categoryId: 'forge', providerId: 'github' });
      fake.insert(prefs, { userId: OTHER.id, categoryId: 'mail', providerId: 'gitlab' });
      const before = fake.rows(prefs);

      const reply = await get('/integrations/defaults', USER);

      expect(reply.status).toBe(200);
      expect(reply.body).toEqual({ defaults: [{ categoryId: 'forge', providerId: 'gitea' }] });
      expect(fake.rows(prefs)).toEqual(before);
    });

    it('lists nothing while no default is set', async () => {
      const { fake } = setup();
      fake.insert(schema.integrationCategoryPreferences, {
        userId: USER.id,
        categoryId: 'forge',
        providerId: 'github',
      });

      const reply = await get('/integrations/defaults', USER);

      expect(reply.status).toBe(200);
      expect(reply.body).toEqual({ defaults: [] });
    });

    it('answers 401 to a caller with no session, where a signed-in one is served', async () => {
      setup();

      expect((await get('/integrations/defaults', USER)).status).toBe(200);
      expect((await get('/integrations/defaults')).status).toBe(401);
    });
  });

  describe('GET /integrations/providers', () => {
    it('reads every provider switch with one query and reports each provider its own', async () => {
      const { fake, reads } = setup();
      fake.insert(schema.integrationProviderConfigs, { providerId: 'github', enabled: false });
      fake.insert(schema.integrationProviderConfigs, { providerId: 'gitea', enabled: true });

      const reply = await get('/integrations/providers', USER);

      expect(reply.status).toBe(200);
      expect(Object.fromEntries(reply.body.providers.map((p: any) => [p.id, p.enabled]))).toEqual(
        Object.fromEntries(listIntegrationProviders().map((p) => [p.id, p.id !== 'github'])),
      );
      expect(reads.filter((table) => table === schema.integrationProviderConfigs)).toHaveLength(1);
    });
  });
});
