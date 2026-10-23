import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/queues.js', () => ({ getTaskQueue: () => ({ add: async () => undefined }) }));

import { lockRepositoryTasksKey, schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { markQueuedForStart } from '../src/lib/task-start.js';

const USER = '00000000-0000-4000-8000-0000000000a1';
const REPO = '00000000-0000-4000-8000-0000000000c1';
const OTHER_REPO = '00000000-0000-4000-8000-0000000000c2';
const TASK = '00000000-0000-4000-8000-000000000001';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function world(repositoryId: string | null) {
  const fake = createFakeDb({ tasks: schema.tasks });
  fake.insert(schema.tasks, {
    id: TASK,
    userId: USER,
    type: 'plan_build',
    title: 't',
    repositoryId,
    status: 'created',
  });
  const status = () => fake.rows(schema.tasks).find((r) => r.id === TASK)?.status;

  /** A checkout move: a fake transaction that takes REPO's task-creation lock and keeps it until released. */
  const move = async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let taken!: () => void;
    const locked = new Promise<void>((resolve) => (taken = resolve));
    const done = fake.db.transaction(async (tx) => {
      await lockRepositoryTasksKey(tx as never, REPO);
      taken();
      await gate;
    });
    await Promise.race([locked, done]);
    return { release, done };
  };
  return { fake, status, move };
}

describe('markQueuedForStart beside a checkout move', () => {
  it('L1: queues a task of the repository only once the move holding its task-creation lock ends', async () => {
    const { fake, status, move } = world(REPO);
    const moving = await move();
    let settled = false;
    const start = markQueuedForStart(fake.db as never, TASK);
    void start.then(
      () => (settled = true),
      () => (settled = true),
    );
    try {
      await sleep(50);
      expect(settled).toBe(false);
      expect(status()).toBe('created');
    } finally {
      moving.release();
      await moving.done;
    }
    expect(await start).toMatchObject({ id: TASK, status: 'queued' });
    expect(status()).toBe('queued');
  });

  it.each([
    ['a task with no repository', null],
    ['a task of another repository', OTHER_REPO],
  ])('L2: queues %s while the move holds the lock', async (_name, repositoryId) => {
    const { fake, status, move } = world(repositoryId);
    const moving = await move();
    try {
      expect(await markQueuedForStart(fake.db as never, TASK)).toMatchObject({
        id: TASK,
        status: 'queued',
      });
      expect(status()).toBe('queued');
    } finally {
      moving.release();
      await moving.done;
    }
  });

  it('L3: inside a transaction, keeps the lock until that transaction ends, as the create path needs', async () => {
    const { fake, status } = world(REPO);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let queued!: () => void;
    const reached = new Promise<void>((resolve) => (queued = resolve));
    const creating = fake.db.transaction(async (tx) => {
      await markQueuedForStart(tx as never, TASK);
      queued();
      await gate;
    });
    await Promise.race([reached, creating]);
    let moved = false;
    const moving = fake.db
      .transaction((tx) => lockRepositoryTasksKey(tx as never, REPO))
      .then(() => (moved = true));
    try {
      await sleep(50);
      expect(moved).toBe(false);
    } finally {
      release();
      await creating;
    }
    await moving;
    expect(status()).toBe('queued');
  });

  it('L4: answers 409 busy when the task-creation lock times out', async () => {
    const { fake, status } = world(REPO);
    fake.hooks.beforeLock = () => {
      throw Object.assign(new Error('Failed query'), {
        cause: Object.assign(new Error('canceling statement due to lock timeout'), {
          code: '55P03',
        }),
      });
    };
    const err = await markQueuedForStart(fake.db as never, TASK).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 409, message: 'The repository is busy, try again' });
    expect(status()).toBe('created');
  });
});
