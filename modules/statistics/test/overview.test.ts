import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ defaultWindow: null as string | null }));

vi.mock('@haive/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@haive/shared')>()),
  configService: {
    get: async () => null,
    getFresh: async () => (h.defaultWindow === null ? null : JSON.stringify(h.defaultWindow)),
  },
}));

import { Hono } from 'hono';
import type { Database } from '@haive/database';
import { moduleManifestSchema, widgetResponseSchema } from '@haive/shared/modularity';
import type { AppEnv } from '@haive/shared/module-host';
import manifest from '../src/manifest.js';
import createStatsRoutes from '../src/routes.js';

const DAY_MS = 86_400_000;

function fakeDb(): Database {
  const day = (n: number) => new Date(Date.now() - n * DAY_MS);
  const rowsFor = (keys: string[]): unknown[] => {
    const has = (...k: string[]) => k.every((key) => keys.includes(key));
    if (has('realUsd', 'unpricedInvocations')) {
      return [{ realUsd: 3.5, notionalUsd: 40.25, invocations: 7, unpricedInvocations: 1 }];
    }
    if (has('provider', 'authMode')) {
      return [
        {
          provider: 'claude-code',
          authMode: 'subscription',
          invocations: 7,
          inputTokens: 1000,
          outputTokens: 200,
          cacheReadTokens: 5000,
          cacheCreationTokens: 300,
          costUsd: 3.5,
          notionalCostUsd: 40.25,
          costSources: ['reported'],
          unpricedInvocations: 1,
        },
      ];
    }
    if (has('estimatedTimeHours')) {
      return [1, 2, 3].map((n) => ({
        id: `t${n}`,
        completedAt: day(n),
        estimatedTimeHours: null,
        aiEstimatedTimeHours: null,
      }));
    }
    if (has('id', 'completedAt')) return [{ id: 'p1', completedAt: day(40) }];
    if (has('startedAt', 'provider', 'realUsd')) {
      return [1, 2].map((n) => ({
        startedAt: day(n),
        endedAt: new Date(day(n).getTime() + 60_000),
        provider: 'claude-code',
        realUsd: 1,
        notionalUsd: 2,
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        reportedOutputTokens: 5,
        apiMs: 30_000,
      }));
    }
    if (has('start', 'end')) return [{ start: day(1), end: new Date(day(1).getTime() + 60_000) }];
    if (has('at')) return [{ at: day(1) }, { at: day(1) }, { at: day(2) }];
    if (has('n')) return [{ n: 2 }];
    return [];
  };
  const chain = (keys: string[]): unknown =>
    new Proxy(
      {},
      {
        get: (_t, prop) =>
          prop === 'then'
            ? (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
                Promise.resolve(rowsFor(keys)).then(res, rej)
            : () => chain(keys),
      },
    );
  return { select: (fields?: object) => chain(Object.keys(fields ?? {})) } as unknown as Database;
}

function buildApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('userId', '00000000-0000-4000-8000-0000000000a1');
    c.set('userRole', 'user');
    await next();
  });
  app.route('/m/statistics', createStatsRoutes({ db: fakeDb() }));
  return app;
}

const get = async (app: Hono<AppEnv>, path: string) => {
  const res = await app.request(path);
  expect(res.status).toBe(200);
  return res.json() as Promise<Record<string, any>>;
};

const KPI = {
  completed: '/m/statistics/overview/kpi/tasks-completed',
  spend: '/m/statistics/overview/kpi/spend',
  tokens: '/m/statistics/overview/kpi/tokens',
};

describe('statistics overview page', () => {
  beforeEach(() => {
    h.defaultWindow = null;
  });

  const page = () => moduleManifestSchema.parse(manifest).pages?.overview;

  it('is declared as a page whose endpoint widgets all resolve to mounted routes', async () => {
    const overview = page();
    expect(overview?.title).toBe('Overview');
    const endpointWidgets = (overview?.widgets ?? []).flatMap((w) =>
      'endpoint' in w && w.endpoint !== undefined ? [w] : [],
    );
    expect(endpointWidgets.map((w) => w.type).sort()).toEqual(['chart', 'kpi', 'kpi', 'kpi']);
    const app = buildApp();
    for (const w of endpointWidgets) {
      const body = await get(app, w.endpoint!);
      expect(() => widgetResponseSchema(w.type as 'kpi' | 'chart').parse(body)).not.toThrow();
    }
  });

  it('serves KPI values equal to the same figures on /summary', async () => {
    const app = buildApp();
    const summary = await get(app, '/m/statistics/summary');
    expect((await get(app, KPI.completed)).value).toBe(summary.tasks.completed);
    expect((await get(app, KPI.spend)).value).toBe(summary.spend.notionalUsd);
    expect((await get(app, KPI.tokens)).value).toBe(summary.tokens.totalTokens);
    expect(summary.tasks.completed).toBe(3);
    expect(summary.tokens.totalTokens).toBeGreaterThan(0);
  });

  it('charts the same daily series /timeline serves', async () => {
    const app = buildApp();
    const activity = await get(app, '/m/statistics/overview/activity');
    const timeline = await get(app, '/m/statistics/timeline');
    expect(activity.data.length).toBeGreaterThan(0);
    const tl = new Map(timeline.days.map((d: any) => [d.bucket, d]));
    for (const row of activity.data) {
      const day: any = tl.get(row.day);
      expect(day).toBeDefined();
      expect(row.tasksStarted).toBe(day.tasksStarted);
      expect(row.tasksCompleted).toBe(day.tasksCompleted);
    }
  });

  it.each([
    [null, 30],
    ['7d', 7],
    ['1y', 365],
  ])('windows the chart on the defaultWindow setting (%s)', async (setting, days) => {
    h.defaultWindow = setting;
    const { data } = await get(buildApp(), '/m/statistics/overview/activity');
    expect(data.length).toBeGreaterThanOrEqual(days);
    expect(data.length).toBeLessThanOrEqual(days + 2);
  });
});
