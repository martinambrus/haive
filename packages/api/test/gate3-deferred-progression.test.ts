import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, gt, lt, is, SQL, StringChunk } from 'drizzle-orm';
import { PgTable, PgDialect } from 'drizzle-orm/pg-core';
import { schema, type Database } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { configService, type FormSchema } from '@haive/shared';
import type { StepDefinition } from '@haive/shared/step';

// Match the existing cross-package fixtures: import source by URL so each package's tsc root stays local.
const runnerPath = new URL('../../worker/src/step-engine/step-runner.ts', import.meta.url).href;
const bootPath = new URL('../../worker/src/step-engine/boot.ts', import.meta.url).href;
const queuePath = new URL('../../worker/src/queues/task-queue.ts', import.meta.url).href;
const gatePath = new URL('../../worker/src/queues/insight-gate3-return.ts', import.meta.url).href;
const { advanceStep } = await import(runnerPath);
const { registerStepsOnce } = await import(bootPath);
const { handleResult, closeTaskQueue } = await import(queuePath);
const { gate3QaDeferred } = await import(gatePath);

// Timing's SQL folds have their own Postgres suite; these controls exercise form ownership.
vi.mock('../../worker/src/queues/cli-park-timing.js', async (original) => ({
  ...(await original<object>()),
  foldCliParkOnResume: async () => undefined,
}));

const h = vi.hoisted(() => ({ db: undefined as unknown, jobs: [] as Record<string, unknown>[] }));
vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/queues.js', () => ({
  getTaskQueue: () => ({
    add: async (_n: string, data: Record<string, unknown>) => {
      h.jobs.push(data);
    },
  }),
}));
vi.mock('../src/lib/sandbox-kill.js', () => ({
  killTaskSandboxes: async () => ({ killed: 0, killConfirmed: true }),
}));
vi.mock('../../worker/src/redis.js', () => ({ getBullRedis: () => ({}) }));
vi.mock('bullmq', async (original) => ({
  ...(await original<object>()),
  Queue: class {
    async add(_name: string, data: Record<string, unknown>) {
      h.jobs.push(data);
    }
    async close() {}
  },
}));
import { Hono } from 'hono';
import { stepRoutes } from '../src/routes/tasks/steps.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';

const USER = '00000000-0000-4000-8000-0000000000a1';
const TASK = '00000000-0000-4000-8000-000000000001';
const G2 = '09-gate-2-verify-approval';
const G3 = '10-gate-3-commit';
const QA = '08d2-adversarial-qa-review';
const CYCLE_AT = new Date('2026-01-01');
const app = new Hono<AppEnv>();
app.use('*', async (c, next) => {
  c.set('userId', USER);
  await next();
});
app.route('/', stepRoutes);
app.onError(errorHandler);
const post = (path: string, body: unknown) =>
  app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

