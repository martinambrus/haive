import { createFakeDb } from '@haive/database/testing';
import type { StepPortProjection } from '@haive/shared/step-ports';
import { replacementAdmissionFixture } from './derived-admission-fixtures.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  db: undefined as unknown,
  role: 'user',
  getDb: vi.fn(),
  write: vi.fn(),
  defs: [] as unknown[],
  catalog: [] as unknown[],
  modules: [] as unknown[],
}));

vi.mock('../src/db.js', () => ({
  getDb: () => {
    h.getDb();
    if (h.db) return h.db;
    return {
      select: () => ({ from: (table: unknown) => rows(table) }),
      insert: h.write,
      update: h.write,
      delete: h.write,
      transaction: h.write,
    };
  },
}));
vi.mock('../src/middleware/auth.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/middleware/auth.js')>()),
  requireAuth: async (c: { set: (key: string, value: string) => void }, next: () => unknown) => {
    c.set('userId', '00000000-0000-4000-8000-0000000000a1');
    c.set('userRole', h.role);
    await next();
  },
}));
vi.mock('@haive/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@haive/shared')>()),
  configService: { getBoolean: async (_key: string, fallback: boolean) => fallback },
}));

import { Hono } from 'hono';
import { schema } from '@haive/database';
import {
  adminTaskTypeRoutes,
  taskTypeRoutes,
  portDraftSchema,
  MAX_PORT_DRAFT_STEPS,
} from '../src/routes/task-types.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';

function rows(table: unknown) {
  const result =
    table === schema.taskTypeDefinitions
      ? h.defs
      : table === schema.stepCatalog
        ? h.catalog
        : table === schema.modules
          ? h.modules
          : [];
  const chain: Record<string, unknown> = {
    then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
      Promise.resolve(result).then(resolve, reject),
  };
  for (const method of ['where', 'orderBy', 'limit', 'groupBy', 'for']) chain[method] = () => chain;
  return chain;
}

const app = new Hono<AppEnv>();
app.route('/admin/task-types', adminTaskTypeRoutes);
app.route('/task-types', taskTypeRoutes);
app.onError(errorHandler);

const send = (method: string, path: string, body?: unknown) =>
  app.request(path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

beforeEach(() => {
  h.role = 'user';
  h.db = undefined;
  h.getDb.mockClear();
  h.write.mockClear();
  h.defs = [];
  h.catalog = [];
  h.modules = [];
});

describe('/admin/task-types for a regular user', () => {
  const create = {
    slug: 'my-type',
    displayName: 'My type',
    stepIds: ['01-worktree-setup'],
    requiresRepository: true,
  };
  const verbs: [string, string, unknown?][] = [
    ['GET', '/admin/task-types'],
    ['GET', '/admin/task-types/catalog'],
    ['GET', '/admin/task-types/my-type'],
    ['POST', '/admin/task-types', create],
    [
      'POST',
      '/admin/task-types/preview',
      {
        slug: 'my-derived',
        displayName: 'Derived',
        runListStrategy: 'derived',
        baseSlug: 'workflow',
        changes: [],
      },
    ],
    ['PATCH', '/admin/task-types/my-type', { displayName: 'Renamed' }],
    ['DELETE', '/admin/task-types/my-type'],
  ];

  it.each(verbs)('refuses %s %s with 403 before touching the database', async (m, path, body) => {
    const res = await send(m, path, body);
    expect(res.status).toBe(403);
    expect(h.getDb).not.toHaveBeenCalled();
    expect(h.write).not.toHaveBeenCalled();
  });

  it('lets an admin through the same gate', async () => {
    h.role = 'admin';
    const res = await send('GET', '/admin/task-types');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ taskTypes: [] });
  });
});

