import type { StepPortProjection } from '@haive/shared/step-ports';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ db: undefined as unknown, authenticated: true }));
vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/queues.js', () => ({ getTaskQueue: () => ({ add: vi.fn() }) }));
vi.mock('../src/middleware/auth.js', () => ({
  requireAuth: async (
    c: {
      set: (key: string, value: string) => void;
      json: (body: unknown, status: number) => unknown;
    },
    next: () => unknown,
  ) => {
    if (!h.authenticated) return c.json({ error: 'Unauthorized' }, 401);
    c.set('userId', USER);
    await next();
  },
  requireAdmin: async (_c: unknown, next: () => unknown) => next(),
}));
import { Hono } from 'hono';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { taskRoutes } from '../src/routes/tasks/index.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import { replacementAdmissionFixture } from './derived-admission-fixtures.js';
import { inspectDerivedDefinition } from '@haive/shared/modularity-server';
import { STEP_ROLES } from '@haive/shared/step-outputs';
import type { AppEnv } from '../src/context.js';
const USER = '00000000-0000-4000-8000-000000000001';
const TASK = '00000000-0000-4000-8000-000000000002';
const app = new Hono<AppEnv>();
app.route('/tasks', taskRoutes);
app.onError(errorHandler);
function setup(extra: Record<string, unknown> = {}) {
  const db = createFakeDb({
    tasks: schema.tasks,
    taskSteps: schema.taskSteps,
    taskTypeDefinitions: schema.taskTypeDefinitions,
  });
  db.insert(schema.tasks, {
    id: TASK,
    userId: USER,
    type: 'workflow',
    runListSnapshot: ['04-phase-0b-pre-planning', '05-phase-0b5-spec-quality'],
    ...extra,
  });
  h.db = db.db;
  return db;
}
beforeEach(() => {
  h.authenticated = true;
});
describe('owner-scoped task port graph', () => {
  it('returns canonical history in pinned run order without a live catalog', async () => {
    setup();
    const response = await app.request(`/tasks/${TASK}/ports`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as StepPortProjection;
    expect(body.candidates[0]!.graph.edges[0]).toMatchObject({
      source: '04-phase-0b-pre-planning',
      target: '05-phase-0b5-spec-quality',
    });
    expect(JSON.stringify(body)).not.toMatch(
      /userId|hostPolicy|composableEntries|outputContract|overlay/,
    );
  });
  it('refuses another owner and an unauthenticated caller', async () => {
    setup({ userId: '00000000-0000-4000-8000-000000000099' });
    expect((await app.request(`/tasks/${TASK}/ports`)).status).toBe(404);
    h.authenticated = false;
    expect((await app.request(`/tasks/${TASK}/ports`)).status).toBe(401);
  });
  it('uses the v2 candidate producer despite later definition edits', async () => {
    const fixture = replacementAdmissionFixture();
    const gate = '09-gate-2-verify-approval';
    fixture.catalog.orderedRows.push({ stepId: gate, stepIndex: 100, workflowType: 'workflow' });
    fixture.catalog.stepIds.add(gate);
    fixture.catalog.composable.set(gate, {
      stepId: gate,
      label: 'Gate',
      group: 'test',
      requires: [],
      provides: [],
      dispatchesCli: false,
    });
    const diagnostics = inspectDerivedDefinition(fixture.definition, fixture.base, fixture.catalog);
    expect(diagnostics.plan).not.toBeNull();
    const selected = diagnostics.plan!.candidates.find(
      (c) =>
        c.executionPath !== null && c.stepIds.includes(gate) && c.stepIds.includes(fixture.payload),
    )!;
    expect(selected).toBeDefined();
    const fake = setup({
      type: 'derived-test',
      derivedRunPlan: diagnostics.plan,
      executionPath: selected.executionPath,
      runListSnapshot: selected.stepIds,
    });
    fake.insert(schema.taskTypeDefinitions, {
      slug: 'derived-test',
      changes: [],
      runListStrategy: 'static',
    });
    const response = await app.request(`/tasks/${TASK}/ports`);
    expect(response.status).toBe(200);
    const graph = ((await response.json()) as StepPortProjection).candidates[0]!.graph;
    expect(graph.edges).toContainEqual(
      expect.objectContaining({ source: fixture.payload, target: gate }),
    );
    expect(graph.nodes.some((n: { id: string }) => n.id === STEP_ROLES.codeReview)).toBe(false);
  });
});

it('shows only the unselected candidate without replacement bindings', async () => {
  const fixture = replacementAdmissionFixture();
  const diagnostics = inspectDerivedDefinition(fixture.definition, fixture.base, fixture.catalog);
  const candidate = diagnostics.plan!.candidates.find((c) => c.executionPath === null)!;
  setup({
    type: 'derived-test',
    derivedRunPlan: diagnostics.plan,
    executionPath: null,
    runListSnapshot: candidate.stepIds,
  });
  const response = await app.request(`/tasks/${TASK}/ports`);
  expect(response.status).toBe(200);
  const body = (await response.json()) as StepPortProjection;
  expect(body.candidates).toHaveLength(1);
  expect(body.candidates[0]!.executionPath).toBeNull();
  expect(body.candidates[0]!.graph.nodes.find((n) => n.id === fixture.payload)!.outputs).toEqual(
    [],
  );
});

it('uses persisted history titles for canvas nodes', async () => {
  const fake = setup();
  fake.insert(schema.taskSteps, {
    id: '00000000-0000-4000-8000-000000000003',
    taskId: TASK,
    stepId: '04-phase-0b-pre-planning',
    title: 'Historical spec title',
    round: 0,
    runSeq: 0,
    stepIndex: 4,
  });
  const response = await app.request(`/tasks/${TASK}/ports`);
  const body = (await response.json()) as StepPortProjection;
  expect(body.candidates[0]!.graph.nodes[0]!.label).toBe('Historical spec title');
});

it('projects the v3 pinned producer and declarations without reconstructing from live tables', async () => {
  const { buildDataEdgePlan } = await import('@haive/shared/data-edge-plan');
  const { dataPortNodes } = await import('@haive/shared/step-ports');
  const nodes = dataPortNodes(['04-phase-0b-pre-planning', '05-phase-0b5-spec-quality']);
  nodes[0]!.id = 'pinned-spec';
  const plan = buildDataEdgePlan('static', [{ executionPath: null, nodes }]);
  const fake = setup({
    dataEdgePlan: plan,
    executionPath: 'quick_bugfix',
    runListSnapshot: nodes.map((n) => n.id),
  });
  const response = await app.request(`/tasks/${TASK}/ports`);
  expect(response.status).toBe(200);
  const projection = (await response.json()) as StepPortProjection;
  expect(projection.candidates[0]!.executionPath).toBe('quick_bugfix');
  const graph = projection.candidates[0]!.graph;
  expect(graph.edges[0]).toMatchObject({
    source: 'pinned-spec',
    target: nodes[1]!.id,
    sourceIndex: 0,
    targetIndex: 1,
  });
  expect(JSON.stringify(graph)).not.toContain('fingerprint');
  delete plan.candidates[0]!.bindings['1:draft'];
  fake.patch(schema.tasks, TASK, { dataEdgePlan: plan });
  expect((await app.request(`/tasks/${TASK}/ports`)).status).toBe(409);
});
