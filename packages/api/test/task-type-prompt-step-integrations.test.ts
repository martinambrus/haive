import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  defs: [] as Record<string, unknown>[],
  catalog: [] as unknown[],
}));

vi.mock('../src/db.js', () => ({ getDb: () => db() }));
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
import { CUSTOM_TOOL_PROBLEM_KINDS } from '@haive/shared/modularity';
import { adminTaskTypeRoutes } from '../src/routes/task-types.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';

// Controls of J6a (task #185), api side: the admin routes judge what a prompt step declares against the
// categories Haive registers. Tags: [C6+] is a pin beyond the five controls of the brief (it is the api line of
// "What the build will do"; listed in the harness README), [C0] passes before and after.

function rows(table: unknown) {
  const result =
    table === schema.taskTypeDefinitions ? h.defs : table === schema.stepCatalog ? h.catalog : [];
  const chain: Record<string, unknown> = {
    then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
      Promise.resolve(result).then(resolve, reject),
    for: async () => result,
  };
  for (const method of ['where', 'orderBy', 'limit', 'groupBy']) chain[method] = () => chain;
  return chain;
}

function insert() {
  return {
    values: (value: unknown) =>
      Object.assign(Promise.resolve([value]), {
        onConflictDoNothing: () => ({ returning: async () => [value] }),
      }),
  };
}

function db() {
  const tx = {
    select: () => ({ from: (table: unknown) => rows(table) }),
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: () => ({ returning: async () => [{ ...h.defs[0], ...values }] }),
      }),
    }),
  };
  return {
    select: () => ({ from: (table: unknown) => rows(table) }),
    insert,
    transaction: async (fn: (handle: typeof tx) => unknown) => fn(tx),
  };
}

const app = new Hono<AppEnv>();
app.route('/admin/task-types', adminTaskTypeRoutes);
app.onError(errorHandler);

const send = (method: string, path: string, body?: unknown) =>
  app.request(path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const TYPE = 'tt-int';
const STEP_ID = `custom.${TYPE}.review`;
const NOW = new Date('2026-10-16T10:00:00.000Z');

// A category of the right grammar that nothing registers: only the registry can tell it from a real one.
const GHOST = { id: 'ghost', category: 'module.ghost.thing', access: 'read' };
const ISSUES = { id: 'tracker', category: 'issues', access: 'read' };

const KINDS_BEFORE_J6A: ReadonlySet<string> = new Set([
  'unknown-token',
  'field-not-declared',
  'persona-id-invalid',
  'reserved-marker-in-template',
  'integration-token',
  'template-too-large',
  'timeout-out-of-range',
  'capability-not-allowed',
  'persona-without-repository',
  'file-write-without-repository',
  'step-id-too-long',
  'step-token-not-earlier',
  'step-token-not-quotable',
  'step-token-not-own-line',
  'prompt-step-missing',
  'prompt-step-orphan',
  ...CUSTOM_TOOL_PROBLEM_KINDS,
  'tool-no-longer-valid',
]);

const promptStep = (integrations: unknown[] | undefined) => ({
  slug: 'review',
  title: 'Review',
  template: 'Review {{task.title}}',
  capabilities: [],
  timeoutMs: 300_000,
  ...(integrations === undefined ? {} : { integrations }),
});

const definition = (integrations: unknown[] | undefined, over: Record<string, unknown> = {}) => ({
  slug: TYPE,
  displayName: 'Type with integrations',
  description: null,
  runListStrategy: 'static',
  stepIds: ['ta-a', STEP_ID],
  preAnswerDefaults: {},
  stepLoopLimitDefaults: {},
  promptSteps: { review: promptStep(integrations) },
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

const createBody = (integrations: unknown[] | undefined) => ({
  slug: 'tt-new',
  displayName: 'New type',
  requiresRepository: true,
  stepIds: ['ta-a', 'custom.tt-new.review'],
  promptSteps: { review: promptStep(integrations) },
});

type Issue = { kind?: string; stepId?: string; raw?: string; message?: string };
type Body = { error?: string; issues?: Issue[]; promptStepIssues?: Issue[]; taskType?: unknown };

const json = async (res: Response) => (await res.json()) as Body;
const newKinds = (issues: Issue[] | undefined) =>
  [...new Set((issues ?? []).map((issue) => issue.kind ?? ''))].filter(
    (kind) => kind !== '' && !KINDS_BEFORE_J6A.has(kind),
  );

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

describe('GET /admin/task-types/:slug and what a stored prompt step declares', () => {
  it('[C6+] answers a category nothing registers with an issue of its own kind, and a registered one with none', async () => {
    h.defs = [definition([GHOST])];
    const refused = await send('GET', `/admin/task-types/${TYPE}`);
    expect(refused.status).toBe(200);
    const body = await json(refused);
    expect(newKinds(body.promptStepIssues), 'kinds of the issues').toHaveLength(1);
    expect(body.promptStepIssues!.every((issue) => issue.stepId === STEP_ID)).toBe(true);
    expect(
      body.promptStepIssues!.map((issue) => `${issue.raw} ${issue.message}`).join('\n'),
    ).toMatch(/ghost/);

    h.defs = [definition([ISSUES])];
    const accepted = await send('GET', `/admin/task-types/${TYPE}`);
    expect((await json(accepted)).promptStepIssues).toEqual([]);
  });

  it('[C0] answers no issue for a step that declares nothing', async () => {
    h.defs = [definition(undefined)];

    const res = await send('GET', `/admin/task-types/${TYPE}`);

    expect(res.status).toBe(200);
    expect((await json(res)).promptStepIssues).toEqual([]);
  });
});

describe('POST /admin/task-types and what a new prompt step declares', () => {
  it('[C6+] refuses a category nothing registers as invalid prompt steps, and creates the type with a registered one', async () => {
    const refused = await send('POST', '/admin/task-types', createBody([GHOST]));
    expect(refused.status).toBe(400);
    const body = await json(refused);
    expect(body.error).toBe('Invalid prompt steps');
    expect(newKinds(body.issues), 'kinds of the issues').toHaveLength(1);

    const created = await send('POST', '/admin/task-types', createBody([ISSUES]));
    expect(created.status).toBe(201);
  });
});

describe('PATCH /admin/task-types/:slug and what an edited prompt step declares', () => {
  it('[C6+] refuses a category nothing registers as invalid prompt steps, and saves a registered one', async () => {
    h.defs = [definition(undefined)];
    const refused = await send('PATCH', `/admin/task-types/${TYPE}`, {
      promptSteps: { review: promptStep([GHOST]) },
    });
    expect(refused.status).toBe(400);
    const body = await json(refused);
    expect(body.error).toBe('Invalid prompt steps');
    expect(newKinds(body.issues), 'kinds of the issues').toHaveLength(1);

    const saved = await send('PATCH', `/admin/task-types/${TYPE}`, {
      promptSteps: { review: promptStep([ISSUES]) },
    });
    expect(saved.status).toBe(200);
  });
});
