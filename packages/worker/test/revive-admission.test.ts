import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ONE_LIVE_UPGRADE_INDEX, schema, type Database } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { markTaskRunningWithStep } from '../src/queues/task-queue.js';
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
};

function setup(w: World = {}) {
  const fake = createFakeDb({
    tasks: schema.tasks,
    taskSteps: schema.taskSteps,
    taskEvents: schema.taskEvents,
    cliInvocations: schema.cliInvocations,
    taskStepAgentMinings: schema.taskStepAgentMinings,
    repositories: schema.repositories,
    onboardingArtifacts: schema.onboardingArtifacts,
  });
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
  const resume = () =>
    autoResumeFailedStep(fake.db as unknown as Database, {
      taskId: TASK,
      stepId: STEP,
      round: 0,
      providerId: null,
      via: 'test',
    });
  return { fake, task, events, revive, resume };
}

const admitted = (): World => ({ completedOnboardingAt: new Date(Date.now() - DAY) });

beforeEach(() => vi.clearAllMocks());

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
  const claim = { rootClaimedAt: new Date(), rootClaimKind: 'reset', rootClaimOwner: 'x' };

  it.each([
    ['an onboarding beside a live upgrade', { type: 'onboarding', live: 'onboarding_upgrade' }],
    ['an upgrade beside a live onboarding', { type: 'onboarding_upgrade', live: 'onboarding' }],
  ] as const)('refuses %s', async (_n, c) => {
    const t = setup({ ...admitted(), type: c.type, live: { type: c.live, status: 'running' } });
    expect(await t.resume()).toBe(false);
    expect(t.task()).toMatchObject({ status: 'failed', allowanceAutoResumeCount: 0 });
    expect(t.events().map((e) => e.eventType)).toEqual(['upgrade.revive_refused']);
  });

  it.each(['onboarding', 'onboarding_upgrade'] as const)(
    'refuses a failed %s under a held root claim',
    async (type) => {
      const t = setup({ ...admitted(), type, repo: claim });
      expect(await t.resume()).toBe(false);
      expect(t.task()).toMatchObject({ status: 'failed', allowanceAutoResumeCount: 0 });
      expect(t.events()[0]).toMatchObject({
        eventType: 'upgrade.revive_refused',
        payload: { reason: 'root-claim' },
      });
    },
  );

  it('refuses an upgrade after a reset', async () => {
    const t = setup({
      completedOnboardingAt: new Date(Date.now() - 2 * DAY),
      resetAt: new Date(Date.now() - DAY),
    });
    expect(await t.resume()).toBe(false);
    expect(t.task()).toMatchObject({ status: 'failed', allowanceAutoResumeCount: 0 });
    expect(t.events()[0]).toMatchObject({ payload: { reason: 'reset' } });
  });

  it('answers a unique violation of the one-live-upgrade index as a refusal', async () => {
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
    expect(await t.resume()).toBe(false);
    expect(t.task().status).toBe('failed');
    expect(t.events()[0]).toMatchObject({ payload: { reason: 'live-upgrade-index' } });
  });

  it('drops the watch on a refusal, so the poller does not retry it every tick', async () => {
    const t = setup({
      ...admitted(),
      type: 'onboarding',
      live: { type: 'onboarding_upgrade', status: 'running' },
      task: { awaitingAllowanceProviderId: PROVIDER, awaitingProviderReason: 'rate_limit' },
    });
    expect(await t.resume()).toBe(false);
    expect(t.task()).toMatchObject({
      awaitingAllowanceProviderId: null,
      awaitingProviderReason: null,
    });
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
