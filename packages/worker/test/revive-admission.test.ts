import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ONE_LIVE_UPGRADE_INDEX, schema, type Database } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { configService } from '@haive/shared';
import { markTaskRunningWithStep } from '../src/queues/task-queue.js';
import { RevivalBusy } from '../src/queues/_revive-check.js';
import { autoResumeFailedStep } from '../src/queues/_step-reset.js';

vi.mock('../src/db.js', () => ({
  getDb: vi.fn(() => {
    throw new Error('no database in this test');
  }),
}));

const USER = '00000000-0000-4000-8000-0000000000a1';
const REPO = '00000000-0000-4000-8000-0000000000c1';
const TASK = '00000000-0000-4000-8000-000000000001';
const OTHER = '00000000-0000-4000-8000-000000000002';
const DONE_ONBOARDING = '00000000-0000-4000-8000-000000000003';
const PROVIDER = '00000000-0000-4000-8000-0000000000f1';
const ROW = '00000000-0000-4000-8000-0000000000d1';
const STEP = '02-upgrade-apply';
const DAY = 86_400_000;

type World = {
  type?: 'onboarding' | 'onboarding_upgrade';
  resetAt?: Date | null;
  completedOnboardingAt?: Date | null;
  live?: { type: string; status: string };
  repo?: Record<string, unknown>;
  task?: Record<string, unknown>;
  conflicts?: string[];
};

function setup(w: World = {}) {
  const fake = createFakeDb({
    modules: schema.modules,
    tasks: schema.tasks,
    taskSteps: schema.taskSteps,
    taskEvents: schema.taskEvents,
    cliInvocations: schema.cliInvocations,
    taskStepAgentMinings: schema.taskStepAgentMinings,
    repositories: schema.repositories,
    onboardingArtifacts: schema.onboardingArtifacts,
    projectStateConflicts: schema.projectStateConflicts,
  });
  for (const unit of w.conflicts ?? []) {
    fake.insert(schema.projectStateConflicts, {
      repositoryId: REPO,
      unit,
      base: { v: 1 },
      local: { v: 2 },
      incoming: { v: 3 },
    });
  }
  fake.insert(schema.repositories, {
    id: REPO,
    userId: USER,
    name: 'repo',
    status: 'ready',
    onboardingResetAt: w.resetAt ?? null,
    ...w.repo,
  });
  fake.insert(schema.tasks, {
    id: TASK,
    userId: USER,
    repositoryId: REPO,
    type: w.type ?? 'onboarding_upgrade',
    title: 'failed',
    status: 'failed',
    errorMessage: 'boom',
    orchestrationEpoch: 3,
    currentStepId: STEP,
    completedAt: fake.now(),
    allowanceAutoResumeCount: 0,
    awaitingAllowanceProviderId: null,
    ...w.task,
  });
  fake.insert(schema.taskSteps, {
    id: ROW,
    taskId: TASK,
    stepId: STEP,
    round: 0,
    status: 'failed',
    errorMessage: 'boom',
  });
  if (w.completedOnboardingAt !== undefined) {
    fake.insert(schema.tasks, {
      id: DONE_ONBOARDING,
      userId: USER,
      repositoryId: REPO,
      type: 'onboarding',
      title: 'done',
      status: 'completed',
      completedAt: w.completedOnboardingAt,
    });
  }
  if (w.live) {
    fake.insert(schema.tasks, {
      id: OTHER,
      userId: USER,
      repositoryId: REPO,
      type: w.live.type,
      title: w.live.type,
      status: w.live.status,
    });
  }
  const task = () => fake.rows(schema.tasks).find((r) => r.id === TASK)!;
  const events = () => fake.rows(schema.taskEvents);
  const revive = () =>
    markTaskRunningWithStep(fake.db as unknown as Database, TASK, STEP, 1, 0, {
      epoch: 3,
      reviveFailed: true,
    });
  const resume = (polledSince?: Date) =>
    autoResumeFailedStep(fake.db as unknown as Database, {
      taskId: TASK,
      stepId: STEP,
      round: 0,
      providerId: null,
      via: 'test',
      watchSince: polledSince ?? (task().awaitingProviderSince as Date | null | undefined) ?? null,
    });
  return { fake, task, events, revive, resume };
}

const admitted = (): World => ({ completedOnboardingAt: new Date(Date.now() - DAY) });

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(configService, 'getFresh').mockResolvedValue('normal');
});

