import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { Hono } from 'hono';
import { eq, getTableName, sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { SPEC_ROLES, STEP_ROLE_REGISTRY } from '@haive/shared/step-outputs';
import type { AppEnv } from '../src/context.js';
const h = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/queues.js', () => ({ getTaskQueue: () => ({ add: vi.fn() }) }));
vi.mock('../src/middleware/auth.js', () => ({
  requireAuth: async (_c: unknown, next: () => Promise<void>) => next(),
  requireAdmin: async (_c: unknown, next: () => Promise<void>) => next(),
}));
vi.mock('@haive/shared', async (original) => ({
  ...(await original<typeof import('@haive/shared')>()),
  configService: { getBoolean: async () => true },
}));
import { mountModules, type ApiModuleEntry } from '../src/modules/loader.js';
import { definitionForCreate } from '../src/lib/task-type-definition.js';
import { adminTaskTypeRoutes, taskTypeRoutes } from '../src/routes/task-types.js';
import { errorHandler } from '../src/middleware/error-handler.js';
const argsSchema = z.strictObject({ producer: z.literal('module.fx.producer') });
const moduleEntry = (executionPredicates?: unknown) =>
  ({
    packageName: '@haive/module-fx',
    manifest: { id: 'fx', name: 'Fx', version: '1', schemaVersion: 1 },
    ...(executionPredicates === undefined ? {} : { executionPredicates }),
  }) as ApiModuleEntry;
const declarations = [{ id: 'planned', argsSchema }];
const ids = ['module.fx.prelude', 'module.fx.producer', 'module.fx.consumer', 'module.fx.report'];
const executionContract = {
  version: 1,
  guardedSpans: [
    {
      id: 'work',
      firstStepId: ids[1],
      lastStepId: ids[2],
      predicateId: 'module.fx.planned',
      args: { producer: ids[1] },
    },
  ],
};
async function setup(exported: unknown = declarations, rawContract: unknown = executionContract) {
  const fake = createFakeDb({
    taskTypeDefinitions: schema.taskTypeDefinitions,
    modules: schema.modules,
    stepCatalog: schema.stepCatalog,
    auditEvents: schema.auditEvents,
  });
  h.db = fake.db;
  fake.insert(schema.modules, {
    moduleId: 'fx',
    name: 'Fx',
    missingAt: null,
    deactivatedAt: null,
    drainingAt: null,
  });
  fake.insert(schema.taskTypeDefinitions, {
    slug: 'fx__scan',
    displayName: 'Scan',
    description: null,
    sortOrder: 1,
    source: 'module:fx',
    runListStrategy: 'static',
    stepIds: ids,
    enabled: true,
    selectable: true,
    requiresRepository: false,
    preAnswerDefaults: {},
    stepLoopLimitDefaults: {},
    promptSteps: {},
    executionContract: rawContract,
  });
  const role = SPEC_ROLES.draft,
    contract = STEP_ROLE_REGISTRY[role].contract;
  for (const [index, stepId] of ids.entries())
    fake.insert(schema.stepCatalog, {
      stepId,
      source: 'module:fx',
      workflowType: 'module.fx',
      stepIndex: index,
      composable: true,
      dispatchesCli: false,
      entry: {
        stepId,
        label: stepId,
        group: 'test',
        requires: [],
        provides: [],
        dispatchesCli: false,
        ...(index === 1 ? { providesRoles: [{ role, contract }] } : {}),
        ...(index === 2
          ? { consumesRoles: [{ input: 'spec', role, contract, optional: false }] }
          : {}),
      },
    });
  await mountModules(new Hono<AppEnv>(), [moduleEntry(exported)], { db: fake.db as never });
  return fake;
}
async function availability() {
  const app = new Hono<AppEnv>();
  app.route('/task-types', taskTypeRoutes);
  app.onError(errorHandler);
  const response = await app.request('/task-types');
  expect(response.status, await response.clone().text()).toBe(200);
  return ((await response.json()) as { taskTypes: { available: boolean }[] }).taskTypes[0]!;
}
afterEach(async () => {
  await mountModules(new Hono<AppEnv>(), [], { db: {} as never });
});
it.each(['predicate', 'endpoint'])(
  'derived save and locked admission name an unavailable guard %s',
  async (missing) => {
    const bad =
      missing === 'predicate'
        ? executionContract
        : {
            ...executionContract,
            guardedSpans: [
              { ...executionContract.guardedSpans[0]!, firstStepId: 'module.fx.absent' },
            ],
          };
    const fake = await setup(missing === 'predicate' ? [] : declarations, bad);
    for (const [stepIndex, stepId] of [
      '00-model-health-workflow',
      '00a-sync-base',
      '00-triage',
    ].entries())
      fake.insert(schema.stepCatalog, {
        stepId,
        title: stepId,
        workflowType: 'workflow',
        stepIndex,
        composable: true,
        dispatchesCli: false,
        entry: {
          stepId,
          label: stepId,
          group: 'test',
          dispatchesCli: false,
          requires: [],
          provides: [],
        },
      });
    fake.insert(schema.taskTypeDefinitions, {
      slug: 'workflow',
      source: 'builtin',
      runListStrategy: 'workflow_paths',
      requiresRepository: false,
    });
    const changes = ids.map((step, index) => ({
      insertAfter: index ? ids[index - 1]! : '00-triage',
      step,
    }));
    await fake.db
      .update(schema.taskTypeDefinitions)
      .set({
        source: 'admin',
        runListStrategy: 'derived',
        baseSlug: 'workflow',
        stepIds: null,
        changes,
      })
      .where(eq(schema.taskTypeDefinitions.slug, 'fx__scan'));
    const app = new Hono<AppEnv>();
    app.route('/admin/task-types', adminTaskTypeRoutes);
    app.onError(errorHandler);
    const response = await app.request('/admin/task-types/fx__scan', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ changes }),
    });
    expect(response.status, await response.clone().text()).toBe(400);
    expect(await response.json()).toMatchObject({
      issues: expect.arrayContaining([
        expect.objectContaining({
          kind: 'invalid-execution-contract',
          reason: expect.stringContaining(
            missing === 'predicate' ? 'unknown-predicate' : 'span-endpoints',
          ),
        }),
      ]),
    });
    await expect(
      fake.db.transaction((tx) =>
        definitionForCreate(tx as never, 'fx__scan', { generic: true, locked: true }),
      ),
    ).rejects.toMatchObject({ code: 'invalid-execution-contract' });
    expect(fake.rows(schema.auditEvents)).toEqual([]);
    const rename = await app.request('/admin/task-types/fx__scan', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 'Repair this definition' }),
    });
    expect(rename.status, await rename.clone().text()).toBe(200);
  },
);
it('API schemas validate guarded composition and locked pin construction without loading or running a step', async () => {
  const fake = await setup();
  expect(await availability()).toMatchObject({ available: true });
  const def = await fake.db.transaction((tx) =>
    definitionForCreate(tx as never, 'fx__scan', { generic: true, locked: true }),
  );
  expect(def.dataEdgePlan).toMatchObject({
    version: 3,
    candidates: [{ bindings: { '2:spec': { producerStepId: ids[1] } } }],
  });
  expect(def.executionContract).toEqual(executionContract);
  expect(JSON.stringify(def)).not.toContain('argsSchema');
});
it('a module without the export stays unknown', async () => {
  const fake = await setup([]);
  await mountModules(new Hono<AppEnv>(), [moduleEntry()], { db: fake.db as never });
  expect(await availability()).toMatchObject({ available: false });
  await expect(
    fake.db.transaction((tx) =>
      definitionForCreate(tx as never, 'fx__scan', { generic: true, locked: true }),
    ),
  ).rejects.toThrow('unknown-predicate');
});
it('matching trusted schemas admit the guarded pin through availability and locked creation', async () => {
  const fake = await setup();
  expect(await availability()).toMatchObject({ available: true });
  const def = await fake.db.transaction((tx) =>
    definitionForCreate(tx as never, 'fx__scan', { generic: true, locked: true }),
  );
  expect(def.executionContract).toEqual(executionContract);
});
it('API admission validates args and independently skipped data producers', async () => {
  const fake = await setup();
  for (const [bad, reason] of [
    [
      {
        ...executionContract,
        guardedSpans: [{ ...executionContract.guardedSpans[0]!, args: { producer: 'wrong' } }],
      },
      'predicate-args',
    ],
    [
      {
        ...executionContract,
        guardedSpans: [{ ...executionContract.guardedSpans[0]!, lastStepId: ids[1] }],
      },
      'invalid-data-role-binding',
    ],
  ] as const) {
    await fake.db
      .update(schema.taskTypeDefinitions)
      .set({ executionContract: bad })
      .where(eq(schema.taskTypeDefinitions.slug, 'fx__scan'));
    await expect(
      fake.db.transaction((tx) =>
        definitionForCreate(tx as never, 'fx__scan', { generic: true, locked: true }),
      ),
    ).rejects.toThrow(reason);
  }
});
it.each([null, { version: 1, guardedSpans: [] }])(
  'ordinary availability and locked create stay byte-identical with and without declarations (%j)',
  async (rawContract) => {
    const fake = await setup(declarations, rawContract);
    const capture = async () => {
      const statements: Record<string, unknown>[] = [];
      h.db = captureReads(fake.db, statements);
      const output = [
        await availability(),
        await fake.db.transaction((tx) =>
          definitionForCreate(captureReads(tx, statements) as never, 'fx__scan', {
            generic: true,
            locked: true,
          }),
        ),
      ];
      return JSON.stringify({ output, statements });
    };
    const first = await capture();
    expect(first).toMatchSnapshot();
    await mountModules(new Hono<AppEnv>(), [moduleEntry()], { db: fake.db as never });
    expect(await capture()).toBe(first);
  },
);
it.each([
  [[...declarations, ...declarations], 'duplicate'],
  [[{ id: 'module.other.planned', argsSchema }], 'local predicate id'],
  [[{ id: 'planned' }], 'schema-only'],
  [[{ ...declarations[0], evaluate: () => true }], 'schema-only'],
])('API boot refuses an invalid schema export', async (value, message) => {
  await expect(setup(value)).rejects.toThrow(message as string);
});

