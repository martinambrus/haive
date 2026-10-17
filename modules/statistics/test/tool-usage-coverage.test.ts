import { describe, expect, it, vi } from 'vitest';

vi.mock('@haive/shared/stats-server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@haive/shared/stats-server')>()),
  rollupToolUsage: async () => ({
    coverage: [
      {
        stepKey: null,
        provider: 'claude-code',
        total: 3,
        recorded: 1,
        inFlight: 1,
        observable: 1,
        partial: 0,
        unobservable: 0,
        withLoaded: 0,
      },
    ],
    personasAssigned: [],
    personasRead: [],
    skillsInvoked: [],
    skillsRead: [],
    mcpTools: [],
    mcpServers: [],
    mcpOffered: [],
    subagents: [],
    nativeTools: [],
  }),
}));

import { Hono } from 'hono';
import type { Database } from '@haive/database';
import type { AppEnv } from '@haive/shared/module-host';
import createStatsRoutes from '../src/routes.js';

function fakeDb(): Database {
  const chain = (): unknown =>
    new Proxy(
      {},
      {
        get: (_t, prop) =>
          prop === 'then'
            ? (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
                Promise.resolve([{ since: null }]).then(res, rej)
            : () => chain(),
      },
    );
  return { select: () => chain() } as unknown as Database;
}

describe('statistics tool usage coverage', () => {
  it('counts a run still in flight apart from one that ended with no record', async () => {
    const app = new Hono<AppEnv>();
    app.use('*', async (c, next) => {
      c.set('userId', '00000000-0000-4000-8000-0000000000a1');
      c.set('userRole', 'user');
      await next();
    });
    app.route('/m/statistics', createStatsRoutes({ db: fakeDb() }));

    const res = await app.request('/m/statistics/tool-usage');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      coverage: {
        unrecorded: number;
        inFlight: number;
        byProvider: Array<{ unrecorded: number; inFlight: number }>;
      };
    };

    expect(body.coverage.unrecorded).toBe(1);
    expect(body.coverage.inFlight).toBe(1);
    expect(body.coverage.byProvider[0]).toMatchObject({ unrecorded: 1, inFlight: 1 });
  });
});
