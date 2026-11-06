import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabase, schema, type Database } from '@haive/database';

const url = process.env.STOP_SETTLE_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/stop_settle_test'))
  throw new Error('Use a dedicated stop_settle_test database for the stop settle tests');

const OWNER = '00000000-0000-4000-8000-0000000000b1';
const OTHER_OWNER = '00000000-0000-4000-8000-0000000000b2';
const ADMIN = '00000000-0000-4000-8000-0000000000b3';
const BLIND_PREFIX = 'stop-settle-test-user-';
const SETTLE = 'settle-stopped-task';
const STEP = '07-phase-2-implement';
const MODULE_STEP = 'module.alpha.x';

type Queued = {
  name: string;
  payload: Record<string, unknown>;
  opts: unknown;
  /** Sandbox kills already made when `add` ran. */
  kills: number;
  /** The task row as another connection read it while `add` ran: only committed data shows. */
  task: typeof schema.tasks.$inferSelect | undefined;
  /** task.stopped events of the task visible while `add` ran. */
  stoppedEvents: number;
};

const h = vi.hoisted(() => ({
  db: undefined as unknown,
  peer: undefined as unknown,
  session: '' as string,
  addMode: 'ok' as 'ok' | 'fail' | 'hang',
  addCalls: 0,
  queued: [] as unknown[],
  kills: [] as string[],
  killError: false,
  eventFails: false,
}));
const queued = () => h.queued as Queued[];
const settleJobs = () => queued().filter((q) => q.name === SETTLE);

vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/queues.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/queues.js')>();
  return {
    ...original,
    getTaskQueue: () => ({
      add: async (name: string, payload: Record<string, unknown>, opts: unknown) => {
        h.addCalls += 1;
        const peer = h.peer as Database;
        const taskId = payload.taskId as string;
        const task = await peer.query.tasks.findFirst({ where: eq(schema.tasks.id, taskId) });
        const events = await peer.query.taskEvents.findMany({
          where: and(
            eq(schema.taskEvents.taskId, taskId),
            eq(schema.taskEvents.eventType, 'task.stopped'),
          ),
        });
        h.queued.push({
          name,
          payload,
          opts,
          kills: h.kills.length,
          task,
          stoppedEvents: events.length,
        });
        if (h.addMode === 'fail') throw new Error('redis down');
        if (h.addMode === 'hang') await new Promise(() => undefined);
      },
    }),
  };
});
vi.mock('../src/lib/sandbox-kill.js', () => ({
  killTaskSandboxes: async (taskId: string) => {
    h.kills.push(taskId);
    return 0;
  },
  killTaskSandboxesOrThrow: async (taskId: string) => {
    h.kills.push(taskId);
    if (h.killError) throw new Error('sandbox removal failed');
    return 0;
  },
}));
vi.mock('../src/routes/tasks/_helpers.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/routes/tasks/_helpers.js')>();
  return {
    ...original,
    appendTaskEvent: async (...args: Parameters<typeof original.appendTaskEvent>) => {
      if (h.eventFails && args[3] === 'task.stopped') throw new Error('event refused');
      return original.appendTaskEvent(...args);
    },
  };
});
vi.mock('../src/middleware/auth.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/middleware/auth.js')>()),
  requireAuth: async (c: { set: (key: string, value: string) => void }, next: () => unknown) => {
    c.set('userId', h.session);
    await next();
  },
  requireAdmin: async (_c: unknown, next: () => unknown) => next(),
}));
vi.mock('@haive/shared', async (importOriginal) => {
  const shared = await importOriginal<typeof import('@haive/shared')>();
  return {
    ...shared,
    configService: {
      get: async () => null,
      getBoolean: async () => false,
      getFresh: async (key: string) =>
        key === shared.CONFIG_KEYS.MAINTENANCE_STATE ? 'normal' : null,
      set: async () => undefined,
    },
  };
});

import { Hono } from 'hono';
import { taskRoutes } from '../src/routes/tasks/index.js';
import { maintenanceRoutes } from '../src/routes/maintenance.js';
import { deactivateUrgently } from '../src/modules/activation.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';

const app = new Hono<AppEnv>();
app.route('/tasks', taskRoutes);
app.route('/admin/maintenance', maintenanceRoutes);
app.onError(errorHandler);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const sorted = (keys: string[]) => [...keys].sort();
const OWNER_BODY_KEYS = ['cancelled', 'killed', 'ok', 'stopped'];
const ADMIN_BODY_KEYS = ['cancelled', 'failedAt', 'killed', 'ok', 'stopped'];

