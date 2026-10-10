import { beforeEach, describe, expect, it, vi } from 'vitest';

const USER = vi.hoisted(() => '00000000-0000-4000-8000-0000000000a1');
const TASK = vi.hoisted(() => '00000000-0000-4000-8000-0000000000b1');
const h = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/queues.js', () => ({ getTaskQueue: vi.fn() }));
vi.mock('../src/lib/plan-mirror.js', () => ({
  enqueuePlanMirrorRefresh: vi.fn(),
  pullPlanMirror: vi.fn(),
  savePlanMirror: vi.fn(),
}));
vi.mock('../src/lib/spawn-plan-task.js', () => ({
  spawnPlanTask: vi.fn(async (args: { seed?: (id: string) => Promise<void> }) => {
    await args.seed?.(TASK);
    return TASK;
  }),
}));
vi.mock('../src/middleware/auth.js', () => ({
  requireAuth: async (c: { set: (key: string, value: string) => void }, next: () => unknown) => {
    c.set('userId', USER);
    await next();
  },
  requireAdmin: async (_c: unknown, next: () => unknown) => next(),
}));

import { Hono } from 'hono';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { configService } from '@haive/shared';
import { planRoutes } from '../src/routes/plan.js';
import { spawnPlanTask } from '../src/lib/spawn-plan-task.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';

type Clis = { plannerCliProviderId: string | null; questionerCliProviderId: string | null };
const REPO = '00000000-0000-4000-8000-0000000000c1';
const CLAUDE = '00000000-0000-4000-8000-0000000000e1';
const CODEX = '00000000-0000-4000-8000-0000000000e2';
const OFF = '00000000-0000-4000-8000-0000000000e3';
const app = new Hono<AppEnv>();
app.route('/', planRoutes);
app.onError(errorHandler);

function setup({ withPlan = false } = {}) {
  const fake = createFakeDb({
    repositories: schema.repositories,
    planNodes: schema.planNodes,
    tasks: schema.tasks,
    cliProviders: schema.cliProviders,
    taskStepCliChoices: schema.taskStepCliChoices,
    userStepCliPreferences: schema.userStepCliPreferences,
    userStepCliRolePreferences: schema.userStepCliRolePreferences,
  });
  fake.insert(schema.repositories, { id: REPO, userId: USER, name: 'repo' });
  for (const [id, name, enabled] of [
    [CLAUDE, 'claude-code', true],
    [CODEX, 'codex', true],
    [OFF, 'codex', false],
  ] as const) {
    fake.insert(schema.cliProviders, { id, userId: USER, name, label: name, enabled });
  }
  if (withPlan) {
    fake.insert(schema.planNodes, {
      repositoryId: REPO,
      parentId: null,
      path: '/root/',
      title: 'Root',
      ordinal: 0,
      kind: 'component',
      status: 'todo',
      version: 1,
    });
  }
  h.db = fake.db;
  return fake;
}

const build = (body: Record<string, unknown>) =>
  app.request(`/${REPO}/plan/build`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const metadataOf = () => {
  const calls = vi.mocked(spawnPlanTask).mock.calls;
  return (calls[calls.length - 1]![0] as { metadata: Record<string, unknown> }).metadata;
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(configService, 'get').mockResolvedValue('true');
});

describe('starting a plan build with clarifying questions', () => {
  it('asks by default for a brief and only on request for a knowledge-base build', async () => {
    setup();
    expect((await build({ mode: 'greenfield', description: 'Clubs' })).status).toBe(201);
    expect(metadataOf().planClarify).toBe(true);
    await build({ mode: 'greenfield', description: 'Clubs', clarify: false });
    expect(metadataOf().planClarify).toBeUndefined();
    await build({ mode: 'from_repo' });
    expect(metadataOf().planClarify).toBeUndefined();
    await build({ mode: 'from_repo', clarify: true });
    expect(metadataOf().planClarify).toBe(true);
  });

  it('refuses to ask about a repository that already has a plan', async () => {
    setup({ withPlan: true });
    expect((await build({ mode: 'greenfield', description: 'Clubs' })).status).toBe(409);
    expect(spawnPlanTask).not.toHaveBeenCalled();
    expect((await build({ mode: 'from_repo' })).status).toBe(201);
  });

  it('seeds the questioner seat and remembers it for the next build', async () => {
    const fake = setup();
    await build({
      mode: 'greenfield',
      description: 'Clubs',
      cliProviderId: CLAUDE,
      questionerCliProviderId: CODEX,
    });
    expect(fake.rows(schema.taskStepCliChoices)).toEqual([
      expect.objectContaining({
        taskId: TASK,
        stepId: '00b-plan-clarify',
        role: 'questioner',
        cliProviderId: CODEX,
      }),
    ]);
    const clis = (await (await app.request(`/${REPO}/plan/build/clis`)).json()) as Clis;
    expect(clis.questionerCliProviderId).toBe(CODEX);
  });

  it('refuses a disabled questioner before creating the task', async () => {
    setup();
    const response = await build({
      mode: 'greenfield',
      description: 'Clubs',
      questionerCliProviderId: OFF,
    });
    expect(response.status).toBe(409);
    expect(spawnPlanTask).not.toHaveBeenCalled();
  });

  it('offers the planning CLI as the questioner until one was picked', async () => {
    setup();
    const clis = (await (await app.request(`/${REPO}/plan/build/clis`)).json()) as Clis;
    expect(clis.questionerCliProviderId).toBe(clis.plannerCliProviderId);
    expect(clis.plannerCliProviderId).not.toBeNull();
  });
});

describe('the plan root while a clarifying build is open', () => {
  const ROOT_ID = '00000000-0000-4000-8000-0000000000f1';
  function withOpenBuild(clarify: boolean) {
    const fake = setup();
    fake.insert(schema.planNodes, {
      id: ROOT_ID,
      repositoryId: REPO,
      parentId: null,
      path: `/${ROOT_ID}/`,
      title: 'Root',
      ordinal: 0,
      kind: 'component',
      status: 'todo',
      version: 1,
    });
    fake.insert(schema.tasks, {
      userId: USER,
      repositoryId: REPO,
      type: 'plan_build',
      title: 'Build plan',
      status: 'waiting_user',
      metadata: clarify ? { planBuildMode: 'greenfield', planClarify: true } : {},
    });
    return fake;
  }

  it('refuses to delete the root', async () => {
    const fake = withOpenBuild(true);
    const res = await app.request(`/${REPO}/plan/nodes/${ROOT_ID}`, { method: 'DELETE' });
    expect(res.status).toBe(409);
    expect(fake.rows(schema.planNodes)).toHaveLength(1);
  });

  it('refuses to create a root once the old one is gone', async () => {
    const fake = withOpenBuild(true);
    fake.patch(schema.planNodes, ROOT_ID, { repositoryId: '00000000-0000-4000-8000-0000000000c9' });
    const res = await app.request(`/${REPO}/plan/nodes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Another root' }),
    });
    expect(res.status).toBe(409);
  });

  it('refuses to start a plan chat', async () => {
    withOpenBuild(true);
    const res = await app.request(`/${REPO}/plan/nodes/${ROOT_ID}/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'Split payments out.' }),
    });
    expect(res.status).toBe(409);
    expect(spawnPlanTask).not.toHaveBeenCalled();
  });

  it('leaves the root alone for a build that asks no questions', async () => {
    withOpenBuild(false);
    const res = await app.request(`/${REPO}/plan/nodes/${ROOT_ID}`, { method: 'DELETE' });
    expect(res.status).not.toBe(409);
  });
});
