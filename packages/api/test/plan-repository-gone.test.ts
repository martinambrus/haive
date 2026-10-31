import { beforeEach, describe, expect, it, vi } from 'vitest';

const USER = vi.hoisted(() => '00000000-0000-4000-8000-0000000000a1');
const h = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/queues.js', () => ({ getTaskQueue: vi.fn() }));
vi.mock('../src/lib/plan-mirror.js', () => ({
  enqueuePlanMirrorRefresh: vi.fn(),
  pullPlanMirror: vi.fn(),
  savePlanMirror: vi.fn(),
}));
vi.mock('../src/lib/spawn-plan-task.js', () => ({ spawnPlanTask: vi.fn() }));
vi.mock('../src/middleware/auth.js', () => ({
  requireAuth: async (c: { set: (key: string, value: string) => void }, next: () => unknown) => {
    c.set('userId', USER);
    await next();
  },
  requireAdmin: async (_c: unknown, next: () => unknown) => next(),
}));

import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { configService } from '@haive/shared';
import { planRoutes } from '../src/routes/plan.js';
import { enqueuePlanMirrorRefresh } from '../src/lib/plan-mirror.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';

const REPO = '00000000-0000-4000-8000-0000000000c1';
const FROM = '00000000-0000-4000-8000-0000000000d1';
const TO = '00000000-0000-4000-8000-0000000000d2';
const app = new Hono<AppEnv>();
app.route('/', planRoutes);
app.onError(errorHandler);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('a plan write for a repository that was deleted meanwhile', () => {
  it('is a 404, not a 400 or a 500', async () => {
    const fake = createFakeDb({
      repositories: schema.repositories,
      planNodes: schema.planNodes,
      planNodeEdges: schema.planNodeEdges,
      planMirrorState: schema.planMirrorState,
    });
    fake.insert(schema.repositories, { id: REPO, userId: USER, name: 'repo' });
    h.db = fake.db;
    // The route proves the caller owns the repository, then reads the plan switch, then patches:
    // the delete lands between the first two, so the patch is the first thing to find it gone.
    vi.spyOn(configService, 'get').mockImplementation(async () => {
      await fake.db.delete(schema.repositories).where(eq(schema.repositories.id, REPO));
      return 'true';
    });

    const response = await app.request(`/${REPO}/plan/edges`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fromNodeId: FROM, toNodeId: TO, kind: 'depends_on' }),
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: 'plan_repository_gone' });
    expect(enqueuePlanMirrorRefresh).not.toHaveBeenCalled();
  });
});