function fixture() {
  const tables: Record<string, PgTable> = {};
  for (const [name, table] of Object.entries(schema)) if (is(table, PgTable)) tables[name] = table;
  const fake = createFakeDb(tables);
  const db = fake.db as unknown as Database;
  h.db = db;
  const ids = [
    '07-phase-2-implement',
    '08-phase-5-verify',
    '08c-code-review',
    QA,
    '08e-insights-triage',
    G2,
    G3,
  ];
  fake.insert(schema.repositories, {
    id: USER,
    userId: USER,
    name: 'repo',
    source: 'git_https',
    status: 'ready',
  });
  fake.insert(schema.tasks, {
    repositoryId: USER,
    id: TASK,
    userId: USER,
    type: 'workflow',
    status: 'running',
    orchestrationEpoch: 0,
    currentStepId: G2,
    currentRound: 1,
    runListSnapshot: ids,
    autoContinue: true,
    preAnswers: { [G2]: { decision: 'approve' }, [G3]: { commit: true } },
  });
  const source = fake.insert(schema.taskSteps, {
    taskId: TASK,
    stepId: G3,
    round: 0,
    status: 'done',
    rerunGeneration: 0,
  });
  fake.insert(schema.taskSteps, {
    taskId: TASK,
    stepId: QA,
    round: 1,
    status: 'done',
    output: { decision: 'accept' },
  });
  fake.insert(schema.taskEvents, {
    taskId: TASK,
    eventType: 'insight.continuation',
    createdAt: CYCLE_AT,
    payload: {
      continuation: {
        version: 1,
        kind: 'insight_revise',
        batchId: 'batch',
        sourceStepRow: source.id,
        generation: 0,
        round: 1,
        mode: 'gate3',
        stage: 'apply',
      },
      targetStepId: '08e-insights-triage',
    },
  });
  // Only the timestamp subquery is substituted here; its PostgreSQL precision is covered in
  // cancel-sandbox-fence. All route writes, generation checks and runner guards stay real.
  // Normalize the raw round comparison to the equivalent Drizzle predicate the shared fake
  // evaluates. The actual ordering and timestamp SQL are also exercised on Postgres.
  const normalize = (condition: SQL): SQL => {
    const chunks = condition.queryChunks.filter(
      (chunk) => !(chunk instanceof StringChunk && chunk.value.join('') === ''),
    );
    if (
      chunks.length === 3 &&
      chunks[1] instanceof StringChunk &&
      chunks[1].value.join('').trim() === '<' &&
      typeof chunks[2] === 'number'
    )
      return lt(chunks[0] as typeof schema.taskSteps.round, chunks[2]);
    return new SQL(chunks.map((chunk) => (chunk instanceof SQL ? normalize(chunk) : chunk)));
  };
  const readStep = fake.db.query.taskSteps!.findFirst;
  vi.spyOn(fake.db.query.taskSteps!, 'findFirst').mockImplementation((opts) =>
    readStep({ ...opts, where: opts?.where ? normalize(opts.where as SQL) : undefined }),
  );
  const readEvent = fake.db.query.taskEvents!.findFirst;
  vi.spyOn(fake.db.query.taskEvents!, 'findFirst').mockImplementation((opts) => {
    const sql = new PgDialect().sqlToQuery(opts!.where as SQL).sql;
    if (!sql.includes('greatest(')) return readEvent(opts);
    return readEvent({
      ...opts,
      where: and(
        eq(schema.taskEvents.taskId, TASK),
        eq(schema.taskEvents.eventType, 'step.form_submitted'),
        gt(schema.taskEvents.createdAt, CYCLE_AT),
      ),
    });
  });
  const apply2 = vi.fn(async () => ({ decision: 'approve' }));
  const apply3 = vi.fn(async () => ({ committed: true }));
  const def = (id: string, apply: StepDefinition['apply']): StepDefinition => ({
    metadata: {
      id,
      workflowType: 'workflow',
      index: id === G2 ? 9 : 10,
      title: id,
      description: id,
      requiresCli: false,
    },
    detect: async () => ({}),
    form: () =>
      ({
        title: id,
        fields: [
          {
            id: id === G2 ? 'decision' : 'commit',
            type: id === G2 ? 'radio' : 'checkbox',
            label: 'Decision',
            ...(id === G2 ? { options: [{ value: 'approve', label: 'Approve' }] } : {}),
          },
        ],
      }) as FormSchema,
    apply,
  });
  const defs: Record<string, StepDefinition> = { [G2]: def(G2, apply2), [G3]: def(G3, apply3) };
  const advance = (id: string) =>
    advanceStep({
      db,
      taskId: TASK,
      userId: USER,
      repoPath: '/repo',
      workspacePath: '/repo',
      cliProviderId: null,
      stepDef: defs[id]!,
      round: 1,
      epoch: Number(fake.rows(schema.tasks)[0]!.orchestrationEpoch),
      moduleDeactivation: null,
    });
  const context = () => ({
    taskId: TASK,
    userId: USER,
    workflowType: 'workflow',
    repoPath: '/repo',
    workspacePath: '/repo',
    cliProviderId: null,
    ignoreSavedStepClis: false,
    executionPath: null,
    metadata: null,
    orchestrationEpoch: Number(fake.rows(schema.tasks)[0]!.orchestrationEpoch),
    currentStepId: G2,
    currentRound: 1,
    status: 'running',
    completedAt: null,
    runListStrategy: 'static',
    runListSnapshot: ids,
  });
  const submit = (id: string, row: typeof schema.taskSteps.$inferSelect) =>
    post(`/${TASK}/steps/${id}/submit`, {
      values: id === G2 ? { decision: 'approve' } : { commit: true },
      stepRowId: row.id,
      waitingStartedAt: row.waitingStartedAt!.toISOString(),
    });
  return { fake, db, advance, context, submit, apply2, apply3 };
}

