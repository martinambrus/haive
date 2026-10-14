import { describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ catalog: [] as unknown[] }));

vi.mock('../src/db.js', () => ({
  getDb: () => ({ select: () => ({ from: (table: unknown) => rows(table) }), insert }),
}));
vi.mock('../src/middleware/auth.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/middleware/auth.js')>()),
  requireAuth: async (c: { set: (key: string, value: string) => void }, next: () => unknown) => {
    c.set('userId', '00000000-0000-4000-8000-0000000000a1');
    c.set('userRole', 'admin');
    await next();
  },
}));

import { Hono } from 'hono';
import { schema } from '@haive/database';
import { validateTaskTypeDraft, type ComposableStepEntry } from '@haive/shared/modularity';
import { adminTaskTypeRoutes } from '../src/routes/task-types.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';

function rows(table: unknown) {
  const result = table === schema.stepCatalog ? h.catalog : [];
  const chain: Record<string, unknown> = {
    then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
      Promise.resolve(result).then(resolve, reject),
  };
  for (const method of ['where', 'orderBy', 'limit']) chain[method] = () => chain;
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

const entry = (stepId: string, over: Partial<ComposableStepEntry> = {}): ComposableStepEntry => ({
  stepId,
  label: stepId,
  group: 'build',
  dispatchesCli: false,
  requires: [],
  provides: [],
  ...over,
});

const ENTRIES = [
  entry('ta-a', { provides: ['x'], agentAuthoredOutput: true }),
  entry('ta-b', {
    requires: [{ needs: 'x', reason: 'needs x' }],
    provides: ['y'],
    loopBudgetEditable: true,
  }),
  entry('ta-c', { requires: [{ needs: 'zzz', reason: 'needs zzz' }] }),
  entry('ta-repo', { requires: [{ needs: 'repository', reason: 'needs the repository' }] }),
];

h.catalog = ENTRIES.map((e) => ({
  stepId: e.stepId,
  source: 'core',
  title: e.label,
  workflowType: 'workflow',
  dispatchesCli: e.dispatchesCli,
  allowSkip: false,
  providerSensitive: false,
  composable: true,
  entry: e,
}));

const catalog = {
  stepIds: new Set(ENTRIES.map((e) => e.stepId)),
  dispatchesCli: new Set(ENTRIES.filter((e) => e.dispatchesCli).map((e) => e.stepId)),
  composable: new Map(ENTRIES.map((e) => [e.stepId, e])),
};

const app = new Hono<AppEnv>();
app.route('/admin/task-types', adminTaskTypeRoutes);
app.onError(errorHandler);

const post = (body: unknown) =>
  app.request('/admin/task-types', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const TYPE = 'tt-draft';
const CUSTOM_ID = `custom.${TYPE}.review`;

const step = (over: Record<string, unknown> = {}) => ({
  slug: 'review',
  title: 'Review',
  template: 'Review {{task.title}}',
  capabilities: [],
  timeoutMs: 300_000,
  ...over,
});

const draftOf = (over: Record<string, unknown> = {}) => ({
  slug: TYPE,
  displayName: 'Draft type',
  requiresRepository: true,
  stepIds: ['ta-a', 'ta-b', CUSTOM_ID],
  promptSteps: { review: step() },
  ...over,
});

type Issue = { kind?: string; path?: string };
const kindsOf = (issues: Issue[]): string[] =>
  issues.map((i) => i.kind ?? `schema:${i.path ?? ''}`);

interface Fixture {
  name: string;
  draft: unknown;
  status: 201 | 400;
  error?: string;
  kinds: string[];
}

const FIXTURES: Fixture[] = [
  { name: 'a valid draft', draft: draftOf(), status: 201, kinds: [] },
  {
    name: 'a bad composition',
    draft: draftOf({ stepIds: ['ta-c', CUSTOM_ID] }),
    status: 400,
    error: 'Invalid step composition',
    kinds: ['unmet-need'],
  },
  {
    name: 'a missing prompt step',
    draft: draftOf({ promptSteps: {} }),
    status: 400,
    error: 'Invalid prompt steps',
    kinds: ['prompt-step-missing'],
  },
  {
    name: 'an orphan prompt step',
    draft: draftOf({ stepIds: ['ta-a', 'ta-b'] }),
    status: 400,
    error: 'Invalid prompt steps',
    kinds: ['prompt-step-orphan'],
  },
  {
    name: 'a bad template token',
    draft: draftOf({ promptSteps: { review: step({ template: 'Say {{nope}}' }) } }),
    status: 400,
    error: 'Invalid prompt steps',
    kinds: ['unknown-token'],
  },
  {
    name: 'a bad loop-limit default',
    draft: draftOf({ stepLoopLimitDefaults: { 'ta-a': 3 } }),
    status: 400,
    error: 'Invalid defaults',
    kinds: ['loop-limit-not-editable'],
  },
  {
    name: 'a prompt step the schema refuses',
    draft: draftOf({ promptSteps: { review: step({ timeoutMs: 5 }) } }),
    status: 400,
    error: 'Validation failed',
    kinds: ['schema:promptSteps.review.timeoutMs'],
  },
  {
    name: 'a step that needs a repository the draft does not have',
    draft: draftOf({ requiresRepository: false, stepIds: ['ta-repo', CUSTOM_ID] }),
    status: 400,
    error: 'Invalid step composition',
    kinds: ['unmet-need'],
  },
  {
    name: 'a bad composition and a bad default together',
    draft: draftOf({
      stepIds: ['ta-c', 'ta-a', CUSTOM_ID],
      stepLoopLimitDefaults: { 'ta-a': 3 },
    }),
    status: 400,
    error: 'Invalid step composition',
    kinds: ['unmet-need'],
  },
];

describe('POST /admin/task-types on the draft fixtures', () => {
  it.each(FIXTURES)('answers $name with $status', async ({ draft, status, error, kinds }) => {
    const res = await post(draft);
    expect(res.status).toBe(status);
    const body = (await res.json()) as { error?: string; issues?: Issue[]; taskType?: unknown };
    if (status === 201) {
      expect(body.taskType).toMatchObject({ slug: TYPE, source: 'admin' });
      return;
    }
    expect(body.error).toBe(error);
    expect(kindsOf(body.issues ?? [])).toEqual(kinds);
  });
});

describe('validateTaskTypeDraft on the same fixtures', () => {
  it.each(FIXTURES)('agrees with the route about $name', async ({ draft, status, kinds }) => {
    const res = await post(draft);
    expect(res.status).toBe(status);
    const body = (await res.json()) as { issues?: Issue[] };
    const result = validateTaskTypeDraft(draft, catalog);
    expect(result.issues).toEqual(status === 201 ? [] : body.issues);
    expect(kindsOf(result.issues as Issue[])).toEqual(kinds);
    expect(result.warnings).toEqual([]);
  });
});
