import { afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/middleware/auth.js', () => ({
  requireAuth: async (c: { set: (key: string, value: string) => void }, next: () => unknown) => {
    c.set('userId', 'admin');
    await next();
  },
  requireAdmin: async (_c: unknown, next: () => unknown) => next(),
}));

import { Hono } from 'hono';
import { drizzle } from 'drizzle-orm/pg-proxy';
import { configService } from '@haive/shared';
import { maintenanceRoutes } from '../src/routes/maintenance.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';

const app = new Hono<AppEnv>();
app.onError(errorHandler);
app.route('/admin/maintenance', maintenanceRoutes);
afterEach(() => vi.restoreAllMocks());

describe('maintenance Stop state', () => {
  it('reads the current step status with a left join fenced on task, step ID and round for both lists', async () => {
    const queries: string[] = [];
    h.db = drizzle(async (query) => {
      queries.push(query);
      return { rows: [] };
    });
    vi.spyOn(configService, 'getFresh').mockResolvedValue('maintenance');
    vi.spyOn(configService, 'getEncryptionKey').mockResolvedValue('11'.repeat(32));
    const res = await app.request('/admin/maintenance/blocking');
    expect(res.status).toBe(200);
    const lists = queries.filter((q) => q.includes('left join "task_steps"'));
    expect(lists).toHaveLength(2);
    for (const query of lists) {
      expect(query).toContain('"task_steps"."status"');
      expect(query).toContain('"task_steps"."task_id" = "tasks"."id"');
      expect(query).toContain('"task_steps"."step_id" = "tasks"."current_step_id"');
      expect(query).toContain('"task_steps"."round" = "tasks"."current_round"');
    }
    expect(await res.json()).toMatchObject({ tasks: [], parked: [] });
  });
});
