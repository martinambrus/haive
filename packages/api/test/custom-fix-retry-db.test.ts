import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabase, schema, type Database } from '@haive/database';

const url = process.env.CUSTOM_FIX_RETRY_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/custom_fix_retry_test'))
  throw new Error('Use a dedicated custom_fix_retry_test database for the fix retry tests');

const h = vi.hoisted(() => ({
  db: undefined as unknown,
  queued: [] as { name: string; payload: unknown }[],
  userId: globalThis.crypto.randomUUID(),
  realFence: false,
}));
const BLIND_INDEX = `custom-fix-retry-${globalThis.crypto.randomUUID()}`;

vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/queues.js', () => {
  const queue = () => ({
    add: async (name: string, payload: unknown) => {
      h.queued.push({ name, payload });
    },
  });
  return {
    getTaskQueue: queue,
    getRepoQueue: queue,
    getBundleQueue: queue,
    getCliExecQueue: queue,
    getUsagePollQueue: queue,
  };
});
vi.mock('../src/lib/sandbox-kill.js', () => ({ killTaskSandboxes: async () => 0 }));
vi.mock('../src/lib/execution-contract-admission.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/lib/execution-contract-admission.js')>();
  return {
    assertExecutionContractUsable: (raw: unknown) => {
      if (h.realFence) real.assertExecutionContractUsable(raw);
    },
  };
});
vi.mock('../src/middleware/auth.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/middleware/auth.js')>()),
  requireAuth: async (c: { set: (key: string, value: string) => void }, next: () => unknown) => {
    c.set('userId', h.userId);
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
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';

const app = new Hono<AppEnv>();
app.route('/tasks', taskRoutes);
app.onError(errorHandler);

type Role = 'ABOVE' | 'TARGET' | 'REVIEW' | 'AFTER';
type Status = typeof schema.taskSteps.$inferInsert.status;
interface Leg {
  name: 'ordinary' | 'custom';
  ids: Record<Role, string>;
  pinned: boolean;
}
const SHARED_IDS = {
  ABOVE: '06-run-config',
  REVIEW: '08b-test-management',
  AFTER: '10-gate-3-commit',
};
const LEGS: Leg[] = [
  {
    name: 'ordinary',
    ids: { ...SHARED_IDS, TARGET: '07-phase-2-implement' },
    pinned: false,
  },
  {
    name: 'custom',
    ids: { ...SHARED_IDS, TARGET: 'module.cfr-fix.target' },
    pinned: true,
  },
];
const INDEX: Record<Role, number> = { ABOVE: 6, TARGET: 7, REVIEW: 8, AFTER: 9 };
const ROLES: Role[] = ['ABOVE', 'TARGET', 'REVIEW', 'AFTER'];
const EPOCH = 3;

const GATE_SCHEMA = {
  title: 'Fix loop needs a decision',
  fields: [
    {
      type: 'radio',
      id: 'fixLoopAction',
      label: 'How would you like to proceed?',
      options: [
        { value: 'continue', label: 'Continue' },
        { value: 'accept', label: 'Accept' },
        { value: 'abort', label: 'Abort' },
      ],
      default: 'continue',
    },
    {
      type: 'textarea',
      id: 'fixLoopInstruction',
      label: 'Instructions',
      rows: 4,
      visibleWhen: { field: 'fixLoopAction', equals: 'continue' },
    },
  ],
  submitLabel: 'Apply decision',
};

interface Fixture {
  taskStatus: 'failed' | 'running' | 'waiting_user';
  pointer: [Role, number];
  /** Round 1 rows; a missing role has no round 1 row yet. */
  round1: Partial<Record<Role, Status>>;
  round0?: Status;
  iterations?: number;
  gate?: boolean;
  paused?: boolean;
}

const GOLDEN = {
  r1a: {
    task: 'running TARGET@1 epoch+1',
    rows: [
      'ABOVE@0 done g0',
      'TARGET@0 done g0',
      'REVIEW@0 done g0',
      'AFTER@0 done g0',
      'TARGET@1 pending g1 pause',
      'REVIEW@1 pending g0',
      'AFTER@1 pending g0',
    ],
    events: ['fix_loop.requested', 'fix_loop.started', 'step.retry'],
    jobs: ['advance-step TARGET@1 epoch+1'],
    extra: ['200'],
  },
  r1b: {
    task: 'running TARGET@1 epoch+1',
    rows: [
      'ABOVE@0 done g0',
      'TARGET@0 done g0',
      'REVIEW@0 done g0',
      'AFTER@0 done g0',
      'TARGET@1 pending g1 pause',
      'REVIEW@1 pending g1',
      'AFTER@1 pending g1',
    ],
    events: ['fix_loop.requested', 'fix_loop.started', 'step.retry'],
    jobs: ['advance-step TARGET@1 epoch+1'],
    extra: ['200'],
  },
  r2: {
    task: 'running REVIEW@1 epoch+1',
    rows: [
      'ABOVE@0 done g0',
      'TARGET@0 done g0',
      'REVIEW@0 done g0',
      'AFTER@0 done g0',
      'TARGET@1 done g0',
      'REVIEW@1 pending g1 pause',
      'AFTER@1 pending g1',
    ],
    events: ['fix_loop.requested', 'fix_loop.started', 'step.retry'],
    jobs: ['advance-step REVIEW@1 epoch+1'],
    extra: ['200'],
  },
  r3: {
    running: {
      task: 'running ABOVE@0 epoch+1',
      rows: [
        'ABOVE@0 pending g1 pause',
        'TARGET@0 pending g1',
        'REVIEW@0 pending g1',
        'AFTER@0 pending g1',
        'TARGET@1 pending g1',
      ],
      events: ['fix_loop.requested', 'fix_loop.started', 'step.retry'],
      jobs: ['advance-step ABOVE@0 epoch+1'],
      extra: ['200'],
    },
    waiting_cli: {
      task: 'running ABOVE@0 epoch+1',
      rows: [
        'ABOVE@0 pending g1 pause',
        'TARGET@0 pending g1',
        'REVIEW@0 pending g1',
        'AFTER@0 pending g1',
        'TARGET@1 pending g1',
      ],
      events: ['fix_loop.requested', 'fix_loop.started', 'step.retry'],
      jobs: ['advance-step ABOVE@0 epoch+1'],
      extra: ['200'],
    },
    waiting_form: {
      task: 'running ABOVE@0 epoch+1',
      rows: [
        'ABOVE@0 pending g1 pause',
        'TARGET@0 pending g1',
        'REVIEW@0 pending g1',
        'AFTER@0 pending g1',
        'TARGET@1 pending g1',
      ],
      events: ['fix_loop.requested', 'fix_loop.started', 'step.retry'],
      jobs: ['advance-step ABOVE@0 epoch+1'],
      extra: ['200'],
    },
  },
  r3settled: {
    task: 'running ABOVE@0 epoch+1',
    rows: [
      'ABOVE@0 pending g1 pause',
      'TARGET@0 pending g1',
      'REVIEW@0 pending g1',
      'AFTER@0 pending g1',
      'TARGET@1 done g0',
      'REVIEW@1 done g0',
      'AFTER@1 failed g0',
    ],
    events: ['fix_loop.requested', 'fix_loop.started', 'step.retry'],
    jobs: ['advance-step ABOVE@0 epoch+1'],
    extra: ['200'],
  },
  r4task: {
    task: 'running REVIEW@1 epoch+1',
    rows: [
      'ABOVE@0 done g0',
      'TARGET@0 done g0',
      'REVIEW@0 done g0',
      'AFTER@0 done g0',
      'TARGET@1 done g0',
      'REVIEW@1 pending g1 pause',
    ],
    events: ['fix_loop.requested', 'fix_loop.started', 'task.retried'],
    jobs: ['advance-step REVIEW@1 epoch+1'],
    extra: ['200'],
  },
  r4step: {
    task: 'running REVIEW@1 epoch+1',
    rows: [
      'ABOVE@0 done g0',
      'TARGET@0 done g0',
      'REVIEW@0 done g0',
      'AFTER@0 done g0',
      'TARGET@1 done g0',
      'REVIEW@1 pending g1 pause',
    ],
    events: ['fix_loop.requested', 'fix_loop.started', 'step.retry'],
    jobs: ['advance-step REVIEW@1 epoch+1'],
    extra: ['200'],
  },
  r5: {
    task: 'running TARGET@1 epoch+1',
    rows: [
      'ABOVE@0 done g0',
      'TARGET@0 done g0',
      'REVIEW@0 done g0',
      'AFTER@0 done g0',
      'TARGET@1 pending g1',
    ],
    events: ['fix_loop.requested', 'fix_loop.started', 'task.retried'],
    jobs: ['advance-step TARGET@1 epoch+1'],
    extra: ['200'],
  },
  r6: {
    task: 'running TARGET@1 epoch+2',
    rows: [
      'ABOVE@0 done g0',
      'TARGET@0 done g0',
      'REVIEW@0 done g0',
      'AFTER@0 done g0',
      'TARGET@1 pending g2 pause',
      'REVIEW@1 pending g0',
      'AFTER@1 pending g0',
    ],
    events: ['fix_loop.requested', 'fix_loop.started', 'step.retry', 'step.retry'],
    jobs: ['advance-step TARGET@1 epoch+1', 'advance-step TARGET@1 epoch+2'],
    extra: ['200', '200'],
  },
  r7target: {
    task: 'failed TARGET@1 epoch+0',
    rows: [
      'ABOVE@0 done g0',
      'TARGET@0 done g0',
      'REVIEW@0 done g0',
      'AFTER@0 done g0',
      'TARGET@1 failed g0',
    ],
    events: ['fix_loop.requested', 'fix_loop.started'],
    jobs: [],
    extra: ['409', 'not_resumable'],
  },
  r7review: {
    task: 'failed REVIEW@1 epoch+0',
    rows: [
      'ABOVE@0 done g0',
      'TARGET@0 done g0',
      'REVIEW@0 done g0',
      'AFTER@0 done g0',
      'TARGET@1 done g0',
      'REVIEW@1 failed g0',
    ],
    events: ['fix_loop.requested', 'fix_loop.started'],
    jobs: [],
    extra: ['409', 'not_resumable'],
  },
  r7loop: {
    task: 'running TARGET@1 epoch+1',
    rows: [
      'ABOVE@0 done g0',
      'TARGET@0 done g0',
      'REVIEW@0 done g0',
      'AFTER@0 done g0',
      'TARGET@1 running g0',
      'REVIEW@1 pending g0',
    ],
    events: ['fix_loop.requested', 'fix_loop.started', 'step.resume'],
    jobs: ['advance-step TARGET@1 epoch+1'],
    extra: ['200'],
  },
  r7task: {
    task: 'running TARGET@1 epoch+0',
    rows: [
      'ABOVE@0 done g0',
      'TARGET@0 done g0',
      'REVIEW@0 done g0',
      'AFTER@0 done g0',
      'TARGET@1 running g0',
    ],
    events: ['fix_loop.requested', 'fix_loop.started', 'task.resumed'],
    jobs: [],
    extra: ['200'],
  },
};

describe.skipIf(!url)('Retry and Resume of a fix round on Postgres', () => {
  let db: Database;
  let repositoryId: string;

  const send = async (method: string, path: string, body: unknown) =>
    app.request(path, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const post = (path: string, body: unknown) => send('POST', path, body);

  const reset = async () => {
    h.queued = [];
    await db.delete(schema.tasks).where(eq(schema.tasks.userId, h.userId));
  };

  const seed = async (leg: Leg, fx: Fixture) => {
    const [task] = await db
      .insert(schema.tasks)
      .values({
        userId: h.userId,
        repositoryId,
        type: 'workflow',
        title: `fix-round-${leg.name}`,
        status: fx.taskStatus,
        errorMessage: fx.taskStatus === 'failed' ? 'boom' : null,
        completedAt: fx.taskStatus === 'failed' ? new Date() : null,
        currentStepId: leg.ids[fx.pointer[0]],
        currentRound: fx.pointer[1],
        orchestrationEpoch: EPOCH,
        pausedAt: fx.paused ? new Date() : null,
        runListSnapshot: ROLES.map((r) => leg.ids[r]),
        executionContract: leg.pinned
          ? {
              version: 1,
              guardedSpans: [],
              fixTarget: { stepId: leg.ids.TARGET, capabilityVersion: 1 },
            }
          : null,
      })
      .returning();
    const row = (
      role: Role,
      round: number,
      status: Status,
      over: Partial<typeof schema.taskSteps.$inferInsert> = {},
    ) => ({
      taskId: task!.id,
      stepId: leg.ids[role],
      stepIndex: INDEX[role],
      runSeq: round * 4 + ROLES.indexOf(role) + 1,
      round,
      title: role,
      status,
      detectOutput: {},
      output: {},
      ...over,
    });
    const rows: (typeof schema.taskSteps.$inferInsert)[] = ROLES.map((r) =>
      row(r, 0, fx.round0 ?? 'done'),
    );
    for (const [role, status] of Object.entries(fx.round1) as [Role, Status][]) {
      rows.push(
        row(role, 1, status, {
          iterationCount: role === 'TARGET' ? (fx.iterations ?? 0) : 0,
          ...(fx.gate && role === 'REVIEW'
            ? {
                formSchema: GATE_SCHEMA,
                formValues: { fixLoopAction: 'continue', fixLoopInstruction: 'x' },
              }
            : {}),
        }),
      );
    }
    await db.insert(schema.taskSteps).values(rows);
    const at = Date.now() - 60_000;
    await db.insert(schema.taskEvents).values([
      {
        taskId: task!.id,
        eventType: 'fix_loop.requested',
        payload: { round: 1 },
        createdAt: new Date(at),
      },
      {
        taskId: task!.id,
        eventType: 'fix_loop.started',
        payload: { round: 1 },
        createdAt: new Date(at + 1000),
      },
    ]);
    h.queued = [];
    return task!.id;
  };

  const trace = async (leg: Leg, taskId: string, extra: string[] = []) => {
    const role = (stepId: string) => ROLES.find((r) => leg.ids[r] === stepId) ?? stepId;
    const task = (await db.query.tasks.findFirst({ where: eq(schema.tasks.id, taskId) }))!;
    const rows = await db.query.taskSteps.findMany({ where: eq(schema.taskSteps.taskId, taskId) });
    const events = await db.query.taskEvents.findMany({
      where: eq(schema.taskEvents.taskId, taskId),
    });
    return {
      task: `${task.status} ${role(task.currentStepId ?? '-')}@${task.currentRound} epoch+${task.orchestrationEpoch - EPOCH}${task.pausedAt ? ' paused' : ''}`,
      rows: rows
        .sort((a, b) => a.runSeq! - b.runSeq!)
        .map(
          (r) =>
            `${role(r.stepId)}@${r.round} ${r.status} g${r.rerunGeneration}${r.formValues ? ' values' : ''}${r.pauseFormOnRetry ? ' pause' : ''}`,
        ),
      events: events
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
        .map((e) => e.eventType),
      jobs: h.queued
        .map((j) => {
          const p = j.payload as { stepId: string; round: number; epoch: number };
          return `${j.name} ${role(p.stepId)}@${p.round} epoch+${p.epoch - EPOCH}`;
        })
        .sort(),
      extra,
    };
  };

  const stepAction = (leg: Leg, taskId: string, role: Role, round: number, action: string) =>
    post(`/tasks/${taskId}/steps/${leg.ids[role]}/action`, { action, round });

  /** Runs one scenario on both legs and holds the custom trace to the ordinary one and the ordinary
   *  one to the recorded golden. */
  const parity = async (
    fx: Fixture,
    act: (leg: Leg, taskId: string) => Promise<string[] | void>,
    golden: Awaited<ReturnType<typeof trace>>,
  ) => {
    const traces: Record<string, Awaited<ReturnType<typeof trace>>> = {};
    for (const leg of LEGS) {
      await reset();
      const taskId = await seed(leg, fx);
      const extra = (await act(leg, taskId)) ?? [];
      traces[leg.name] = await trace(leg, taskId, extra);
    }
    expect(traces.custom).toEqual(traces.ordinary);
    expect(traces.ordinary).toEqual(golden);
  };

  beforeAll(async () => {
    db = createDatabase(url as string);
    h.db = db;
    await db.insert(schema.users).values({
      id: h.userId,
      emailEncrypted: `${BLIND_INDEX}@test.local`,
      emailBlindIndex: BLIND_INDEX,
      passwordHash: 'not-real',
      role: 'user',
    });
    const [repository] = await db
      .insert(schema.repositories)
      .values({ userId: h.userId, name: 'custom-fix-retry', source: 'local_path', status: 'ready' })
      .returning({ id: schema.repositories.id });
    repositoryId = repository!.id;
  });

  beforeEach(async () => {
    h.realFence = false;
    await reset();
  });

  afterAll(async () => {
    await db.delete(schema.users).where(eq(schema.users.emailBlindIndex, BLIND_INDEX));
    await db.$client.end({ timeout: 5 });
  });

  const expectOk = async (res: Response) => {
    expect(res.status).toBe(200);
    return [`${res.status}`];
  };

  it('R1a: Retry of a failed target row resets it and the later round 1 rows', async () => {
    await parity(
      {
        taskStatus: 'failed',
        pointer: ['TARGET', 1],
        round1: { TARGET: 'failed', REVIEW: 'pending', AFTER: 'pending' },
      },
      async (leg, id) => expectOk(await stepAction(leg, id, 'TARGET', 1, 'retry')),
      GOLDEN.r1a,
    );
  });

  it('R1b: Retry of a done target row resets every round 1 row behind it', async () => {
    await parity(
      {
        taskStatus: 'failed',
        pointer: ['AFTER', 1],
        round1: { TARGET: 'done', REVIEW: 'done', AFTER: 'failed' },
      },
      async (leg, id) => expectOk(await stepAction(leg, id, 'TARGET', 1, 'retry')),
      GOLDEN.r1b,
    );
  });

  it('R2: Retry of the review row leaves the target row of the round alone', async () => {
    await parity(
      {
        taskStatus: 'failed',
        pointer: ['AFTER', 1],
        round1: { TARGET: 'done', REVIEW: 'done', AFTER: 'failed' },
      },
      async (leg, id) => expectOk(await stepAction(leg, id, 'REVIEW', 1, 'retry')),
      GOLDEN.r2,
    );
  });

  it.each(['running', 'waiting_cli', 'waiting_form'] as const)(
    'R3: Retry above the target at round 0 resets a %s round 1 row',
    async (live) => {
      await parity(
        {
          taskStatus: 'running',
          pointer: ['TARGET', 1],
          round1: { TARGET: live },
        },
        async (leg, id) => expectOk(await stepAction(leg, id, 'ABOVE', 0, 'retry')),
        GOLDEN.r3[live],
      );
    },
  );

  it('R3: Retry above the target at round 0 leaves a settled round 1 row alone', async () => {
    await parity(
      {
        taskStatus: 'failed',
        pointer: ['AFTER', 1],
        round1: { TARGET: 'done', REVIEW: 'done', AFTER: 'failed' },
      },
      async (leg, id) => expectOk(await stepAction(leg, id, 'ABOVE', 0, 'retry')),
      GOLDEN.r3settled,
    );
  });

  it('R4: task Retry of a parked fix gate row re-asks and queues the one job', async () => {
    await parity(
      {
        taskStatus: 'failed',
        pointer: ['REVIEW', 1],
        round1: { TARGET: 'done', REVIEW: 'waiting_form' },
        gate: true,
      },
      async (_leg, id) => {
        const res = await post(`/tasks/${id}/action`, { action: 'retry' });
        expect(res.status).toBe(200);
        return [`${res.status}`];
      },
      GOLDEN.r4task,
    );
  });

  it('R4: step Retry of a parked fix gate row re-asks and queues the one job', async () => {
    await parity(
      {
        taskStatus: 'waiting_user',
        pointer: ['REVIEW', 1],
        round1: { TARGET: 'done', REVIEW: 'waiting_form' },
        gate: true,
      },
      async (leg, id) => expectOk(await stepAction(leg, id, 'REVIEW', 1, 'retry')),
      GOLDEN.r4step,
    );
  });

  it('R5: task Retry of a failed task stopped on the target re-runs that row', async () => {
    await parity(
      {
        taskStatus: 'failed',
        pointer: ['TARGET', 1],
        round1: { TARGET: 'failed' },
      },
      async (_leg, id) => {
        const res = await post(`/tasks/${id}/action`, { action: 'retry' });
        expect(res.status).toBe(200);
        return [`${res.status}`];
      },
      GOLDEN.r5,
    );
  });

  it('R6: two concurrent Retry requests of one row', async () => {
    await parity(
      {
        taskStatus: 'failed',
        pointer: ['TARGET', 1],
        round1: { TARGET: 'failed', REVIEW: 'pending', AFTER: 'pending' },
      },
      async (leg, id) => {
        const results = await Promise.all([
          stepAction(leg, id, 'TARGET', 1, 'retry'),
          stepAction(leg, id, 'TARGET', 1, 'retry'),
        ]);
        return results.map((r) => `${r.status}`).sort();
      },
      GOLDEN.r6,
    );
  });

  it('R7: step Resume of a failed target row with no pass done is refused', async () => {
    await parity(
      {
        taskStatus: 'failed',
        pointer: ['TARGET', 1],
        round1: { TARGET: 'failed' },
      },
      async (leg, id) => {
        const res = await stepAction(leg, id, 'TARGET', 1, 'resume');
        return [`${res.status}`, ((await res.json()) as { code: string }).code];
      },
      GOLDEN.r7target,
    );
  });

  it('R7: step Resume of a failed non-loop review row is refused', async () => {
    await parity(
      {
        taskStatus: 'failed',
        pointer: ['REVIEW', 1],
        round1: { TARGET: 'done', REVIEW: 'failed' },
      },
      async (leg, id) => {
        const res = await stepAction(leg, id, 'REVIEW', 1, 'resume');
        return [`${res.status}`, ((await res.json()) as { code: string }).code];
      },
      GOLDEN.r7review,
    );
  });

  it('R7: step Resume of a failed target row with a pass done keeps the pass and queues one job', async () => {
    await parity(
      {
        taskStatus: 'failed',
        pointer: ['TARGET', 1],
        round1: { TARGET: 'failed', REVIEW: 'pending' },
        iterations: 2,
      },
      async (leg, id) => expectOk(await stepAction(leg, id, 'TARGET', 1, 'resume')),
      GOLDEN.r7loop,
    );
  });

  it('R7: task Resume of a paused task lifts the hold and queues nothing', async () => {
    await parity(
      {
        taskStatus: 'running',
        pointer: ['TARGET', 1],
        round1: { TARGET: 'running' },
        paused: true,
      },
      async (_leg, id) => {
        const res = await post(`/tasks/${id}/action`, { action: 'resume' });
        expect(res.status).toBe(200);
        return [`${res.status}`];
      },
      GOLDEN.r7task,
    );
  });

  describe('R8: the real admission fence', () => {
    const custom = LEGS[1]!;
    const dump = async (taskId: string) => ({
      task: await db.query.tasks.findFirst({ where: eq(schema.tasks.id, taskId) }),
      rows: (await db.query.taskSteps.findMany({ where: eq(schema.taskSteps.taskId, taskId) }))
        .sort((a, b) => a.runSeq! - b.runSeq!)
        .map((r) => r),
      events: (
        await db.query.taskEvents.findMany({ where: eq(schema.taskEvents.taskId, taskId) })
      ).sort((a, b) => a.id.localeCompare(b.id)),
    });
    const fixture: Fixture = {
      taskStatus: 'failed',
      pointer: ['TARGET', 1],
      round1: { TARGET: 'failed', REVIEW: 'waiting_form' },
      iterations: 2,
      paused: true,
    };
    const actions: [string, (taskId: string) => Promise<Response>][] = [
      ['step Retry', (id) => stepAction(custom, id, 'TARGET', 1, 'retry')],
      ['step Resume', (id) => stepAction(custom, id, 'TARGET', 1, 'resume')],
      [
        'submit',
        (id) =>
          post(`/tasks/${id}/steps/${custom.ids.REVIEW}/submit`, {
            values: { fixLoopAction: 'x' },
          }),
      ],
      ['clarify', (id) => post(`/tasks/${id}/steps/${custom.ids.REVIEW}/clarify`, { answer: 'x' })],
      ['task Retry', (id) => post(`/tasks/${id}/action`, { action: 'retry' })],
      ['task Resume', (id) => post(`/tasks/${id}/action`, { action: 'resume' })],
    ];

    it.each(actions)(
      '%s on an unsupported non-module fix target answers 409 and changes nothing',
      async (_n, go) => {
        h.realFence = true;
        const id = await seed(custom, fixture);
        await db
          .update(schema.tasks)
          .set({
            executionContract: {
              version: 1,
              guardedSpans: [],
              fixTarget: { stepId: LEGS[0]!.ids.TARGET, capabilityVersion: 1 },
            },
          })
          .where(eq(schema.tasks.id, id));
        const before = await dump(id);

        const res = await go(id);

        expect(res.status).toBe(409);
        expect(((await res.json()) as { code: string }).code).toBe('invalid-execution-contract');
        expect(await dump(id)).toEqual(before);
        expect(h.queued).toEqual([]);
      },
    );

    it.each(actions)('%s admits a supported module fix-target pin', async (name, go) => {
      h.realFence = true;
      const id = await seed(custom, fixture);
      const before = await dump(id);

      const res = await go(id);

      expect(res.status, await res.clone().text()).toBe(200);
      const after = await dump(id);
      expect(after).not.toEqual(before);
      expect(after.task!.executionContract).toEqual(before.task!.executionContract);
      expect(after.task!.runListSnapshot).toEqual(before.task!.runListSnapshot);
      expect(h.queued).toHaveLength(name === 'task Resume' ? 0 : 1);
    });

    it('lets the same Retry through on a task with no pin', async () => {
      h.realFence = true;
      const id = await seed(LEGS[0]!, fixture);

      const res = await stepAction(LEGS[0]!, id, 'TARGET', 1, 'retry');

      expect(res.status).toBe(200);
      expect(h.queued).toHaveLength(1);
    });
  });
});
