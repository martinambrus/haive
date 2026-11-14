import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { Database } from '@haive/database';
import { HttpError, type AppEnv } from '@haive/shared/module-host';
import createStatsRoutes from '../src/routes.js';
import type { timeCostOver } from '../src/time-cost.js';
import { timeCostOver as loadReport, TIME_COST_BATCH_SIZE } from '../src/time-cost.js';
import { sql } from 'drizzle-orm';
import { FORM_WAIT_EVENT_TYPES } from '@haive/shared/stats';

vi.mock('@haive/shared', async (original) => ({
  ...(await original<typeof import('@haive/shared')>()),
  configService: { get: async () => null },
}));
const TASK = '00000000-0000-4000-8000-000000000001';
const USER = '00000000-0000-4000-8000-000000000002';
const query = '?from=2026-11-01T00:00:00Z&to=2026-11-12T00:00:00Z';

function fixture(role = 'user') {
  const predicates: string[] = [];
  const tables: unknown[] = [];
  const parameters: unknown[][] = [];
  const db = {
    select: (fields: Record<string, unknown>) => {
      const keys = Object.keys(fields);
      const rows = keys.includes('estimatedTimeHours')
        ? [{ id: TASK, completedAt: new Date('2026-11-10Z') }]
        : keys.includes('carriedWorkMs')
          ? [
              {
                id: 's',
                taskId: TASK,
                stepId: '08-phase-5-verify',
                startedAt: new Date(0),
                endedAt: new Date(1000),
                idleMs: 100,
                userActiveMs: 50,
                carriedWorkMs: 25,
                carriedUserActiveMs: 10,
                status: 'done',
                waitingStartedAt: null,
                output: { test: { ran: false } },
              },
            ]
          : keys.includes('pricedInvocations')
            ? [
                {
                  taskId: TASK,
                  stepId: '08-phase-5-verify',
                  agentMs: 500,
                  realUsd: 0,
                  notionalUsd: 2,
                  invocations: 1,
                  pricedInvocations: 1,
                  unpricedInvocations: 0,
                  unsnapshottedInvocations: 1,
                },
              ]
            : keys.includes('title')
              ? [{ taskId: TASK, title: 'Example', repository: 'Repo' }]
              : [];
      const chain: unknown = new Proxy(
        {},
        {
          get: (_, prop) =>
            prop === 'then'
              ? (resolve: (rows: unknown[]) => void) => resolve(rows)
              : (...args: unknown[]) => {
                  if (prop === 'from') tables.push(args[0]);
                  if (prop === 'where' && args[0]) {
                    const query = new PgDialect().sqlToQuery(args[0] as never);
                    predicates.push(query.sql);
                    parameters.push(query.params);
                  }
                  return chain;
                },
        },
      );
      return chain;
    },
  } as unknown as Database;
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('userId', USER);
    c.set('userRole', role as 'user');
    await next();
  });
  app.onError((err, c) =>
    err instanceof HttpError
      ? c.json({ error: err.message }, err.status as ContentfulStatusCode)
      : c.json({ error: String(err) }, 500),
  );
  app.route('/', createStatsRoutes({ db } as never));
  return { app, predicates, parameters, tables, db };
}

describe('completed-task report endpoint', () => {
  it('bounds every task-id query, including the full-history event reads', async () => {
    expect(TIME_COST_BATCH_SIZE).toBe(200);
    const f = fixture();
    await loadReport(
      f.db,
      [1, 2, 3].map((n) => ({
        id: `00000000-0000-4000-8000-00000000000${n}`,
        completedAt: new Date('2026-11-10Z'),
      })),
      sql`true`,
      2,
    );
    const eventPredicates = f.predicates.filter((p) => p.includes('"task_events"'));
    expect(eventPredicates).toHaveLength(2);
    expect(FORM_WAIT_EVENT_TYPES).toHaveLength(20);
    const eventParams = f.parameters[f.predicates.indexOf(eventPredicates[0]!)];
    expect(eventParams?.slice(0, 2)).toEqual([
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000002',
    ]);
    expect(eventParams?.slice(2)).toEqual(FORM_WAIT_EVENT_TYPES);
    expect(eventPredicates[0]?.match(/\$/g)).toHaveLength(2 + 20);
    expect(eventPredicates[1]?.match(/\$/g)).toHaveLength(1 + 20);
    expect(eventPredicates.join('\n')).not.toContain('"created_at"');
    expect(eventPredicates.every((p) => p.includes('"event_type" in ('))).toBe(true);
  });
  it('uses completed-task timing, full-history costs, provider disclosure and window FX', async () => {
    const f = fixture();
    const res = await f.app.request('/time-cost' + query + '&cliProviderId=' + USER);
    expect(res.status).toBe(200);
    const report = (await res.json()) as Awaited<ReturnType<typeof timeCostOver>> & {
      scope: { providerIgnored: boolean };
      costDisplay: { currency: string };
    };
    expect(report.taskCount).toBe(1);
    expect(report.rows[0]).toMatchObject({
      title: 'Example',
      repository: 'Repo',
      workMs: 925,
      userActiveMs: 60,
      testExecution: 'not_run',
      lowerBound: false,
      notionalUsd: 2,
    });
    expect(report.scope.providerIgnored).toBe(true);
    expect(report.costDisplay.currency).toBe('USD');
    expect(f.predicates[0]).toContain('"tasks"."completed_at"');
    expect(f.predicates.join('\n')).toContain('"tasks"."user_id"');
    expect(f.predicates.slice(1).join('\n')).not.toContain('"started_at" >=');
    expect(f.predicates.join('\n')).not.toContain('"cli_provider_id" =');
  });
  it('keeps the caller predicate ANDed with a non-admin repository facet', async () => {
    const f = fixture();
    const repositoryId = '00000000-0000-4000-8000-000000000003';
    const res = await f.app.request('/time-cost' + query + '&repositoryId=' + repositoryId);
    expect(res.status).toBe(200);
    expect(f.predicates[0]).toContain('"tasks"."user_id" = $1 and "tasks"."repository_id" = $2');
    expect(f.parameters[0]?.slice(0, 2)).toEqual([USER, repositoryId]);
  });
  it('rechecks install-wide access before any query', async () => {
    const f = fixture();
    expect((await f.app.request('/time-cost' + query + '&allUsers=true')).status).toBe(403);
    expect(f.tables).toHaveLength(0);
  });
  it('accepts an administrator and rejects an invalid range through the shared parser', async () => {
    const f = fixture('admin');
    expect((await f.app.request('/time-cost' + query + '&allUsers=true')).status).toBe(200);
    expect(f.predicates[0]).not.toContain('"user_id"');
    expect((await f.app.request('/time-cost?from=invalid')).status).toBe(400);
  });
});
