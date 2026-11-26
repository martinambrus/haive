import { describe, expect, it, vi } from 'vitest';
import type { Database } from '@haive/database';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { Hono } from 'hono';
import type { AppEnv } from '../src/context.js';

const h = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/queues.js', () => ({ getTaskQueue: () => ({ add: vi.fn() }) }));

import { stepRoutes } from '../src/routes/tasks/steps.js';
import { errorHandler } from '../src/middleware/error-handler.js';

const app = new Hono<AppEnv>();
app.use('*', async (c, next) => {
  c.set('userId', 'owner');
  await next();
});
app.route('/', stepRoutes);
app.onError(errorHandler);

// Fake the database response at the SELECT seam; execute the real route, including
// column projection, ranking and JSON serialization. SQL is checked below so a
// regression to mining-only titles cannot pass on a pre-projected fake response.
function setup(agentTitle: string | null, completed: boolean) {
  const projections: Record<string, unknown>[] = [];
  const at = new Date('2026-11-26T12:00:00Z');
  const row = { id: 'run', createdAt: at, endedAt: completed ? at : null, agentTitle };
  h.db = {
    query: {
      tasks: { findFirst: async () => ({ id: 'task' }) },
      taskSteps: { findFirst: async () => ({ id: 'step' }) },
    },
    select: (columns: Record<string, unknown>) => {
      projections.push(columns);
      let condition = '';
      const read = async () => {
        if (!('agentTitle' in columns)) return [{ id: row.id, endedAt: row.endedAt }];
        const wantsCompleted = condition.includes('"ended_at" is not null');
        return wantsCompleted === completed ? [row] : [];
      };
      const query = {
        from: () => query,
        leftJoin: () => query,
        where: (where: SQL) => {
          condition = new PgDialect().sqlToQuery(where).sql;
          return query;
        },
        orderBy: () => query,
        limit: () => query,
        then: (ok: (rows: unknown[]) => unknown, fail: (err: unknown) => unknown) =>
          read().then(ok, fail),
      };
      return query;
    },
  } as unknown as Database;
  return projections;
}

describe('step invocation API run titles', () => {
  it.each([false, true])('returns the stored title (completed: %s)', async (completed) => {
    const projections = setup('Review, part 3 of 12', completed);
    const response = await app.request('/task/steps/step/cli-invocations');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      invocations: [
        { id: 'run', agentTitle: 'Review, part 3 of 12', runNumber: 1, isActive: !completed },
      ],
      totalCount: 1,
    });
    for (const columns of projections.filter((p) => 'agentTitle' in p)) {
      expect(new PgDialect().sqlToQuery(columns.agentTitle as SQL).sql).toBe(
        'coalesce("cli_invocations"."agent_title", "task_step_agent_minings"."agent_title")',
      );
    }
  });

  it('returns null for an untitled ordinary invocation', async () => {
    setup(null, false);
    const response = await app.request('/task/steps/step/cli-invocations');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ invocations: [{ agentTitle: null }] });
  });
});
