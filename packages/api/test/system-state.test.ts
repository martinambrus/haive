import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/middleware/auth.js', () => ({
  requireAuth: async (c: { set: (key: string, value: string) => void }, next: () => unknown) => {
    c.set('userId', '00000000-0000-4000-8000-0000000000a1');
    await next();
  },
}));

import { Hono } from 'hono';
import { CONFIG_KEYS, configService } from '@haive/shared';
import { systemRoutes } from '../src/routes/system.js';
import type { AppEnv } from '../src/context.js';

const app = new Hono<AppEnv>();
app.route('/system', systemRoutes);

afterEach(() => vi.restoreAllMocks());

describe('GET /system/state', () => {
  it('answers the stored maintenance state, read past the config cache', async () => {
    vi.spyOn(configService, 'get').mockImplementation(async (key) =>
      key === CONFIG_KEYS.MAINTENANCE_STATE ? 'normal' : null,
    );
    vi.spyOn(configService, 'getFresh').mockImplementation(async (key) =>
      key === CONFIG_KEYS.MAINTENANCE_STATE ? 'draining' : null,
    );

    const res = await app.request('/system/state');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ globalPause: false, maintenance: 'draining' });
  });
});
