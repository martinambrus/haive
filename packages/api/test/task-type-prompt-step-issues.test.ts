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

const TYPE = 'tt-x';
const STEP_ID = `custom.${TYPE}.review`;
const NOW = new Date('2026-10-15T10:00:00.000Z');

const goodTool = {
  name: 'repo_status',
  description: 'Fetches the status of one repository.',
  action: 'http-get',
  url: 'https://api.example.com/v1/status',
  query: [],
  params: [],
  timeoutMs: 10_000,
  maxResponseBytes: 32_768,
};
const staleTool = { ...goodTool, name: 'stale_tool', description: 'd'.repeat(1025) };

const definition = (over: Record<string, unknown>) => ({
  slug: TYPE,
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
      tools: [goodTool, staleTool],
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

beforeEach(() => {
  h.defs = [];
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

describe('GET /admin/task-types/:slug and the prompt steps it stores', () => {
  it('A2 names a stored tool that fails the schema on its step, and answers none for a built-in type', async () => {
    h.defs = [definition({})];
    const res = await app.request(`/admin/task-types/${TYPE}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { promptStepIssues?: unknown };
    expect(body.promptStepIssues, 'promptStepIssues on an admin type').toEqual([
      expect.objectContaining({ kind: 'tool-no-longer-valid', stepId: STEP_ID, raw: 'stale_tool' }),
    ]);

    h.defs = [
      definition({
        slug: 'workflow',
        source: 'builtin',
        runListStrategy: 'workflow_paths',
        stepIds: null,
        promptSteps: {},
      }),
    ];
    const builtin = await app.request('/admin/task-types/workflow');
    expect(builtin.status).toBe(200);
    expect(((await builtin.json()) as { promptStepIssues?: unknown }).promptStepIssues).toEqual([]);
  });
});