describe('GET /task-types', () => {
  it('names only absent steps in missingStepIds, leaving the stored run list intact', async () => {
    h.catalog = [{ stepId: 'installed', composable: false, dispatchesCli: false }];
    h.defs = [
      {
        slug: 'onboarding',
        displayName: 'Onboarding',
        description: null,
        runListStrategy: 'static',
        stepIds: ['installed', 'gone'],
        source: 'builtin',
        enabled: true,
        selectable: true,
        requiresRepository: true,
        sortOrder: 0,
      },
    ];
    const res = await send('GET', '/task-types');
    expect(res.status).toBe(200);
    const { taskTypes } = (await res.json()) as { taskTypes: Record<string, unknown>[] };
    expect(taskTypes).toHaveLength(1);
    expect(taskTypes[0]).toMatchObject({
      available: false,
      reason: 'missing-step',
      missingStepIds: ['gone'],
    });
    expect(taskTypes[0]).not.toHaveProperty('stepIds');
    expect(h.defs[0]).toHaveProperty('stepIds', ['installed', 'gone']);
    expect(h.write).not.toHaveBeenCalled();
  });

  it('answers a regular user, listing only what the database returned', async () => {
    h.defs = [
      {
        slug: 'workflow',
        displayName: 'Workflow',
        description: null,
        runListStrategy: 'workflow_paths',
        stepIds: null,
        source: 'builtin',
        enabled: true,
        selectable: true,
        requiresRepository: true,
        sortOrder: 1,
      },
    ];
    const res = await send('GET', '/task-types');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      taskTypes: [
        {
          slug: 'workflow',
          displayName: 'Workflow',
          description: null,
          requiresRepository: true,
          sortOrder: 1,
          restoresDatabase: true,
          dispatchesCli: true,
          available: true,
        },
      ],
    });
    expect(h.write).not.toHaveBeenCalled();
  });
});

describe('GET /admin/task-types/catalog overview metadata', () => {
  it('keeps filtered module declarations read-only and outside the selectable catalog', async () => {
    h.role = 'admin';
    h.modules = [{ moduleId: 'notes', name: 'Notes', missingAt: null, deactivatedAt: new Date() }];
    const entry = {
      stepId: 'module.notes.review',
      label: 'Notes review',
      group: 'build',
      dispatchesCli: true,
      requires: [],
      provides: [],
      integrations: [{ id: 'docs', category: 'module.notes.docs', access: 'read' }],
    };
    h.catalog = [
      {
        stepId: entry.stepId,
        source: 'module:notes',
        title: entry.label,
        composable: true,
        dispatchesCli: true,
        entry,
      },
    ];
    const response = await send('GET', '/admin/task-types/catalog');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      steps: [],
      unavailableSteps: [{ stepId: entry.stepId, entry }],
      registeredStepIds: [entry.stepId],
      modules: [{ id: 'notes', state: 'deactivated' }],
    });
    expect(h.write).not.toHaveBeenCalled();
  });
});

describe('DT3 derived list admission boundary', () => {
  it.each(['/task-types', '/admin/task-types'])(
    'serializes a persisted derived row at %s without a server error',
    async (path) => {
      h.role = 'admin';
      h.defs = [
        {
          slug: 'derived-example',
          displayName: 'Derived example',
          description: null,
          source: 'admin',
          enabled: true,
          selectable: true,
          runListStrategy: 'derived',
          stepIds: null,
          baseSlug: 'workflow',
          changes: [],
          requiresRepository: true,
          sortOrder: 0,
          promptSteps: {},
          preAnswerDefaults: {},
          stepLoopLimitDefaults: {},
        },
      ];
      const response = await send('GET', path);
      expect(response.status).toBe(200);
      expect(h.write).not.toHaveBeenCalled();
    },
  );
});

