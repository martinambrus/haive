import { afterEach, describe, expect, it, vi } from 'vitest';

const ADMIN = '00000000-0000-4000-8000-0000000000a1';
const h = vi.hoisted(() => ({ db: undefined as unknown }));

vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/middleware/auth.js', () => ({
  requireAuth: async (c: { set: (key: string, value: string) => void }, next: () => unknown) => {
    c.set('userId', ADMIN);
    await next();
  },
  requireAdmin: async (_c: unknown, next: () => unknown) => next(),
}));

import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { CONFIG_KEYS, configService, NEW_WORK_FENCE_KEY } from '@haive/shared';
import { maintenanceRoutes } from '../src/routes/maintenance.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';

const app = new Hono<AppEnv>();
app.onError(errorHandler);
app.route('/admin/maintenance', maintenanceRoutes);

const FENCE = sql`select pg_advisory_xact_lock(hashtextextended(${NEW_WORK_FENCE_KEY}, 0))`;
const asks = `asks ${NEW_WORK_FENCE_KEY}`;

const put = (state: string) =>
  app.request('/admin/maintenance', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ state }),
  });

/** `events` lists who asks for the exclusive fence, reads the stored state and writes, in order. */
function setup(
  whileWriting: (fake: ReturnType<typeof createFakeDb>) => Promise<void> = async () => {},
  stored = 'normal',
) {
  const fake = createFakeDb({ auditEvents: schema.auditEvents });
  const events: string[] = [];
  fake.hooks.beforeLock = (key) => {
    events.push(`asks ${key}`);
  };
  vi.spyOn(configService, 'get').mockResolvedValue('normal');
  vi.spyOn(configService, 'getFresh').mockImplementation(async (key) => {
    expect(key).toBe(CONFIG_KEYS.MAINTENANCE_STATE);
    events.push('reads');
    return stored;
  });
  const set = vi.spyOn(configService, 'set').mockImplementation(async (key, value) => {
    expect(key).toBe(CONFIG_KEYS.MAINTENANCE_STATE);
    events.push(`writes ${value}`);
    await whileWriting(fake);
    events.push('wrote');
  });
  h.db = fake.db;
  return { fake, events, set };
}

afterEach(() => vi.restoreAllMocks());

describe('PUT /admin/maintenance', () => {
  it('writes the state and records who changed it', async () => {
    const t = setup();

    const res = await put('draining');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ state: 'draining', previous: 'normal' });
    expect(t.fake.rows(schema.auditEvents)).toMatchObject([
      {
        actorUserId: ADMIN,
        action: 'maintenance.set_state',
        metadata: { from: 'normal', to: 'draining' },
      },
    ]);
  });

  it('asks for the exclusive fence before it reads the state it replaces and writes the new one', async () => {
    const t = setup();

    expect((await put('draining')).status).toBe(200);

    expect(t.events).toEqual([asks, 'reads', 'writes draining', 'wrote']);
  });

  it('records the stored state it replaces, not a cached copy another process has outdated', async () => {
    const t = setup(undefined, 'draining');

    const res = await put('maintenance');

    expect(await res.json()).toEqual({ state: 'maintenance', previous: 'draining' });
    expect(t.fake.rows(schema.auditEvents)).toMatchObject([
      { metadata: { from: 'draining', to: 'maintenance' } },
    ]);
  });

  it('keeps every other taker of the fence waiting until the state is written', async () => {
    let rival: Promise<void> | undefined;
    const t = setup(async (fake) => {
      rival = fake.db.transaction(async (tx) => {
        await tx.execute(FENCE);
        t.events.push('rival holds');
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    expect((await put('draining')).status).toBe(200);
    await rival;

    expect(t.events).toEqual([asks, 'reads', 'writes draining', asks, 'wrote', 'rival holds']);
  });

  it('answers an error, records nothing and lets go of the fence when the write fails', async () => {
    const t = setup();
    t.set.mockRejectedValueOnce(new Error('redis went away'));

    expect((await put('maintenance')).status).toBe(500);

    expect(t.events).toEqual([asks, 'reads']);
    expect(t.fake.rows(schema.auditEvents)).toEqual([]);
    const next = await Promise.race([
      t.fake.db.transaction((tx) => tx.execute(FENCE)).then(() => 'taken'),
      new Promise((resolve) => setTimeout(() => resolve('still held'), 500)),
    ]);
    expect(next).toBe('taken');
  });

  it('refuses a state it does not know before it asks for anything', async () => {
    const t = setup();

    expect((await put('paused')).status).toBe(400);

    expect(t.events).toEqual([]);
    expect(t.set).not.toHaveBeenCalled();
  });
});
