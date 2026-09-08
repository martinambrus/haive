import { Hono } from 'hono';
import { CONFIG_KEYS, configService, parseMaintenanceState } from '@haive/shared';
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

/** System state every signed-in user may read, for the same reason `/pause` is readable: the
 *  banner has to render for everyone and a normal user cannot call the admin route to find out.
 *
 *  Reports both holds, because they are different things a user needs to distinguish — the
 *  orchestrator being paused (jobs held, app fully usable) and the system draining for maintenance
 *  (new tasks refused, existing work finishing). `maintenance` itself is not observable here: the
 *  gate refuses non-admins before this handler runs, and the 503 body is what tells the web app to
 *  render the maintenance page. */
systemRoutes.get('/state', async (c) => {
  const [globalPause, rawMaintenance] = await Promise.all([
    configService.getBoolean(CONFIG_KEYS.GLOBAL_PAUSE, false),
    configService.get(CONFIG_KEYS.MAINTENANCE_STATE),
  ]);
  return c.json({ globalPause, maintenance: parseMaintenanceState(rawMaintenance) });
});