describe.skipIf(!url)('settling a task right after an api Stop, on Postgres', () => {
  let db: Database;
  let peer: Database;

  const post = (path: string, body?: unknown) =>
    app.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
  const ownerStop = async (taskId: string) => {
    h.session = OWNER;
    const res = await post(`/tasks/${taskId}/cancel-active-cli`);
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  const adminStop = async (taskId: string) => {
    h.session = ADMIN;
    const res = await post(`/admin/maintenance/tasks/${taskId}/action`, { action: 'stop' });
    return {
      status: res.status,
      body: (await res.json().catch(() => null)) as Record<string, unknown> | null,
    };
  };
  /** Resolves with the answer, or 'hung' when the route has not answered after `ms`. */
  const within = <T>(ms: number, run: Promise<T>) =>
    Promise.race([run, sleep(ms).then(() => 'hung' as const)]);

  const seedTask = async (
    status: (typeof schema.tasks.$inferInsert)['status'],
    over: Partial<typeof schema.tasks.$inferInsert> = {},
  ) => {
    const [row] = await db
      .insert(schema.tasks)
      .values({
        userId: OWNER,
        type: 'workflow',
        title: 'stop-settle',
        status,
        currentStepId: STEP,
        currentRound: 0,
        orchestrationEpoch: 3,
        ...over,
      })
      .returning();
    return row!;
  };
  /** A step waiting on a CLI and the live run behind it. */
  const seedLiveRun = async (taskId: string, stepId = STEP) => {
    const [step] = await db
      .insert(schema.taskSteps)
      .values({
        taskId,
        stepId,
        stepIndex: 7,
        round: 0,
        title: stepId,
        status: 'waiting_cli',
        startedAt: new Date(),
      })
      .returning();
    await db.insert(schema.cliInvocations).values({
      taskId,
      taskStepId: step!.id,
      mode: 'cli',
      prompt: 'p',
      startedAt: new Date(),
    });
  };
  const taskOf = async (id: string) =>
    (await db.query.tasks.findFirst({ where: eq(schema.tasks.id, id) }))!;
  const failedAtOf = async (id: string) => (await taskOf(id)).completedAt!.getTime();

  beforeAll(async () => {
    db = createDatabase(url as string);
    peer = createDatabase(url as string);
    h.db = db;
    h.peer = peer;
    await clean();
    for (const [id, name] of [
      [OWNER, 'owner'],
      [OTHER_OWNER, 'other'],
      [ADMIN, 'admin'],
    ] as const) {
      await db.insert(schema.users).values({
        id,
        emailEncrypted: `stop-settle-${name}@test.local`,
        emailBlindIndex: `${BLIND_PREFIX}${name}`,
        passwordHash: 'not-real',
        role: name === 'admin' ? 'admin' : 'user',
      });
    }
    await db.insert(schema.modules).values({
      moduleId: 'alpha',
      packageName: '@haive/module-alpha',
      name: 'alpha',
      installedVersion: '1.0.0',
    });
  });

  async function clean() {
    await db.delete(schema.tasks).where(inArray(schema.tasks.userId, [OWNER, OTHER_OWNER]));
    await db
      .delete(schema.auditEvents)
      .where(inArray(schema.auditEvents.actorUserId, [ADMIN, OWNER, OTHER_OWNER]));
    await db.delete(schema.modules).where(eq(schema.modules.moduleId, 'alpha'));
    await db.delete(schema.users).where(inArray(schema.users.id, [OWNER, OTHER_OWNER, ADMIN]));
  }

  beforeEach(async () => {
    h.queued = [];
    h.kills = [];
    h.addMode = 'ok';
    h.addCalls = 0;
    h.killError = false;
    h.eventFails = false;
    await db.delete(schema.tasks).where(inArray(schema.tasks.userId, [OWNER, OTHER_OWNER]));
  });

  afterAll(async () => {
    await clean();
    await db.$client.end({ timeout: 5 });
    await peer.$client.end({ timeout: 5 });
  });

  it('R1: an owner Stop queues one settle job for the committed failure, after the sandbox kill', async () => {
    const task = await seedTask('running');
    await seedLiveRun(task.id);

    const { status, body } = await ownerStop(task.id);

    expect(status).toBe(200);
    expect(sorted(Object.keys(body))).toEqual(OWNER_BODY_KEYS);
    expect(body).toMatchObject({ ok: true, cancelled: 1, stopped: 1 });
    expect((await taskOf(task.id)).status).toBe('failed');
    expect(h.kills).toEqual([task.id]);

    expect(queued().map((q) => q.name)).toEqual([SETTLE]);
    const job = queued()[0]!;
    expect(Object.keys(job.payload).sort()).toEqual(['failedAt', 'taskId', 'userId']);
    expect(job.payload.taskId).toBe(task.id);
    expect(job.payload.userId).toBe(OWNER);
    expect(Date.parse(job.payload.failedAt as string)).toBe(await failedAtOf(task.id));
    expect(job.task?.status, 'task row as read while add ran').toBe('failed');
    expect(job.kills, 'sandbox kills made before add ran').toBe(1);
  });

  describe('R2: a Stop that failed nothing queues nothing', () => {
    it('R2: a running task with no live run and no failable step', async () => {
      const task = await seedTask('running', { currentStepId: null });
      const res = await ownerStop(task.id);
      expect(res.body).toMatchObject({ ok: true, cancelled: 0, stopped: 0 });
      expect((await taskOf(task.id)).status).toBe('running');
      expect(h.addCalls).toBe(0);
      expect(queued()).toEqual([]);
    });

    it('R2: a second Stop of the same task queues none and leaves the first job valid', async () => {
      const task = await seedTask('running');
      await seedLiveRun(task.id);
      expect((await ownerStop(task.id)).body).toMatchObject({ stopped: 1 });
      expect(settleJobs()).toHaveLength(1);

      const second = await ownerStop(task.id);

      expect(second.body).toMatchObject({ ok: true, cancelled: 0, stopped: 0 });
      expect(settleJobs()).toHaveLength(1);
      expect(Date.parse(settleJobs()[0]!.payload.failedAt as string)).toBe(
        await failedAtOf(task.id),
      );
    });

    it.each(['completed', 'cancelled', 'failed'] as const)(
      'R2: a %s task that still holds a live run',
      async (status) => {
        const task = await seedTask(status, { completedAt: new Date('2026-10-01T00:00:00.000Z') });
        await seedLiveRun(task.id);

        const res = await ownerStop(task.id);

        expect(res.body).toMatchObject({ ok: true, cancelled: 1 });
        expect((await taskOf(task.id)).status).toBe(status);
        expect(queued()).toEqual([]);
      },
    );

    it('R2: the Cancel action queues no settle job', async () => {
      const task = await seedTask('running');
      await seedLiveRun(task.id);
      h.session = OWNER;

      const res = await post(`/tasks/${task.id}/action`, { action: 'cancel' });

      expect(res.status).toBe(200);
      expect((await taskOf(task.id)).status).toBe('cancelled');
      expect(settleJobs()).toEqual([]);
    });
  });

  it('R3: an admin stop queues the job for the task owner, never the admin, before the event is written', async () => {
    const task = await seedTask('running');
    await seedLiveRun(task.id);

    const { status, body } = await adminStop(task.id);

    expect(status).toBe(200);
    expect(sorted(Object.keys(body!))).toEqual(ADMIN_BODY_KEYS);
    expect(body).toMatchObject({ ok: true, cancelled: 1, stopped: 1 });
    const completedAt = await failedAtOf(task.id);
    expect(body!.failedAt).toBe(new Date(completedAt).toISOString());

    expect(queued().map((q) => q.name)).toEqual([SETTLE]);
    const job = queued()[0]!;
    expect(job.payload.taskId).toBe(task.id);
    expect(job.payload.userId).toBe(OWNER);
    expect(job.payload.userId).not.toBe(ADMIN);
    expect(Date.parse(job.payload.failedAt as string)).toBe(completedAt);
    expect(job.task?.status, 'task row as read while add ran').toBe('failed');
    expect(job.kills).toBe(1);
    expect(job.stoppedEvents, 'task.stopped events written before add ran').toBe(0);
    const events = await db.query.taskEvents.findMany({
      where: and(
        eq(schema.taskEvents.taskId, task.id),
        eq(schema.taskEvents.eventType, 'task.stopped'),
      ),
    });
    expect(events).toHaveLength(1);
  });

  it('R3: an admin stop of a task it did not fail queues nothing', async () => {
    const task = await seedTask('failed', { completedAt: new Date('2026-10-01T00:00:00.000Z') });
    await seedLiveRun(task.id);

    const { body } = await adminStop(task.id);

    expect(body).toMatchObject({ ok: true, cancelled: 1, failedAt: null });
    expect(queued()).toEqual([]);
  });

  it('R4: an admin stop queues the job even when appending the task.stopped event throws', async () => {
    h.eventFails = true;
    const task = await seedTask('running');
    await seedLiveRun(task.id);

    await adminStop(task.id);

    expect((await taskOf(task.id)).status).toBe('failed');
    expect(settleJobs()).toHaveLength(1);
    expect(settleJobs()[0]!.payload.userId).toBe(OWNER);
    expect(settleJobs()[0]!.payload.taskId).toBe(task.id);
  });

  describe('R5: urgent module deactivation', () => {
    const dependent = async (owner: string, over: Partial<typeof schema.tasks.$inferInsert>) =>
      seedTask('running', {
        userId: owner,
        currentStepId: MODULE_STEP,
        runListSnapshot: [MODULE_STEP],
        ...over,
      });

    const seedFour = async () => {
      const a = await dependent(OWNER, { title: 'A' });
      await seedLiveRun(a.id, MODULE_STEP);
      const b = await dependent(OTHER_OWNER, { title: 'B' });
      await seedLiveRun(b.id, MODULE_STEP);
      // Stopped but not failed: a paused task is not one of the statuses the Stop moves to failed.
      const c = await dependent(OWNER, { title: 'C', status: 'paused' });
      await seedLiveRun(c.id, MODULE_STEP);
      // Nothing to stop at all.
      const d = await dependent(OTHER_OWNER, { title: 'D' });
      return { a, b, c, d };
    };

    it('R5: one job per stopped task with its own owner, none for a task the Stop did not fail', async () => {
      const { a, b, c, d } = await seedFour();

      const result = await deactivateUrgently(db, 'alpha', ADMIN);

      expect(result.kind).toBe('ok');
      if (result.kind !== 'ok') return;
      expect(sorted(result.stopped.map((s) => s.id))).toEqual(sorted([a.id, b.id, c.id]));
      expect(result.left.map((l) => l.id)).toEqual([d.id]);
      expect((await taskOf(a.id)).status).toBe('failed');
      expect((await taskOf(b.id)).status).toBe('failed');
      expect((await taskOf(c.id)).status).toBe('paused');

      const jobs = settleJobs();
      expect(queued().map((q) => q.name)).toEqual(jobs.map(() => SETTLE));
      const byTask = new Map(jobs.map((j) => [j.payload.taskId as string, j.payload]));
      expect([...byTask.keys()].sort()).toEqual(sorted([a.id, b.id]));
      expect(jobs).toHaveLength(2);
      expect(byTask.get(a.id)!.userId).toBe(OWNER);
      expect(byTask.get(b.id)!.userId).toBe(OTHER_OWNER);
      expect(Date.parse(byTask.get(a.id)!.failedAt as string)).toBe(await failedAtOf(a.id));
      expect(Date.parse(byTask.get(b.id)!.failedAt as string)).toBe(await failedAtOf(b.id));
    });

    it('R5: the jobs are queued even when the sandbox kill reports an error', async () => {
      h.killError = true;
      const { a, b } = await seedFour();

      const result = await deactivateUrgently(db, 'alpha', ADMIN);

      expect(result.kind).toBe('ok');
      if (result.kind !== 'ok') return;
      expect(result.stopped.filter((s) => s.killError !== undefined).length).toBe(3);
      expect(
        settleJobs()
          .map((j) => [j.payload.taskId, j.payload.userId])
          .sort(),
      ).toEqual(
        [
          [a.id, OWNER],
          [b.id, OTHER_OWNER],
        ].sort(),
      );
    });
  });

  describe('R6: a queue that refuses or hangs does not change the answer of a Stop', () => {
    const seedStoppable = async () => {
      const task = await seedTask('running');
      await seedLiveRun(task.id);
      return task;
    };

    it('R6: add rejects, owner and admin Stop still answer as they do when it works', async () => {
      h.addMode = 'fail';
      const first = await seedStoppable();
      const owner = await ownerStop(first.id);
      const second = await seedStoppable();
      const admin = await adminStop(second.id);

      expect(h.addCalls, 'settle jobs the Stops tried to queue').toBe(2);
      expect(owner.status).toBe(200);
      expect(sorted(Object.keys(owner.body))).toEqual(OWNER_BODY_KEYS);
      expect(owner.body).toMatchObject({ ok: true, cancelled: 1, stopped: 1 });
      expect(admin.status).toBe(200);
      expect(sorted(Object.keys(admin.body!))).toEqual(ADMIN_BODY_KEYS);
      expect(admin.body).toMatchObject({ ok: true, cancelled: 1, stopped: 1 });
      expect((await taskOf(first.id)).status).toBe('failed');
      expect((await taskOf(second.id)).status).toBe('failed');
    });

    it('R6: add hangs, owner and admin Stop answer within 5 s', async () => {
      h.addMode = 'hang';
      const first = await seedStoppable();
      const second = await seedStoppable();

      const owner = await within(5_000, ownerStop(first.id));
      const admin = await within(5_000, adminStop(second.id));

      expect(h.addCalls, 'settle jobs the Stops tried to queue').toBe(2);
      expect(owner, 'owner Stop while add never settles').not.toBe('hung');
      expect(admin, 'admin Stop while add never settles').not.toBe('hung');
      expect((owner as { status: number }).status).toBe(200);
      expect(sorted(Object.keys((owner as { body: object }).body))).toEqual(OWNER_BODY_KEYS);
      expect((admin as { status: number }).status).toBe(200);
      expect((await taskOf(first.id)).status).toBe('failed');
      expect((await taskOf(second.id)).status).toBe('failed');
    }, 30_000);
  });
});
