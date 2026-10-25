import { beforeEach, expect, it, vi } from 'vitest';
const USER = vi.hoisted(() => '00000000-0000-4000-8000-0000000000a1');
const h = vi.hoisted(() => ({
  db: undefined as unknown,
  add: vi.fn(async (..._args: unknown[]) => undefined),
}));
vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/queues.js', () => ({ getTaskQueue: () => ({ add: h.add }) }));
vi.mock('../src/middleware/auth.js', () => ({
  requireAuth: async (c: { set(k: string, v: string): void }, next: () => Promise<void>) => {
    c.set('userId', USER);
    await next();
  },
  requireAdmin: async (_c: unknown, next: () => Promise<void>) => next(),
}));
import { Hono } from 'hono';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { configService } from '@haive/shared';
import { validateComposition, type ComposableStepEntry } from '@haive/shared/modularity';
import { taskRoutes } from '../src/routes/tasks/index.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';
const REPO = '00000000-0000-4000-8000-0000000000b1';
const GATE = '11a-gate-4-push';
const entries: ComposableStepEntry[] = [
  {
    stepId: '01-worktree-setup',
    label: 'Worktree',
    group: 'setup',
    dispatchesCli: false,
    requires: [{ needs: 'repository', reason: 'Repository' }],
    provides: ['worktree', 'clean-tree'],
  },
  {
    stepId: '10-gate-3-commit',
    label: 'Commit',
    group: 'finish',
    dispatchesCli: true,
    closes: true,
    requires: [{ needs: 'worktree', reason: 'Worktree' }],
    provides: ['commit', 'clean-tree'],
    precedes: ['learnings'],
  },
  {
    stepId: GATE,
    label: 'Push',
    group: 'finish',
    dispatchesCli: false,
    closes: true,
    requires: ['worktree', 'commit', 'clean-tree'].map((needs) => ({ needs, reason: needs })),
    provides: ['pushed'],
    precedes: ['db-saved'],
  },
];
const app = new Hono<AppEnv>();
app.route('/', taskRoutes);
app.onError(errorHandler);
let fake: ReturnType<typeof createFakeDb>;
function setup(remoteUrl: unknown) {
  fake = createFakeDb({
    tasks: schema.tasks,
    taskEvents: schema.taskEvents,
    repositories: schema.repositories,
    taskTypeDefinitions: schema.taskTypeDefinitions,
    stepCatalog: schema.stepCatalog,
    modules: schema.modules,
    onboardingArtifacts: schema.onboardingArtifacts,
    projectStateConflicts: schema.projectStateConflicts,
  });
  fake.insert(schema.repositories, { id: REPO, userId: USER, name: 'repo', status: 'ready' });
  for (const entry of entries)
    fake.insert(schema.stepCatalog, {
      stepId: entry.stepId,
      source: 'core',
      title: entry.label,
      dispatchesCli: entry.dispatchesCli,
      composable: true,
      entry,
    });
  fake.insert(schema.taskTypeDefinitions, {
    slug: 'credential-push',
    displayName: 'Push',
    source: 'admin',
    enabled: true,
    selectable: true,
    requiresRepository: true,
    runListStrategy: 'static',
    stepIds: entries.map((e) => e.stepId),
    promptSteps: {},
    stepLoopLimitDefaults: {},
    preAnswerDefaults: {
      [GATE]: { push: true, remoteUrl, note: 'keep' },
      '10-gate-3-commit': { message: 'keep arbitrary text', remoteUrl: 'ordinary answer' },
    },
  });
  h.db = fake.db;
}
beforeEach(() => {
  h.add.mockReset();
  vi.spyOn(configService, 'getFresh').mockResolvedValue('normal');
  vi.spyOn(configService, 'getBoolean').mockResolvedValue(true);
});
const create = () =>
  app.request('/', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'credential-push',
      title: 'Task',
      description: 'Do work',
      repositoryId: REPO,
    }),
  });
it.each([
  ['https://fixture-user:fixture-password@example.test:443/repo', 'https://example.test:443/repo'],
  ['ssh://git:fixture-password@example.test:22/repo', 'ssh://git@example.test:22/repo'],
])(
  'normalizes a valid composed custom type preset at actual task creation: case %#',
  async (remoteUrl, expected) => {
    expect(
      validateComposition(
        entries.map((e) => e.stepId),
        new Map(entries.map((e) => [e.stepId, e])),
        { requiresRepository: true },
      ),
    ).toEqual([]);
    setup(remoteUrl);
    const res = await create();
    expect(res.status).toBe(201);
    const task = fake.rows(schema.tasks)[0]!;
    const copied = JSON.stringify({
      task,
      response: await res.json(),
      events: fake.rows(schema.taskEvents),
      jobs: h.add.mock.calls,
    });
    expect(copied.includes('fixture-password')).toBe(false);
    expect(copied.includes('fixture-user')).toBe(false);
    expect(task.preAnswers).toMatchObject({
      [GATE]: { remoteUrl: expected, note: 'keep' },
      '10-gate-3-commit': { remoteUrl: 'ordinary answer', message: 'keep arbitrary text' },
    });
    expect(
      JSON.stringify(fake.rows(schema.taskTypeDefinitions)[0]!.preAnswerDefaults).includes(
        'fixture-password',
      ),
    ).toBe(true);
  },
);
it('refuses invalid gate presets without creating a task, event, job or secret-bearing error', async () => {
  setup('file://fixture-user:fixture-password@example.test/repo');
  const res = await create();
  expect(res.status).toBe(400);
  expect((await res.text()).includes('fixture-password')).toBe(false);
  expect(fake.rows(schema.tasks)).toHaveLength(0);
  expect(fake.rows(schema.taskEvents)).toHaveLength(0);
  expect(h.add).not.toHaveBeenCalled();
});

it.each([
  '',
  null,
  'https://example.test:443/repo',
  'ssh://git@example.test:22/repo',
  'git@example.test:repo',
])('preserves clean and optional custom type gate presets: case %#', async (remoteUrl) => {
  setup(remoteUrl);
  expect((await create()).status).toBe(201);
  expect(
    (fake.rows(schema.tasks)[0]!.preAnswers as Record<string, Record<string, unknown>>)[GATE]
      ?.remoteUrl,
  ).toBe(remoteUrl);
});
