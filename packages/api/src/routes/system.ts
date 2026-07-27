import { Hono } from 'hono';
import { CONFIG_KEYS, configService } from '@haive/shared';
import { requireAuth } from '../middleware/auth.js';
import type { AppEnv } from '../context.js';

/** System-wide state every signed-in user may read.
 *
 *  Authenticated but NOT admin-gated, unlike `adminRoutes` — which is the whole point.
 *  The global-pause banner has to render for everyone, and a normal user cannot call
 *  `/admin/config/global-pause` to find out whether the switch is on. Read-only: flipping
 *  the switch stays on the admin route. */
export const systemRoutes = new Hono<AppEnv>();

systemRoutes.use('*', requireAuth);

systemRoutes.get('/pause', async (c) => {
  const globalPause = await configService.getBoolean(CONFIG_KEYS.GLOBAL_PAUSE, false);
  return c.json({ globalPause });
});