beforeEach(() => {
  h.jobs = [];
  registerStepsOnce();
  vi.spyOn(configService, 'get').mockResolvedValue(null);
  vi.spyOn(configService, 'getBoolean').mockResolvedValue(false);
  vi.spyOn(configService, 'getFresh').mockResolvedValue('normal');
});
afterEach(async () => {
  await closeTaskQueue();
  vi.restoreAllMocks();
});

describe('deferred QA approval through the following gate 3', () => {
  it.each([false, true])(
    'Retry route before submit=%s: gate 2 completes, gate 3 parks and its owner answer applies once',
    async (retry) => {
      const t = fixture();
      const parked = await t.advance(G2);
      expect(parked.status).toBe('waiting_form');
      if (retry) {
        const response = await post(`/${TASK}/steps/${G2}/action`, { action: 'retry' });
        expect(response.status, await response.text()).toBe(200);
        const stale = await t.submit(G2, parked.row);
        expect(stale.status).toBe(409);
      }
      const current = retry ? await t.advance(G2) : parked;
      expect(current.status).toBe('waiting_form');
      expect((await t.submit(G2, current.row)).status).toBe(200);
      const approved = await t.advance(G2);
      expect(approved.status).toBe('done');
      expect(t.apply2).toHaveBeenCalledOnce();
      h.jobs = [];
      await handleResult(t.db, t.context(), G2, approved);
      expect(h.jobs).toMatchObject([{ stepId: G3, round: 1 }]);
      expect(t.fake.rows(schema.taskEvents).filter((e) => e.eventType === 'insight.check')).toEqual(
        [],
      );
      const gate3 = await t.advance(G3);
      expect(gate3.status).toBe('waiting_form');
      expect(t.apply3).not.toHaveBeenCalled();
      expect((await t.submit(G3, gate3.row)).status).toBe(200);
      expect((await t.advance(G3)).status).toBe('done');
      expect((await t.advance(G3)).status).toBe('done');
      expect(t.apply3).toHaveBeenCalledOnce();
    },
  );
});

it.each(['runSeq', 'createdAt'] as const)(
  'QA deferral uses %s to break same-round ties',
  async (tie) => {
    const fake = createFakeDb({ taskSteps: schema.taskSteps });
    // Synthetic duplicate-round rows exercise defensive ordering; the real table's unique index
    // normally prevents these ties. Insertion order deliberately opposes the required winner.
    const base = {
      taskId: TASK,
      stepId: QA,
      round: 2,
      status: 'done',
      runSeq: 2,
      createdAt: new Date('2026-01-02'),
    };
    fake.insert(schema.taskSteps, { ...base, output: { decision: 'fix' } });
    const winner = fake.insert(schema.taskSteps, {
      ...base,
      output: { decision: 'accept' },
      ...(tie === 'runSeq'
        ? { runSeq: 3, createdAt: CYCLE_AT }
        : { createdAt: new Date('2026-01-03') }),
    });
    expect(await gate3QaDeferred(fake.db as unknown as Database, TASK, 1, 2)).toBe(true);
    fake.patch(schema.taskSteps, String(winner.id), { status: 'skipped' });
    expect(await gate3QaDeferred(fake.db as unknown as Database, TASK, 1, 2)).toBe(false);
  },
);
