import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ONE_LIVE_UPGRADE_INDEX, schema, type Database } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { markTaskRunningWithStep } from '../src/queues/task-queue.js';

vi.mock('../src/db.js', () => ({
  getDb: vi.fn(() => {
    throw new Error('no database in this test');
  }),
}));

const USER = '00000000-0000-4000-8000-0000000000a1';
const REPO = '00000000-0000-4000-8000-0000000000c1';
const TASK = '00000000-0000-4000-8000-000000000001';
const OTHER = '00000000-0000-4000-8000-000000000002';
const STEP = '11d-skill-sync';

function setup(
  type: string,
  other?: { type: string; status: string },
  repo: Record<string, unknown> = {},
) {
  const fake = createFakeDb({
    tasks: schema.tasks,
    taskSteps: schema.taskSteps,
    taskEvents: schema.taskEvents,
    repositories: schema.repositories,
    onboardingArtifacts: schema.onboardingArtifacts,
  });
  fake.insert(schema.repositories, {
    id: REPO,
    userId: USER,
    name: 'repo',
    status: 'ready',
    ...repo,
  });
  fake.insert(schema.tasks, {
    id: TASK,
    userId: USER,
    repositoryId: REPO,
    type,
    title: type,
    status: 'failed',
    errorMessage: 'boom',
    orchestrationEpoch: 3,
    currentStepId: STEP,
    completedAt: fake.now(),
  });
  if (type === 'onboarding_upgrade') {
    fake.insert(schema.tasks, {
      id: '00000000-0000-4000-8000-000000000003',
      userId: USER,
      repositoryId: REPO,
      type: 'onboarding',
      title: 'onboarded',
      status: 'completed',
      completedAt: fake.now(),
    });
  }
  if (other) {
    fake.insert(schema.tasks, {
      id: OTHER,
      userId: USER,
      repositoryId: REPO,
      type: other.type,
      title: other.type,
      status: other.status,
    });
  }
  const task = () => fake.rows(schema.tasks).find((r) => r.id === TASK)!;
  const events = () => fake.rows(schema.taskEvents).map((r) => r.eventType);
  const revive = (reviveFailed = true) =>
    markTaskRunningWithStep(fake.db as unknown as Database, TASK, STEP, 1, 0, {
      epoch: 3,
      reviveFailed,
    });
  return { fake, task, events, revive };
}

beforeEach(() => vi.clearAllMocks());

describe('the worker reviving a failed onboarding or upgrade', () => {
  it.each([
    ['an onboarding', 'onboarding', 'onboarding_upgrade'],
    ['an upgrade', 'onboarding_upgrade', 'onboarding'],
  ])('refuses %s beside a live opposing task and leaves it failed', async (_n, type, otherType) => {
    for (const status of ['created', 'queued', 'running', 'waiting_user']) {
      const t = setup(type, { type: otherType, status });
      expect(await t.revive()).toBe(false);
      expect(t.task()).toMatchObject({ status: 'failed', errorMessage: 'boom' });
      expect(t.events()).toEqual(['upgrade.revive_refused']);
    }
  });

  it.each(['onboarding', 'onboarding_upgrade'])(
    'refuses a failed %s while the root claim is held',
    async (type) => {
      const t = setup(type, undefined, {
        rootClaimedAt: new Date(),
        rootClaimKind: 'reset',
        rootClaimOwner: 'x',
      });
      expect(await t.revive()).toBe(false);
      expect(t.task()).toMatchObject({ status: 'failed', errorMessage: 'boom' });
      expect(t.events()).toEqual(['upgrade.revive_refused']);
    },
  );

  it.each([
    ['onboarding', undefined],
    ['onboarding', { type: 'onboarding_upgrade', status: 'completed' }],
    ['onboarding_upgrade', undefined],
    ['onboarding_upgrade', { type: 'onboarding', status: 'failed' }],
    ['onboarding_upgrade', { type: 'onboarding_upgrade', status: 'completed' }],
  ])('revives a failed %s with nothing opposing it (%j)', async (type, other) => {
    const t = setup(type, other);
    expect(await t.revive()).toBe(true);
    expect(t.task()).toMatchObject({ status: 'running', errorMessage: null });
    expect(t.events()).toEqual([]);
  });

  it('revives a stale root claim', async () => {
    const t = setup('onboarding', undefined, {
      rootClaimedAt: new Date(Date.now() - 3_600_000),
      rootClaimKind: 'reset',
      rootClaimOwner: 'x',
    });
    expect(await t.revive()).toBe(true);
  });

  it('does not hold a task of another type', async () => {
    const t = setup('workflow', { type: 'onboarding_upgrade', status: 'running' });
    expect(await t.revive()).toBe(true);
  });

  it('checks nothing for a write that is not a revival', async () => {
    const t = setup('onboarding', { type: 'onboarding_upgrade', status: 'running' });
    expect(await t.revive(false)).toBe(false);
    expect(t.task().status).toBe('failed');
    expect(t.events()).toEqual([]);
  });

  it('still reports the index refusal as before', async () => {
    const t = setup('onboarding_upgrade');
    t.fake.hooks.beforeUpdate = async (table) => {
      if (table === schema.tasks) {
        throw Object.assign(new Error('duplicate key'), {
          code: '23505',
          constraint_name: ONE_LIVE_UPGRADE_INDEX,
        });
      }
    };
    expect(await t.revive()).toBe(false);
    expect(t.task().status).toBe('failed');
    expect(t.events()).toEqual(['upgrade.revive_refused']);
  });
});