describe('static authoring validation compatibility', () => {
  it('keeps the exact per-field issues for an invalid static create body', async () => {
    h.role = 'admin';
    const res = await send('POST', '/admin/task-types', {
      slug: 'x',
      displayName: 'X',
      stepIds: 'nope',
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'Validation failed',
      issues: [
        { path: 'stepIds', message: 'Invalid input: expected array, received string' },
        {
          path: 'requiresRepository',
          message: 'Invalid input: expected boolean, received undefined',
        },
      ],
    });
    expect(h.getDb).not.toHaveBeenCalled();
  });

  it('keeps the strict-schema response for changes on a static PATCH', async () => {
    h.role = 'admin';
    h.defs = [{ slug: 'my-type', source: 'admin', runListStrategy: 'static' }];
    h.write.mockImplementationOnce(async (fn: (tx: unknown) => unknown) =>
      fn({ select: () => ({ from: (table: unknown) => rows(table) }) }),
    );
    const res = await send('PATCH', '/admin/task-types/my-type', { changes: [] });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'Validation failed',
      issues: [{ path: '', message: 'Unrecognized key: "changes"' }],
    });
  });
});

describe('read-only port projection', () => {
  const ids = ['04-phase-0b-pre-planning', '05-phase-0b5-spec-quality'];
  const draft = { slug: 'ports', displayName: 'Ports', stepIds: ids, requiresRepository: true };
  it('refuses a regular user before reading the catalog', async () => {
    expect((await send('POST', '/admin/task-types/ports', draft)).status).toBe(403);
    expect(h.getDb).not.toHaveBeenCalled();
  });
  it('projects a static unsaved draft without writing or exposing catalog extras', async () => {
    h.role = 'admin';
    h.catalog = ids.map((stepId) => ({
      stepId,
      source: 'core',
      composable: false,
      title: stepId,
      entry: { private: 'secret' },
    }));
    const res = await send('POST', '/admin/task-types/ports', draft);
    expect(res.status).toBe(200);
    const body = (await res.json()) as StepPortProjection;
    expect(body.candidates[0]!.graph.edges[0]).toMatchObject({ source: ids[0], target: ids[1] });
    expect(JSON.stringify(body)).not.toMatch(/secret|hostPolicy|quoteProjection|outputValidators/);
    expect(h.write).not.toHaveBeenCalled();
  });
  it('uses the stored type and returns 404 for an absent type', async () => {
    h.role = 'admin';
    h.defs = [{ ...draft, source: 'admin', runListStrategy: 'static' }];
    const res = await send('GET', '/admin/task-types/ports/ports');
    expect(res.status).toBe(200);
    expect(
      ((await res.json()) as StepPortProjection).candidates[0]!.graph.nodes.map(
        (n: { id: string }) => n.id,
      ),
    ).toEqual(ids);
    h.defs = [];
    expect((await send('GET', '/admin/task-types/absent/ports')).status).toBe(404);
  });
});

it('projects each derived draft candidate independently, including v2 bindings', async () => {
  h.role = 'admin';
  const { catalog, base, definition, payload } = replacementAdmissionFixture();
  h.defs = [base];
  h.catalog = [...catalog.composable.values()].map((entry) => ({
    stepId: entry.stepId,
    title: entry.label,
    source: entry.stepId === payload ? 'module:acme' : 'core',
    composable: true,
    entry,
    dispatchesCli: false,
    ...catalog.orderedRows.find((row) => row.stepId === entry.stepId),
  }));
  const { source: _source, ...draft } = definition;
  const res = await send('POST', '/admin/task-types/ports', { ...draft, displayName: 'Derived' });
  expect(res.status).toBe(200);
  const body = (await res.json()) as StepPortProjection;
  expect(body.candidates.length).toBeGreaterThan(1);
  expect(
    body.candidates.some((c: { graph: { nodes: { id: string }[] } }) =>
      c.graph.nodes.some((n) => n.id === payload),
    ),
  ).toBe(true);
  expect(h.write).not.toHaveBeenCalled();
});

