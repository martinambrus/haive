import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FilesReadRollup } from '@haive/shared/stats';

const rollupFilesRead = vi.hoisted(() => vi.fn());

vi.mock('@haive/shared/stats-server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@haive/shared/stats-server')>()),
  rollupFilesRead,
}));

import { Hono } from 'hono';
import type { Database } from '@haive/database';
import { buildFilesRead, FILES_READ_ROW_LIMIT } from '@haive/shared/stats';
import { HttpError, type AppEnv } from '@haive/shared/module-host';
import createStatsRoutes from '../src/routes.js';

const USER_ID = '00000000-0000-4000-8000-0000000000a1';
const REPO_ID = '00000000-0000-4000-8000-0000000000b2';
const BASE = '/m/statistics/files-read';

const emptyRollup = (): FilesReadRollup => ({ paths: { rows: [], count: 0 }, groups: [] });

function appFor(role: 'user' | 'admin'): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('userId', USER_ID);
    c.set('userRole', role);
    await next();
  });
  app.route('/m/statistics', createStatsRoutes({ db: {} as unknown as Database }));
  app.onError((err, c) =>
    err instanceof HttpError
      ? c.json({ error: err.message }, err.status as 400)
      : c.json({ error: 'x' }, 500),
  );
  return app;
}

const rendered = (): { sql: string; params: unknown[] } => {
  const { where } = rollupFilesRead.mock.calls[0]![1] as { where: SQL };
  return new PgDialect().sqlToQuery(where);
};

describe('GET /m/statistics/files-read', () => {
  beforeEach(() => {
    rollupFilesRead.mockReset();
    rollupFilesRead.mockResolvedValue(emptyRollup());
  });

  it('needs a repository: paths of different repositories are not comparable', async () => {
    const res = await appFor('user').request(BASE);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ available: false, reason: 'repository-required' });
    expect(body).toHaveProperty('range');
    expect(body).toHaveProperty('scope');
    expect(rollupFilesRead).not.toHaveBeenCalled();
  });

  it('scopes the rollup to the caller and the repository', async () => {
    const res = await appFor('user').request(`${BASE}?repositoryId=${REPO_ID}`);
    expect(res.status).toBe(200);
    const q = rendered();
    expect(q.sql).toContain('"tasks"."user_id"');
    expect(q.params).toContain(USER_ID);
    expect(q.params).toContain(REPO_ID);
  });

  it('drops the owner term for an admin asking install-wide', async () => {
    const res = await appFor('admin').request(`${BASE}?repositoryId=${REPO_ID}&allUsers=1`);
    expect(res.status).toBe(200);
    const q = rendered();
    expect(q.params).not.toContain(USER_ID);
    expect(q.params).toContain(REPO_ID);
  });

  it('refuses install-wide scope to a non-admin', async () => {
    const res = await appFor('user').request(`${BASE}?repositoryId=${REPO_ID}&allUsers=1`);
    expect(res.status).toBe(403);
    expect(rollupFilesRead).not.toHaveBeenCalled();
  });

  it('rejects a malformed repository id and a range over 731 days', async () => {
    const app = appFor('user');
    expect((await app.request(`${BASE}?repositoryId=nope`)).status).toBe(400);
    const range = `from=2024-01-01T00:00:00Z&to=2026-01-03T00:00:00Z`;
    expect((await app.request(`${BASE}?repositoryId=${REPO_ID}&${range}`)).status).toBe(400);
    expect(rollupFilesRead).not.toHaveBeenCalled();
  });

  it('bounds the ranked paths at the row limit', async () => {
    await appFor('user').request(`${BASE}?repositoryId=${REPO_ID}`);
    expect(rollupFilesRead.mock.calls[0]![1]).toMatchObject({ rowLimit: FILES_READ_ROW_LIMIT });
  });

  it('answers an empty scope with zero coverage and null ratios', async () => {
    const res = await appFor('user').request(`${BASE}?repositoryId=${REPO_ID}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      available: boolean;
      coverage: { total: number };
      files: { rows: unknown[] };
      overflow: { share: { ratio: number | null } };
      totals: { estimatedTokens: number | null };
    };
    expect(body.available).toBe(true);
    expect(body.coverage.total).toBe(0);
    expect(body.files.rows).toEqual([]);
    expect(body.overflow.share.ratio).toBeNull();
    expect(body.totals.estimatedTokens).toBeNull();
  });

  it('returns the shaped report for a rollup', async () => {
    const rollup: FilesReadRollup = {
      paths: {
        rows: [
          {
            path: 'a.ts',
            reads: 2,
            chars: 400,
            weightedChars: 800,
            weightedRuns: 1,
            runs: 1,
            tasks: 1,
          },
        ],
        count: 1,
      },
      groups: [
        {
          stepId: '05-implement',
          provider: 'claude-code',
          runs: 1,
          inFlight: 0,
          recorded: 1,
          observable: 1,
          partial: 0,
          weighted: 1,
          fileReads: 2,
          fileChars: 400,
          weightedChars: 800,
          overflowOmitted: 0,
          overflowRuns: 0,
          overflowReads: 0,
          overflowChars: 0,
          overflowWeightedChars: 0,
          multiFileRuns: 0,
          multiFileReads: 0,
          multiFileChars: 0,
          multiFileWeightedChars: 0,
          shareRuns: 1,
          shareWeightedChars: 800,
          shareInputTokens: 1000,
          shareOutputTokens: 10,
          shareCacheReadTokens: 0,
          shareCacheCreationTokens: 0,
        },
      ],
    };
    rollupFilesRead.mockResolvedValue(rollup);
    const res = await appFor('user').request(`${BASE}?repositoryId=${REPO_ID}`);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      available: true,
      scope: { repositoryId: REPO_ID },
      ...JSON.parse(JSON.stringify(buildFilesRead(rollup))),
    });
  });
});
