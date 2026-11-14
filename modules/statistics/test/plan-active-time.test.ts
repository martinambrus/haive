import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { schema, type Database } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { HttpError, type AppEnv } from '@haive/shared/module-host';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import createStatsRoutes from '../src/routes.js';

vi.mock('@haive/shared', async (original) => ({
  ...(await original<typeof import('@haive/shared')>()),
  configService: { get: async () => null },
}));

const USER = '00000000-0000-4000-8000-000000000001';
const OTHER = '00000000-0000-4000-8000-000000000002';
const REPO = '00000000-0000-4000-8000-000000000003';
const REPO2 = '00000000-0000-4000-8000-000000000004';
const PROVIDER = '00000000-0000-4000-8000-000000000005';

function fixture() {
  const fake = createFakeDb({ planActiveTime: schema.planActiveTime });
  const add = (userId: string, repositoryId: string, hour: number, activeMs: number) =>
    fake.insert(schema.planActiveTime, {
      userId,
      repositoryId,
      hourStart: new Date(Date.UTC(2026, 10, 10, hour)),
      activeMs,
    });
  add(USER, REPO, 9, 900);
  add(USER, REPO, 10, 1000);
  add(USER, REPO, 11, 1100);
  add(USER, REPO, 12, 1200);
  add(USER, REPO2, 10, 2000);
  add(OTHER, REPO, 10, 4000);
  const planQueries: SQL[] = [];
  // Other summary populations are empty. Evaluate the actual plan predicate with the
  // shared strict fake, and pin the SQL aggregate rather than ignoring its expression.
  const db = {
    select: (fields: Record<string, unknown>) => ({
      from: (table: unknown) => {
        let result: unknown[] = [];
        const chain: unknown = new Proxy(
          {},
          {
            get: (_target, prop) =>
              prop === 'then'
                ? (ok: (rows: unknown[]) => unknown, bad: (err: unknown) => unknown) =>
                    Promise.resolve(result).then(ok, bad)
                : (where: SQL) => {
                    if (table === schema.planActiveTime && prop === 'where') {
                      planQueries.push(where);
                      const aggregate = new PgDialect().sqlToQuery(fields.activeMs as SQL);
                      expect(aggregate.sql).toBe('sum("plan_active_time"."active_ms")');
                      const rows = fake
                        .rows(schema.planActiveTime)
                        .filter(fake.compileWhere(schema.planActiveTime, where));
                      result = [
                        {
                          activeMs: rows.length
                            ? String(rows.reduce((n, r) => n + Number(r.activeMs), 0))
                            : null,
                        },
                      ];
                    }
                    return chain;
                  },
          },
        );
        return chain;
      },
    }),
  } as unknown as Database;
  const request = async (params = '', role: 'user' | 'admin' = 'user') => {
    const app = new Hono<AppEnv>();
    app.use('*', async (c, next) => {
      c.set('userId', USER);
      c.set('userRole', role);
      await next();
    });
    app.onError(
      (err) =>
        new Response(JSON.stringify({ error: err.message }), {
          status: err instanceof HttpError ? err.status : 500,
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    app.route('/m/statistics', createStatsRoutes({ db }));
    const query = new URLSearchParams('from=2026-11-10T10:00:00Z&to=2026-11-10T12:00:00Z');
    new URLSearchParams(params).forEach((v, k) => query.set(k, v));
    return app.request('/m/statistics/summary?' + query);
  };
  const summary = async (params = '', role: 'user' | 'admin' = 'user') => {
    const response = await request(params, role);
    expect(response.status).toBe(200);
    return response.json() as Promise<{
      time: { planActiveMs: number | null; userActiveMs: number; effortMs: number };
      scope: { planActiveTime: { cliProviderId: null; windowAttribution: string } };
    }>;
  };
  return { add, summary, request, planQueries };
}

describe('plan-page activity in the statistics summary', () => {
  it('sums only caller rows without requiring a task or adding to task effort', async () => {
    const { time } = await fixture().summary();
    expect(time.planActiveMs).toBe(4100);
    expect(time.userActiveMs).toBe(0);
    expect(time.effortMs).toBe(0);
  });

  it('includes every user only for an admin requesting allUsers', async () => {
    const f = fixture();
    expect((await f.summary('', 'admin')).time.planActiveMs).toBe(4100);
    expect((await f.summary('allUsers=true', 'admin')).time.planActiveMs).toBe(8100);
    expect((await f.request('allUsers=true')).status).toBe(403);
  });

  it('honours repository scope for own rows and all users', async () => {
    const f = fixture();
    expect((await f.summary('repositoryId=' + REPO)).time.planActiveMs).toBe(2100);
    expect(
      (await f.summary('repositoryId=' + REPO + '&allUsers=1', 'admin')).time.planActiveMs,
    ).toBe(6100);
  });

  it('keeps plan time independent of providers and discloses its scope', async () => {
    const body = await fixture().summary('cliProviderId=' + PROVIDER);
    expect(body.time.planActiveMs).toBe(4100);
    expect(body.scope.planActiveTime).toEqual({
      cliProviderId: null,
      windowAttribution: 'utc-hour-start',
    });
  });

  it.each(['', 'taskClass=plan'])('counts All classes and Plan (%s)', async (params) => {
    expect((await fixture().summary(params)).time.planActiveMs).toBe(4100);
  });

  it.each(['work', 'setup', 'run', 'other'])('excludes the %s class', async (taskClass) => {
    const f = fixture();
    expect((await f.summary('taskClass=' + taskClass)).time.planActiveMs).toBeNull();
    expect(f.planQueries).toHaveLength(0);
  });

  it('attributes a straddling hour wholly by hour start, with half-open UTC edges', async () => {
    const f = fixture();
    const body = await f.summary(
      'from=2026-11-10T10:30:00Z&to=2026-11-10T11:30:00Z&tz=Pacific%2FAuckland',
    );
    expect(body.time.planActiveMs).toBe(1100);
    expect(
      (await f.summary('from=2026-11-10T11:00:00Z&to=2026-11-10T12:00:00Z')).time.planActiveMs,
    ).toBe(1100);
  });

  it('returns null for an unmeasured window and zero for a measured zero row', async () => {
    const f = fixture();
    expect((await f.summary('from=2026-11-09&to=2026-11-10')).time.planActiveMs).toBeNull();
    expect(
      (await f.summary('from=2026-11-10T10:00:00Z&to=2026-11-10T10:00:00Z')).time.planActiveMs,
    ).toBeNull();
    f.add(USER, REPO, 13, 0);
    expect(
      (await f.summary('from=2026-11-10T13:00:00Z&to=2026-11-10T14:00:00Z')).time.planActiveMs,
    ).toBe(0);
  });
});