it('projects a stored derived type with the same candidate-local graph as its unsaved draft', async () => {
  h.role = 'admin';
  const fixture = replacementAdmissionFixture();
  const fake = createFakeDb({
    taskTypeDefinitions: schema.taskTypeDefinitions,
    stepCatalog: schema.stepCatalog,
  });
  fake.insert(schema.taskTypeDefinitions, fixture.base);
  fake.insert(schema.taskTypeDefinitions, fixture.definition);
  for (const entry of fixture.catalog.composable.values()) {
    fake.insert(schema.stepCatalog, {
      stepId: entry.stepId,
      source: entry.stepId === fixture.payload ? 'module:acme' : 'core',
      title: entry.label,
      composable: true,
      entry,
      dispatchesCli: false,
      ...fixture.catalog.orderedRows.find((row) => row.stepId === entry.stepId),
    });
  }
  h.db = fake.db;
  const stored = await send('GET', `/admin/task-types/${fixture.definition.slug}/ports`);
  const { source: _source, ...draft } = fixture.definition;
  const unsaved = await send('POST', '/admin/task-types/ports', {
    ...draft,
    displayName: 'Derived',
  });
  expect(stored.status).toBe(200);
  expect(unsaved.status).toBe(200);
  expect(await stored.json()).toEqual(await unsaved.json());
});

it('refuses port drafts above the fixed projection step cap before reading the catalog', async () => {
  h.role = 'admin';
  const res = await send('POST', '/admin/task-types/ports', {
    slug: 'ports',
    displayName: 'Ports',
    stepIds: Array(257).fill('07-phase-2-implement'),
    requiresRepository: true,
  });
  expect(res.status).toBe(400);
  expect(h.getDb).not.toHaveBeenCalled();
});

it('checks the port-only bound at a small injected size and pins the production cap', () => {
  expect(MAX_PORT_DRAFT_STEPS).toBe(256);
  const draft = {
    slug: 'ports',
    displayName: 'Ports',
    requiresRepository: true,
    stepIds: ['a', 'b'],
  };
  expect(portDraftSchema(2).safeParse(draft).success).toBe(true);
  expect(portDraftSchema(2).safeParse({ ...draft, stepIds: ['a', 'b', 'c'] }).success).toBe(false);
});

it.each(
  ['static', 'derived'].flatMap((strategy) =>
    [false, true].map((otherInvalidFields) => ({ strategy, otherInvalidFields })),
  ),
)(
  'projects an unfinished $strategy prompt draft (other save-only errors: $otherInvalidFields)',
  async ({ strategy, otherInvalidFields }) => {
    h.role = 'admin';
    const fixture = replacementAdmissionFixture();
    h.defs = [fixture.base];
    h.catalog = [...fixture.catalog.composable.values()].map((entry) => ({
      stepId: entry.stepId,
      title: entry.label,
      source: 'core',
      composable: true,
      entry,
      ...fixture.catalog.orderedRows.find((row) => row.stepId === entry.stepId),
    }));
    const id = 'custom.ports.prompt';
    const response = await send('POST', '/admin/task-types/ports', {
      slug: 'ports',
      displayName: otherInvalidFields ? '' : 'Ports',
      promptSteps: {
        prompt: {
          slug: 'prompt',
          title: 'Unfinished prompt',
          template: '',
          timeoutMs: otherInvalidFields ? 0 : 60_000,
          tools: otherInvalidFields ? [{}] : [],
        },
      },
      ...(otherInvalidFields ? { preAnswerDefaults: { unused: 'unfinished' } } : {}),
      ...(strategy === 'static'
        ? { stepIds: [id], requiresRepository: true }
        : {
            runListStrategy: 'derived',
            baseSlug: 'workflow',
            changes: [{ insertAfter: '00-triage', step: id }],
          }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as StepPortProjection;
    expect(body.candidates.length).toBeGreaterThan(0);
    for (const candidate of body.candidates) {
      expect(candidate.graph.nodes).toContainEqual({
        id,
        label: 'Unfinished prompt',
        inputs: [],
        outputs: [],
      });
    }
    expect(h.write).not.toHaveBeenCalled();
  },
);