describe('the worker reviving a failed upgrade runs the reset admission', () => {
  it('refuses an upgrade a reset cut off between the answer and the pickup', async () => {
    const t = setup({
      completedOnboardingAt: new Date(Date.now() - 2 * DAY),
      resetAt: new Date(Date.now() - DAY),
    });
    expect(await t.revive()).toBe(false);
    expect(t.task()).toMatchObject({ status: 'failed', errorMessage: 'boom' });
    expect(t.events()).toHaveLength(1);
    expect(t.events()[0]).toMatchObject({
      eventType: 'upgrade.revive_refused',
      payload: { reason: 'reset' },
    });
  });

  it('refuses an upgrade on a repository with no onboarding at all', async () => {
    const t = setup();
    expect(await t.revive()).toBe(false);
    expect(t.task().status).toBe('failed');
    expect(t.events()[0]).toMatchObject({ payload: { reason: 'none' } });
  });

  it('refuses an upgrade while a project state conflict is pending, and says why', async () => {
    const t = setup({ ...admitted(), conflicts: ['project/render.json#acceptedAgentIds'] });
    expect(await t.revive()).toBe(false);
    expect(t.task()).toMatchObject({ status: 'failed', errorMessage: 'boom' });
    expect(t.events()).toHaveLength(1);
    expect(t.events()[0]).toMatchObject({
      eventType: 'upgrade.revive_refused',
      payload: { reason: 'contested' },
    });
  });

  it('does not hold an onboarding for it', async () => {
    const t = setup({ type: 'onboarding', conflicts: ['project/render.json#framework'] });
    expect(await t.revive()).toBe(true);
  });

  it('revives when no reset intervened', async () => {
    const t = setup(admitted());
    expect(await t.revive()).toBe(true);
    expect(t.task()).toMatchObject({ status: 'running', errorMessage: null });
    expect(t.events()).toEqual([]);
  });

  it('revives when an onboarding finished after the reset', async () => {
    const t = setup({
      completedOnboardingAt: new Date(Date.now() - DAY),
      resetAt: new Date(Date.now() - 2 * DAY),
    });
    expect(await t.revive()).toBe(true);
  });

  it('does not ask the admission of an onboarding', async () => {
    const t = setup({ type: 'onboarding', resetAt: new Date() });
    expect(await t.revive()).toBe(true);
  });
});

describe('the allowance auto-resume of a failed onboarding or upgrade', () => {
  it.each([
    {
      reason: 'root-claim',
      world: { ...admitted(), repo: { rootClaimedAt: new Date(), rootClaimKind: 'reset' } },
    },
    {
      reason: 'live-upgrade',
      world: {
        ...admitted(),
        type: 'onboarding',
        live: { type: 'onboarding_upgrade', status: 'running' },
      },
    },
    {
      reason: 'live-onboarding',
      world: { ...admitted(), live: { type: 'onboarding', status: 'running' } },
    },
    {
      reason: 'reset',
      world: {
        completedOnboardingAt: new Date(Date.now() - 2 * DAY),
        resetAt: new Date(Date.now() - DAY),
      },
    },
    { reason: 'none', world: {} },
    { reason: 'contested', world: { ...admitted(), conflicts: ['project/render.json#framework'] } },
  ] as { reason: string; world: World }[])(
    'keeps $reason retryable after the allowance recovers',
    async ({ reason, world }) => {
      const since = new Date(Date.now() - DAY);
      const t = setup({
        ...world,
        task: {
          awaitingAllowanceProviderId: PROVIDER,
          awaitingProviderReason: 'rate_limit',
          awaitingProviderSince: since,
        },
      });
      await expect(t.resume()).rejects.toMatchObject({ name: 'RevivalBusy', cause: { reason } });
      expect(t.task()).toMatchObject({
        status: 'failed',
        allowanceAutoResumeCount: 0,
        awaitingAllowanceProviderId: PROVIDER,
        awaitingProviderSince: since,
      });
      expect(t.task().allowanceReplenishedAt ?? null).toBeNull();
      expect(t.events()).toEqual([]);
    },
  );

  it('keeps a one-live-upgrade index refusal retryable', async () => {
    const t = setup(admitted());
    let thrown = false;
    t.fake.hooks.beforeUpdate = async (table) => {
      if (table === schema.tasks && !thrown) {
        thrown = true;
        throw Object.assign(new Error('duplicate key'), {
          code: '23505',
          constraint_name: ONE_LIVE_UPGRADE_INDEX,
        });
      }
    };
    await expect(t.resume()).rejects.toBeInstanceOf(RevivalBusy);
    expect(t.task().status).toBe('failed');
    expect(t.events()).toEqual([]);
    expect(await t.resume()).toBe(true);
  });

  it.each(['onboarding', 'onboarding_upgrade'] as const)(
    'resumes a failed %s with nothing opposing it, as before',
    async (type) => {
      const t = setup({ ...admitted(), type });
      expect(await t.resume()).toBe(true);
      expect(t.task()).toMatchObject({ status: 'running', allowanceAutoResumeCount: 1 });
      expect(t.events().map((e) => e.eventType)).toEqual(['task.auto_resumed']);
    },
  );
});