it('stored admin detail and structural PATCH use the same schema map for composition and data edges', async () => {
  const fake = await setup();
  await fake.db
    .update(schema.taskTypeDefinitions)
    .set({ source: 'admin' })
    .where(eq(schema.taskTypeDefinitions.slug, 'fx__scan'));
  const app = new Hono<AppEnv>();
  app.route('/admin/task-types', adminTaskTypeRoutes);
  app.onError(errorHandler);
  const detail = await app.request('/admin/task-types/fx__scan');
  expect(detail.status, await detail.clone().text()).toBe(200);
  expect(await detail.json()).toMatchObject({
    compositionIssues: [],
    availability: { available: true },
  });
  const patch = () =>
    app.request('/admin/task-types/fx__scan', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ stepIds: ids }),
    });
  const accepted = await patch();
  expect(accepted.status, await accepted.clone().text()).toBe(200);
  await mountModules(new Hono<AppEnv>(), [moduleEntry()], { db: fake.db as never });
  const refused = await patch();
  expect(refused.status).toBe(400);
  expect(await refused.text()).toContain('unknown-predicate');
});

// Admission and public availability only read. Capture their entire SELECT/execute
// sequence as well as returned bytes; snapshots are also run against the parent.
function captureReads(
  db: ReturnType<typeof createFakeDb>['db'],
  statements: Record<string, unknown>[],
) {
  const dialect = new PgDialect();
  const condition = (value: unknown) => dialect.sqlToQuery(value as never);
  return {
    ...db,
    select: (fields?: Record<string, unknown>) => ({
      from: (table: Parameters<ReturnType<typeof db.select>['from']>[0]) => {
        const statement: Record<string, unknown> = {
          kind: 'select',
          table: getTableName(table),
          fields: fields ? Object.keys(fields) : '*',
        };
        statements.push(statement);
        const builder = db.select(fields).from(table);
        const captured = new Proxy(builder, {
          get:
            (query, method: keyof typeof builder) =>
            (...args: unknown[]) => {
              if (method === 'where') statement.where = condition(args[0]);
              if (method === 'limit') statement.limit = args[0];
              if (method === 'orderBy')
                statement.order = args.map((arg) => condition(sql`${arg as never}`));
              if (method === 'for') statement.lock = args;
              const result = (query[method] as (...values: unknown[]) => unknown)(...args);
              return result === builder ? captured : result;
            },
        });
        return captured;
      },
    }),
    execute: (query: unknown) => {
      statements.push({ kind: 'execute', query: condition(query) });
      return db.execute(query);
    },
  };
}
