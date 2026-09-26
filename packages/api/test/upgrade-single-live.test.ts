import { Hono } from 'hono';
import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { ONE_LIVE_UPGRADE_INDEX, schema } from '@haive/database';
import { errorHandler } from '../src/middleware/error-handler.js';
import { LIVE_TASK_STATUSES } from '../src/lib/onboarding-state.js';
import type { AppEnv } from '../src/context.js';

describe('one live upgrade per repository', () => {
  it('answers 409 for a revival the index refused, whichever route made it', async () => {
    const app = new Hono<AppEnv>();
    app.post('/revive', () => {
      throw new Error('query failed', {
        cause: { code: '23505', constraint_name: ONE_LIVE_UPGRADE_INDEX },
      });
    });
    app.onError(errorHandler);
    const res = await app.request('/revive', { method: 'POST' });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      error: expect.stringContaining('already in progress'),
    });
  });

  // The create routes' check and the index must agree on what counts as live.
  it('keys the index on exactly the statuses the api counts as live', () => {
    const index = getTableConfig(schema.tasks).indexes.find(
      (i) => i.config.name === ONE_LIVE_UPGRADE_INDEX,
    );
    const where = index?.config.where;
    expect(where).toBeDefined();
    const { sql } = new PgDialect().sqlToQuery(where!);
    const statuses = [...sql.matchAll(/'([a-z_]+)'/g)]
      .map((m) => m[1])
      .filter((s) => s !== 'onboarding_upgrade');
    expect(statuses.sort()).toEqual([...LIVE_TASK_STATUSES].sort());
  });
});
