import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ONE_LIVE_UPGRADE_INDEX, schema, type Database } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { markTaskRunningWithStep, markTaskWaiting } from '../src/queues/task-queue.js';

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
  status = 'failed',
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
    status,
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
  const reviveUnfenced = () =>
    markTaskRunningWithStep(fake.db as unknown as Database, TASK, STEP, 1, 0);
  const park = (fence?: { epoch: number; reviveFailed?: boolean }) =>
    markTaskWaiting(fake.db as unknown as Database, TASK, STEP, 1, 0, 'waiting_user', fence);
  return { fake, task, events, revive, reviveUnfenced, park };
}

beforeEach(() => vi.clearAllMocks());

describe('the worker reviving a failed onboarding or upgrade', () => {
  it.each([
    ['an onboarding', 'onboarding', 'onboarding_upgrade'],
    ['an upgrade', 'onboarding_upgrade', 'onboarding'],
    ['an onboarding', 'onboarding', 'onboarding'],
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

  it('checks nothing for a task that is already live, whatever holds the repository', async () => {
    const t = setup(
      'onboarding',
      { type: 'onboarding_upgrade', status: 'running' },
      { rootClaimedAt: new Date(), rootClaimKind: 'reset', rootClaimOwner: 'x' },
      'running',
    );
    expect(await t.reviveUnfenced()).toBe(true);
    expect(t.events()).toEqual([]);
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

  it.each([
    ['a write with no fence', (t: ReturnType<typeof setup>) => t.reviveUnfenced()],
    ['a park with no fence', (t: ReturnType<typeof setup>) => t.park()],
    [
      'a park that may revive',
      (t: ReturnType<typeof setup>) => t.park({ epoch: 3, reviveFailed: true }),
    ],
  ])('refuses %s beside a live upgrade', async (_n, write) => {
    const t = setup('onboarding', { type: 'onboarding_upgrade', status: 'running' });
    expect(await write(t)).toBe(false);
    expect(t.task()).toMatchObject({ status: 'failed', errorMessage: 'boom' });
    expect(t.events()).toEqual(['upgrade.revive_refused']);
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
