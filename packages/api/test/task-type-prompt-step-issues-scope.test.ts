import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ defs: [] as unknown[], catalog: [] as unknown[] }));

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
  configService: { getBoolean: async (_key: string, fallback: boolean) => fallback },
}));

import { Hono } from 'hono';
import { schema } from '@haive/database';
import { adminTaskTypeRoutes } from '../src/routes/task-types.js';
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
app.onError(errorHandler);

const STEP_ID = 'custom.tt-x.review';
const NOW = new Date('2026-10-15T10:00:00.000Z');
const staleTool = {
  name: 'stale_tool',
  description: 'd'.repeat(1025),
  action: 'http-get',
  url: 'https://api.example.com/v1/status',
  query: [],
  params: [],
  timeoutMs: 10_000,
  maxResponseBytes: 32_768,
};

const definition = (over: Record<string, unknown>) => ({
  slug: 'tt-x',
  displayName: 'Type X',
  description: null,
  runListStrategy: 'static',
  stepIds: ['ta-a', STEP_ID],
  preAnswerDefaults: {},
  stepLoopLimitDefaults: {},
  promptSteps: {
    review: {
      slug: 'review',
      title: 'Review',
      template: 'Review {{task.title}}',
      capabilities: [],
      tools: [staleTool],
      timeoutMs: 300_000,
    },
  },
  fixLoop: null,
  enabled: true,
  selectable: true,
  source: 'admin',
  requiresRepository: true,
  sortOrder: 0,
  contentHash: null,
  createdAt: NOW,
  updatedAt: NOW,
  ...over,
});

const issuesOf = async () => {
  const res = await app.request('/admin/task-types/tt-x');
  expect(res.status).toBe(200);
  return ((await res.json()) as { promptStepIssues?: unknown }).promptStepIssues;
};

beforeEach(() => {
  h.defs = [definition({})];
  h.catalog = [
    {
      stepId: 'ta-a',
      source: 'core',
      title: 'ta-a',
      dispatchesCli: false,
      composable: true,
      entry: {
        stepId: 'ta-a',
        label: 'ta-a',
        group: 'build',
        dispatchesCli: false,
        requires: [],
        provides: [],
      },
    },
  ];
});

describe('GET /admin/task-types/:slug and which rows are checked for prompt step issues', () => {
  it('names the stored tool of an admin type while the catalog is synced', async () => {
    expect(await issuesOf()).toEqual([
      expect.objectContaining({ kind: 'tool-no-longer-valid', raw: 'stale_tool' }),
    ]);
  });

  it('answers none while the step catalog is unsynced, as it does for the composition', async () => {
    h.catalog = [];
    expect(await issuesOf()).toEqual([]);
  });

  it('answers none for a module type, whatever its row holds', async () => {
    h.defs = [definition({ source: 'module:statistics' })];
    expect(await issuesOf()).toEqual([]);
  });
});
