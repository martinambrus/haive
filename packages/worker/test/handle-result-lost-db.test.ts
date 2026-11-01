import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabase, schema, type Database } from '@haive/database';
import { logger, type WorkflowType } from '@haive/shared';
import {
  handleResult,
  markTaskCancelled,
  setContainerCleanupRunner,
} from '../src/queues/task-queue.js';
import type { ResolvedTaskContext } from '../src/queues/run-list.js';
import { stepRegistry } from '../src/step-engine/registry.js';
import type { StepDefinition } from '../src/step-engine/step-definition.js';
import type { AdvanceStepResult } from '../src/step-engine/step-runner.js';

const h = vi.hoisted(() => ({
  db: undefined as unknown,
  adds: [] as { name: string; data: unknown }[],
}));

vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/redis.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/redis.js')>()),
  getBullRedis: () => ({}),
  getRedis: () => ({ scan: async () => ['0', []], del: async () => 0 }),
}));
vi.mock('bullmq', async (importOriginal) => ({
  ...(await importOriginal<typeof import('bullmq')>()),
  Queue: class {
    async add(name: string, data: unknown) {
      h.adds.push({ name, data });
    }
  },
}));
// A task the hand-off fails releases what it holds; none of that may reach this host's Docker.
vi.mock('../src/sandbox/task-auth-volume.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/sandbox/task-auth-volume.js')>()),
  cleanupTaskAuthVolumes: async () => ({ removed: [], failed: [] }),
  syncRefreshedAuthToUserVolumes: async () => undefined,
}));
vi.mock('../src/sandbox/ollama-provision.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/sandbox/ollama-provision.js')>()),
  unloadTaskOllamaCliModels: async () => undefined,
}));
vi.mock('@haive/shared/rag', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@haive/shared/rag')>()),
  resolveTaskEmbedTarget: async () => null,
}));

const url = process.env.HANDLE_RESULT_LOST_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/handle_result_lost_test'))
  throw new Error('Use a dedicated handle_result_lost_test database for the lost hand-off tests');

const EMAIL_INDEX = 'handle-result-lost-test-user';
const TYPE = 'handle_result_lost';
const S = 'hrl-source-step';
const FIX_TARGET = '07-phase-2-implement';
const E = 3;

type TaskInsert = typeof schema.tasks.$inferInsert;
type StepInsert = typeof schema.taskSteps.$inferInsert;
type StepRow = typeof schema.taskSteps.$inferSelect;
type Level = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

const LEVELS: Level[] = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];
const lines: { level: Level; fields: Record<string, unknown> }[] = [];

const recordLogs = () => {
  for (const level of LEVELS) {
    vi.spyOn(logger, level).mockImplementation(((first?: unknown) => {
      lines.push({
        level,
        fields:
          typeof first === 'object' && first !== null ? (first as Record<string, unknown>) : {},
      });
    }) as never);
  }
};
/** The lines that say a hand-off write lost its row or task: the ones that name a site. */
const handoffLines = () => lines.filter((line) => 'site' in line.fields);
const loudLines = () => lines.filter((line) => ['warn', 'error', 'fatal'].includes(line.level));

/** Where handleResult's hand-off can lose a write. `readsRow`: the write was on the pass's row, so
 *  its line carries the row's status. `parks`: a write that lands there parks the row. `recorded`:
 *  the events the hand-off has written by then. */
interface Site {
  name: string;
  readsRow: boolean;
  parks: boolean;
  task?: Partial<TaskInsert>;
  row: Partial<StepInsert>;
  ctx?: Partial<ResolvedTaskContext>;
  seed?: (taskId: string) => Promise<void>;
  result: (row: StepRow) => AdvanceStepResult;
  recorded: string[];
}

