import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  defs: [] as unknown[],
  catalog: [] as unknown[],
}));

vi.mock('../src/db.js', () => ({
  getDb: () => ({ select: () => ({ from: (table: unknown) => rows(table) }) }),
}));
vi.mock('../src/middleware/auth.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/middleware/auth.js')>()),
  requireAuth: async (c: { set: (key: string, value: string) => void }, next: () => unknown) => {
    c.set('userId', '00000000-0000-4000-8000-0000000000a1');
    c.set('userRole', 'admin');
    await next();
  },
}));
vi.mock('@haive/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@haive/shared')>()),
  configService: { getBoolean: async () => true },
}));

import { Hono } from 'hono';
import { schema } from '@haive/database';
import { adminTaskTypeRoutes, taskTypeRoutes } from '../src/routes/task-types.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';

function rows(table: unknown) {
  const result =
    table === schema.taskTypeDefinitions ? h.defs : table === schema.stepCatalog ? h.catalog : [];
  const chain: Record<string, unknown> = {
    then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
      Promise.resolve(result).then(resolve, reject),
  };
  for (const method of ['where', 'orderBy', 'limit', 'groupBy']) chain[method] = () => chain;
  return chain;
}

const app = new Hono<AppEnv>();
app.route('/admin/task-types', adminTaskTypeRoutes);
app.route('/task-types', taskTypeRoutes);
app.onError(errorHandler);

const catalogRow = (
  stepId: string,
  requires: { needs: string; reason: string }[],
  provides: string[],
) => ({
  stepId,
  source: 'core',
  title: stepId,
  composable: true,
  entry: {
    stepId,
    label: stepId,
    group: 'setup',
    dispatchesCli: false,
    requires,
    provides,
  },
});

const definition = (slug: string, stepIds: string[], requiresRepository: boolean) => ({
  slug,
  displayName: slug,
  description: null,
  runListStrategy: 'static',
  stepIds,
  source: 'admin',
  enabled: true,
  selectable: true,
  requiresRepository,
  sortOrder: 0,
});

beforeEach(() => {
  h.catalog = [
    catalogRow(
      '01-worktree-setup',
      [{ needs: 'repository', reason: 'Needs a repository.' }],
      ['worktree'],
    ),
    catalogRow('03-phase-0a-discovery', [], []),
  ];
  h.defs = [];
});

describe('task type availability and the repository token', () => {
  it('lists a repo-less type with a worktree step as invalid-composition', async () => {
    h.defs = [definition('repo-less-wt', ['01-worktree-setup'], false)];
    const res = await app.request('/task-types');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      taskTypes: [{ slug: 'repo-less-wt', available: false, reason: 'invalid-composition' }],
    });
  });

  it('reports the unmet repository need on the admin detail route', async () => {
    h.defs = [definition('repo-less-wt', ['01-worktree-setup'], false)];
    const res = await app.request('/admin/task-types/repo-less-wt');
    expect(await res.json()).toMatchObject({
      availability: { available: false, reason: 'invalid-composition' },
      compositionIssues: [{ kind: 'unmet-need', stepId: '01-worktree-setup', needs: 'repository' }],
    });
  });

  it('keeps a repo-requiring type with the same worktree step available', async () => {
    h.defs = [definition('repo-wt', ['01-worktree-setup'], true)];
    const res = await app.request('/task-types');
    expect(await res.json()).toMatchObject({ taskTypes: [{ slug: 'repo-wt', available: true }] });
  });

  it('keeps a repo-less type of steps needing no repository available', async () => {
    h.defs = [definition('repo-less-spec', ['03-phase-0a-discovery'], false)];
    const res = await app.request('/task-types');
    expect(await res.json()).toMatchObject({
      taskTypes: [{ slug: 'repo-less-spec', available: true }],
    });
  });
});