describe.skipIf(!url)('a hand-off write that loses its row or task says so, on Postgres', () => {
  let db: Database;
  let userId: string;

  const stub = (id: string, index: number): StepDefinition =>
    ({
      metadata: {
        id,
        workflowType: 'workflow' as WorkflowType,
        index,
        title: id,
        description: 'lost hand-off test stub',
        requiresCli: false,
      },
      async detect() {
        return {};
      },
      async apply() {
        return {};
      },
    }) as StepDefinition;

  const makeTask = async (over: Partial<TaskInsert> = {}) => {
    const [made] = await db
      .insert(schema.tasks)
      .values({
        userId,
        type: TYPE,
        title: 'lost hand-off',
        status: 'running',
        orchestrationEpoch: E,
        currentStepId: S,
        currentRound: 0,
        runListSnapshot: [S, FIX_TARGET],
        ...over,
      })
      .returning({ id: schema.tasks.id });
    return made!.id;
  };
  const makeRow = async (taskId: string, over: Partial<StepInsert> = {}) => {
    const [made] = await db
      .insert(schema.taskSteps)
      .values({
        taskId,
        stepId: S,
        stepIndex: 1,
        round: 0,
        title: S,
        status: 'running',
        runSeq: 0,
        ...over,
      })
      .returning();
    return made!;
  };
  const rowOf = async (rowId: string) =>
    (await db.select().from(schema.taskSteps).where(eq(schema.taskSteps.id, rowId)))[0];
  const eventTypes = async (taskId: string) =>
    (await db.select().from(schema.taskEvents).where(eq(schema.taskEvents.taskId, taskId)))
      .map((event) => event.eventType)
      .sort();

  const ctxFor = (
    taskId: string,
    over: Partial<ResolvedTaskContext> = {},
  ): ResolvedTaskContext => ({
    taskId,
    userId,
    workflowType: 'workflow' as WorkflowType,
    repoPath: '/tmp',
    workspacePath: '/tmp',
    cliProviderId: null,
    ignoreSavedStepClis: false,
    executionPath: null,
    metadata: null,
    orchestrationEpoch: E,
    currentStepId: S,
    currentRound: 0,
    status: 'running',
    completedAt: null,
    runListStrategy: 'static',
    runListSnapshot: [S, FIX_TARGET],
    customSteps: {},
    fixLoop: null,
    deadAt: null,
    ...over,
  });

  const loopBack =
    (over: Partial<Extract<AdvanceStepResult, { status: 'loop_back' }>> = {}) =>
    (row: StepRow): AdvanceStepResult => ({
      status: 'loop_back',
      row,
      diagnosis: 'a defect',
      sourceStepId: S,
      ...over,
    });
  const waitingForm = (row: StepRow): AdvanceStepResult => ({
    status: 'waiting_form',
    row,
    formSchema: { title: 'form', fields: [] },
  });
  const waitingCli = (row: StepRow): AdvanceStepResult => ({ status: 'waiting_cli', row });

  // Two rounds back the same complaint, and another step's between them: the round after trips it.
  const seedOscillation = async (taskId: string) => {
    await db.insert(schema.taskEvents).values([
      {
        taskId,
        eventType: 'fix_loop.requested',
        payload: { diagnosis: 'a defect', sourceStepId: S, round: 1 },
      },
      {
        taskId,
        eventType: 'fix_loop.requested',
        payload: { diagnosis: 'a different defect', sourceStepId: 'another-step', round: 2 },
      },
    ]);
  };

  // The producer stamps the marker in its park UPDATE; the hand-off preserves it.
  const FORM = {
    row: { status: 'waiting_form', waitingStartedAt: new Date() },
    result: waitingForm,
  } as const;
  const CLI = { row: { status: 'running' }, result: waitingCli } as const;
  const OSCILLATION = {
    row: { status: 'done', round: 2 },
    seed: seedOscillation,
    result: loopBack(),
  } as const;
  const ROUND_CAP = {
    task: { maxFixRounds: 0 },
    row: { status: 'done' },
    result: loopBack(),
  } as const;

  const WAITING_FORM_ROW: Site = {
    name: 'waiting_form_row',
    readsRow: true,
    parks: true,
    ...FORM,
    recorded: [],
  };
  const WAITING_FORM_TASK: Site = {
    name: 'waiting_form_task',
    readsRow: false,
    parks: true,
    ...FORM,
    recorded: [],
  };
  const WAITING_CLI_TASK: Site = {
    name: 'waiting_cli_task',
    readsRow: false,
    parks: false,
    ...CLI,
    recorded: [],
  };
  const OSCILLATION_ROW: Site = {
    name: 'oscillation_row',
    readsRow: true,
    parks: true,
    ...OSCILLATION,
    recorded: ['step.loop_back'],
  };
  const OSCILLATION_TASK: Site = {
    name: 'oscillation_task',
    readsRow: false,
    parks: true,
    ...OSCILLATION,
    recorded: ['step.loop_back', 'fix_loop.requested'],
  };
  const ROUND_CAP_ROW: Site = {
    name: 'round_cap_row',
    readsRow: true,
    parks: true,
    ...ROUND_CAP,
    recorded: ['step.loop_back'],
  };
  const ROUND_CAP_TASK: Site = {
    name: 'round_cap_task',
    readsRow: false,
    parks: true,
    ...ROUND_CAP,
    recorded: ['step.loop_back', 'fix_loop.requested'],
  };
  // The fix target is not in the run list, so the function would fail the task: unless it lost.
  const FIX_TARGET_SITE: Site = {
    name: 'fix_target',
    readsRow: true,
    parks: false,
    row: { status: 'done' },
    ctx: { runListSnapshot: [S] },
    result: loopBack({ uncapped: true }),
    recorded: ['step.loop_back'],
  };

  const ROW_SITES = [WAITING_FORM_ROW, OSCILLATION_ROW, ROUND_CAP_ROW, FIX_TARGET_SITE];
  const TASK_SITES = [
    WAITING_FORM_TASK,
    WAITING_CLI_TASK,
    OSCILLATION_TASK,
    ROUND_CAP_TASK,
    FIX_TARGET_SITE,
  ];
  const SITES = [
    WAITING_FORM_ROW,
    WAITING_FORM_TASK,
    WAITING_CLI_TASK,
    OSCILLATION_ROW,
    OSCILLATION_TASK,
    ROUND_CAP_ROW,
    ROUND_CAP_TASK,
    FIX_TARGET_SITE,
  ];

  /** A task and the row its pass left, as they stand when the pass returns its result. */
  interface Case {
    taskId: string;
    row: StepRow;
    ctx: ResolvedTaskContext;
    before: string[];
  }
  const open = async (site: Site, ctx: Partial<ResolvedTaskContext> = {}): Promise<Case> => {
    const taskId = await makeTask(site.task);
    const row = await makeRow(taskId, site.row);
    await site.seed?.(taskId);
    return {
      taskId,
      row,
      ctx: ctxFor(taskId, { ...site.ctx, ...ctx }),
      before: await eventTypes(taskId),
    };
  };
  const hand = (site: Site, c: Case) => handleResult(db, c.ctx, S, site.result(c.row));

  const setRow = (c: Case, set: Partial<StepInsert>) =>
    db
      .update(schema.taskSteps)
      .set({
        ...set,
        // These stand in for Retry / Skip / Stop, whose real writes close the marker.
        ...(set.status && ['pending', 'skipped', 'failed'].includes(set.status)
          ? { waitingStartedAt: null }
          : {}),
      })
      .where(eq(schema.taskSteps.id, c.row.id));
  const setTask = (c: Case, set: Partial<TaskInsert>) =>
    db.update(schema.tasks).set(set).where(eq(schema.tasks.id, c.taskId));
  const stopTask = (c: Case) =>
    setTask(c, { status: 'failed', errorMessage: 'Stopped by user', completedAt: new Date() });
  const deleteTask = (c: Case) => db.delete(schema.tasks).where(eq(schema.tasks.id, c.taskId));
  const parkedAt = async (c: Case) => (await rowOf(c.row.id))?.waitingStartedAt ?? null;

  /** Runs `landed` once the pass has read the task for its epoch check, the first read it makes:
   *  a Retry, a Cancel or a delete that commits between that check and a write. */
  const afterEpochCheck = (landed: () => Promise<unknown>) => {
    const read = db.query.tasks.findFirst.bind(db.query.tasks);
    let fired = false;
    vi.spyOn(db.query.tasks, 'findFirst').mockImplementation(((config: never) =>
      Promise.resolve(read(config)).then(async (task) => {
        if (!fired) {
          fired = true;
          await landed();
        }
        return task;
      })) as never);
  };
  /** A write to `table` that finds no row, whatever state the row is in. */
  const refuseWrites = (table: unknown) => {
    const update = db.update.bind(db);
    vi.spyOn(db, 'update').mockImplementation(((target: unknown) =>
      target === table
        ? { set: () => ({ where: () => ({ returning: async () => [] }) }) }
        : update(target as never)) as never);
  };

  interface Seen {
    level: 'info' | 'warn';
    reason: string;
    rowStatus?: string;
    taskStatus?: string;
    taskEpoch?: number;
  }
  /** Exactly one line for the lost write, with exactly these fields. */
  const expectLost = (site: Site, c: Case, seen: Seen) => {
    expect(handoffLines()).toEqual([
      {
        level: seen.level,
        fields: {
          taskId: c.taskId,
          stepId: S,
          rowId: c.row.id,
          site: site.name,
          reason: seen.reason,
          rowStatus: site.readsRow ? seen.rowStatus : undefined,
          taskStatus: seen.taskStatus,
          jobEpoch: E,
          taskEpoch: seen.taskEpoch,
        },
      },
    ]);
    expect(loudLines()).toHaveLength(seen.level === 'warn' ? 1 : 0);
  };
  /** The write that lost wrote nothing and the code after it did not run: the events are the ones
   *  the hand-off had written by then, and nothing was queued. */
  const expectReturned = async (site: Site, c: Case, ...extra: string[]) => {
    expect(await eventTypes(c.taskId)).toEqual([...c.before, ...site.recorded, ...extra].sort());
    expect(h.adds).toEqual([]);
  };

  beforeAll(async () => {
    db = createDatabase(url as string);
    h.db = db;
    await db.delete(schema.users).where(eq(schema.users.emailBlindIndex, EMAIL_INDEX));
    const [user] = await db
      .insert(schema.users)
      .values({
        emailEncrypted: 'handle-result-lost-test@test.local',
        emailBlindIndex: EMAIL_INDEX,
        passwordHash: 'not-real',
        role: 'user',
        status: 'active',
        tokenVersion: 0,
      })
      .returning();
    userId = user!.id;
    stepRegistry.override(stub(S, 1));
    stepRegistry.override(stub(FIX_TARGET, 2));
    setContainerCleanupRunner(async () => 0);
  });

  beforeEach(async () => {
    h.adds.length = 0;
    lines.length = 0;
    recordLogs();
    await db.delete(schema.tasks).where(eq(schema.tasks.userId, userId));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    setContainerCleanupRunner(null);
    await db.delete(schema.tasks).where(eq(schema.tasks.userId, userId));
    await db.delete(schema.users).where(eq(schema.users.emailBlindIndex, EMAIL_INDEX));
    await db.$client.end({ timeout: 5 });
  });

  const ROW_TAKEN: { reason: string; status: StepRow['status']; what: string }[] = [
    {
      reason: 'row_reset',
      status: 'pending',
      what: 'a Retry reset the row and has not moved the epoch yet',
    },
    { reason: 'row_skipped', status: 'skipped', what: 'a Skip took the row' },
    {
      reason: 'row_stopped',
      status: 'failed',
      what: 'a Stop, a cancel or the pass itself failed the row',
    },
  ];

  describe.each(ROW_SITES)('$name: the pass lost its row', (site) => {
    it.each(ROW_TAKEN)('$reason (info): $what', async ({ reason, status }) => {
      const c = await open(site);
      await setRow(c, { status });
      await hand(site, c);
      await expectReturned(site, c);
      expect(await parkedAt(c)).toBeNull();
      expectLost(site, c, {
        level: 'info',
        reason,
        rowStatus: status,
        taskStatus: 'running',
        taskEpoch: E,
      });
    });
  });

  interface TaskCause {
    reason: string;
    what: string;
    seen: { taskStatus: string; taskEpoch: number };
    land: (c: Case) => Promise<unknown>;
    /** After the pass's epoch check, not before it: the epoch check would have dropped the result. */
    afterCheck: boolean;
    events: string[];
  }
  const TASK_CAUSES: TaskCause[] = [
    {
      reason: 'task_failed',
      what: 'a Stop failed the task without moving the epoch',
      seen: { taskStatus: 'failed', taskEpoch: E },
      land: stopTask,
      afterCheck: false,
      events: [],
    },
    {
      reason: 'task_completed',
      what: 'the task completed',
      seen: { taskStatus: 'completed', taskEpoch: E },
      land: (c) => setTask(c, { status: 'completed', completedAt: new Date() }),
      afterCheck: false,
      events: [],
    },
    {
      reason: 'task_cancelled',
      what: 'a Cancel landed after the epoch check, and moved the epoch with it',
      seen: { taskStatus: 'cancelled', taskEpoch: E + 1 },
      land: (c) => markTaskCancelled(db, c.taskId),
      afterCheck: true,
      events: ['task.cancelled'],
    },
    {
      reason: 'epoch_moved',
      what: 'a Retry landed after the epoch check',
      seen: { taskStatus: 'running', taskEpoch: E + 1 },
      land: (c) => setTask(c, { orchestrationEpoch: E + 1 }),
      afterCheck: true,
      events: [],
    },
  ];

  describe.each(TASK_SITES)('$name: the pass lost its task', (site) => {
    // The function fails a task with writeTaskFailed, which refuses a cancelled or completed task
    // and a moved epoch but not one that already failed.
    const causes = TASK_CAUSES.filter(
      (cause) => cause.reason !== 'task_failed' || site !== FIX_TARGET_SITE,
    );
    it.each(causes)('$reason (info): $what', async (cause) => {
      const c = await open(site);
      if (cause.afterCheck) afterEpochCheck(() => cause.land(c));
      else await cause.land(c);
      await hand(site, c);
      await expectReturned(site, c, ...cause.events);
      expect((await parkedAt(c)) !== null).toBe(site.parks);
      expectLost(site, c, {
        level: 'info',
        reason: cause.reason,
        rowStatus: site.row.status,
        ...cause.seen,
      });
    });
  });

  describe('a row or task that is gone, or a loss nothing explains (warn)', () => {
    it('waiting_form_row -> task_gone: the task was deleted after the epoch check, its row with it', async () => {
      const c = await open(WAITING_FORM_ROW);
      afterEpochCheck(() => deleteTask(c));
      await hand(WAITING_FORM_ROW, c);
      expectLost(WAITING_FORM_ROW, c, { level: 'warn', reason: 'task_gone' });
      expect(h.adds).toEqual([]);
    });

    it('waiting_cli_task -> task_gone: the task was deleted after the epoch check', async () => {
      const c = await open(WAITING_CLI_TASK);
      afterEpochCheck(() => deleteTask(c));
      await hand(WAITING_CLI_TASK, c);
      expectLost(WAITING_CLI_TASK, c, { level: 'warn', reason: 'task_gone' });
      expect(h.adds).toEqual([]);
    });

    it('waiting_form_row -> row_gone: the row was deleted, the task is healthy', async () => {
      const c = await open(WAITING_FORM_ROW);
      await db.delete(schema.taskSteps).where(eq(schema.taskSteps.id, c.row.id));
      await hand(WAITING_FORM_ROW, c);
      await expectReturned(WAITING_FORM_ROW, c);
      expectLost(WAITING_FORM_ROW, c, {
        level: 'warn',
        reason: 'row_gone',
        taskStatus: 'running',
        taskEpoch: E,
      });
    });

    it('waiting_form_row -> unexplained: the row and the task are healthy and the write found nothing', async () => {
      const c = await open(WAITING_FORM_ROW);
      refuseWrites(schema.taskSteps);
      await hand(WAITING_FORM_ROW, c);
      await expectReturned(WAITING_FORM_ROW, c);
      expectLost(WAITING_FORM_ROW, c, {
        level: 'warn',
        reason: 'unexplained',
        rowStatus: 'waiting_form',
        taskStatus: 'running',
        taskEpoch: E,
      });
    });

    it('waiting_cli_task -> unexplained: the task is healthy and the write found nothing', async () => {
      const c = await open(WAITING_CLI_TASK);
      refuseWrites(schema.tasks);
      await hand(WAITING_CLI_TASK, c);
      await expectReturned(WAITING_CLI_TASK, c);
      expectLost(WAITING_CLI_TASK, c, {
        level: 'warn',
        reason: 'unexplained',
        taskStatus: 'running',
        taskEpoch: E,
      });
    });
  });

  describe('a dead mark (info)', () => {
    it('waiting_cli_task -> task_dead: the task is dead and nothing else explains the loss', async () => {
      const c = await open(WAITING_CLI_TASK);
      await setTask(c, { deadAt: new Date(), deadReason: 'a step this install does not register' });
      refuseWrites(schema.tasks);
      await hand(WAITING_CLI_TASK, c);
      await expectReturned(WAITING_CLI_TASK, c);
      expectLost(WAITING_CLI_TASK, c, {
        level: 'info',
        reason: 'task_dead',
        taskStatus: 'running',
        taskEpoch: E,
      });
    });
  });

  describe('the reason is the first that applies', () => {
    it('waiting_form_row -> row_stopped: the Stop failed the row and the task', async () => {
      const c = await open(WAITING_FORM_ROW);
      await setRow(c, { status: 'failed' });
      await stopTask(c);
      await hand(WAITING_FORM_ROW, c);
      await expectReturned(WAITING_FORM_ROW, c);
      expectLost(WAITING_FORM_ROW, c, {
        level: 'info',
        reason: 'row_stopped',
        rowStatus: 'failed',
        taskStatus: 'failed',
        taskEpoch: E,
      });
    });

    it('waiting_form_row -> row_reset: the Retry that reset the row has moved the epoch too', async () => {
      const c = await open(WAITING_FORM_ROW);
      await setRow(c, { status: 'pending' });
      afterEpochCheck(() => setTask(c, { orchestrationEpoch: E + 1 }));
      await hand(WAITING_FORM_ROW, c);
      await expectReturned(WAITING_FORM_ROW, c);
      expectLost(WAITING_FORM_ROW, c, {
        level: 'info',
        reason: 'row_reset',
        rowStatus: 'pending',
        taskStatus: 'running',
        taskEpoch: E + 1,
      });
    });
  });

  describe('a diagnostic that cannot be read (warn)', () => {
    const unreadable = new Error('connection terminated');
    const handOffWithUnreadableCause = async () => {
      const c = await open(WAITING_FORM_ROW);
      await setRow(c, { status: 'pending' });
      return c;
    };
    const expectOneUnreadLine = async (c: Case) => {
      await expect(hand(WAITING_FORM_ROW, c)).resolves.toBeUndefined();
      await expectReturned(WAITING_FORM_ROW, c);
      expect(handoffLines()).toEqual([
        {
          level: 'warn',
          fields: {
            err: unreadable,
            taskId: c.taskId,
            stepId: S,
            rowId: c.row.id,
            site: 'waiting_form_row',
            reason: 'read_failed',
            jobEpoch: E,
          },
        },
      ]);
      expect(loudLines()).toHaveLength(1);
    };

    it('waiting_form_row -> read_failed: the task cannot be read after the epoch check', async () => {
      const c = await handOffWithUnreadableCause();
      const read = db.query.tasks.findFirst.bind(db.query.tasks);
      let reads = 0;
      vi.spyOn(db.query.tasks, 'findFirst').mockImplementation(((config: never) =>
        ++reads === 1 ? read(config) : Promise.reject(unreadable)) as never);
      await expectOneUnreadLine(c);
    });

    it('waiting_form_row -> read_failed: the row cannot be read', async () => {
      const c = await handOffWithUnreadableCause();
      vi.spyOn(db.query.taskSteps, 'findFirst').mockRejectedValue(unreadable);
      await expectOneUnreadLine(c);
    });
  });

  describe('a result that is not a lost hand-off logs none', () => {
    it.each(SITES)(
      '$name: a task at a newer epoch drops the result on its one existing line',
      async (site) => {
        const c = await open(site);
        await setTask(c, { orchestrationEpoch: E + 1 });
        await hand(site, c);
        expect(lines).toEqual([
          {
            level: 'info',
            fields: { taskId: c.taskId, stepId: S, status: site.result(c.row).status },
          },
        ]);
        expect(await eventTypes(c.taskId)).toEqual(c.before);
        expect(h.adds).toEqual([]);
      },
    );

    it('fix_target: a target the run list lacks fails the task itself and logs no lost hand-off', async () => {
      const c = await open(FIX_TARGET_SITE);
      await hand(FIX_TARGET_SITE, c);
      expect(handoffLines()).toEqual([]);
      await expectReturned(FIX_TARGET_SITE, c, 'fix_loop.unroutable');
      const [task] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, c.taskId));
      expect(task?.status).toBe('failed');
    });

    const LANDING: {
      name: string;
      site: Site;
      ctx: Partial<ResolvedTaskContext>;
      events: string[];
      queued: number;
    }[] = [
      {
        name: 'waiting_form',
        site: WAITING_FORM_ROW,
        ctx: {},
        events: ['step.waiting_form'],
        queued: 0,
      },
      {
        name: 'waiting_cli',
        site: WAITING_CLI_TASK,
        ctx: {},
        events: ['step.waiting_cli'],
        queued: 0,
      },
      {
        name: 'oscillation',
        site: OSCILLATION_ROW,
        ctx: {},
        events: ['step.loop_back', 'fix_loop.requested', 'fix_loop.oscillation_detected'],
        queued: 0,
      },
      {
        name: 'round_cap',
        site: ROUND_CAP_ROW,
        ctx: {},
        events: ['step.loop_back', 'fix_loop.requested', 'fix_loop.escalated'],
        queued: 0,
      },
      {
        name: 'fix_target',
        site: FIX_TARGET_SITE,
        ctx: { runListSnapshot: [S, FIX_TARGET] },
        events: ['step.loop_back', 'fix_loop.requested', 'fix_loop.started'],
        queued: 1,
      },
    ];
    it.each(LANDING)('$name: a hand-off that lands', async ({ site, ctx, events, queued }) => {
      const c = await open(site, ctx);
      await hand(site, c);
      expect(handoffLines()).toEqual([]);
      expect(loudLines()).toEqual([]);
      expect(await eventTypes(c.taskId)).toEqual([...c.before, ...events].sort());
      expect(h.adds).toHaveLength(queued);
    });
  });
});
