import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configService } from '@haive/shared';
import {
  handleResult,
  resolveFixLoopGate,
  setContainerCleanupRunner,
} from '../src/queues/task-queue.js';
import { resetStepAndDownstream } from '../src/queues/_step-reset.js';
import { advanceStep } from '../src/step-engine/index.js';
import { stepRegistry } from '../src/step-engine/registry.js';
import {
  markModuleSchemaFailed,
  markModuleSchemaReady,
  markModuleSchemaUnready,
} from '../src/modules/schema-ready.js';
import type { StepDefinition } from '../src/step-engine/step-definition.js';
import { gate2VerifyApprovalStep } from '../src/step-engine/steps/workflow/09-gate-2-verify-approval.js';

function tableNameOf(table: unknown): string {
  if (table && typeof table === 'object') {
    const obj = table as Record<string, unknown>;
    const sym = Object.getOwnPropertySymbols(obj).find((s) => s.description === 'drizzle:Name');
    if (sym) {
      const name = obj[sym as unknown as string];
      if (typeof name === 'string') return name;
    }
  }
  return '';
}

/** Values a drizzle condition binds, in order. */
function conditionValues(node: unknown, acc: unknown[] = []): unknown[] {
  if (!node || typeof node !== 'object') return acc;
  if (Array.isArray(node)) {
    for (const item of node) conditionValues(item, acc);
    return acc;
  }
  const obj = node as Record<string, unknown>;
  if ('value' in obj && 'encoder' in obj) acc.push(obj.value);
  const chunks = obj.queryChunks;
  if (Array.isArray(chunks)) for (const c of chunks) conditionValues(c, acc);
  return acc;
}

interface Comparison {
  column: string;
  op: string;
  values: unknown[];
}

/** Each comparison a drizzle condition makes: the column it names, its operator and the values it
 *  binds (`eq`, `ne`, `inArray` and `notInArray` alike). */
function comparisons(node: unknown, acc: Comparison[] = []): Comparison[] {
  if (!node || typeof node !== 'object') return acc;
  if (Array.isArray(node)) {
    for (const item of node) comparisons(item, acc);
    return acc;
  }
  const chunks = (node as { queryChunks?: unknown }).queryChunks;
  if (!Array.isArray(chunks)) return acc;
  const column = chunks.find(
    (c): c is { name: string } =>
      !!c && typeof c === 'object' && 'columnType' in c && typeof c.name === 'string',
  );
  const op = chunks
    .map((c) =>
      !!c && typeof c === 'object' && !('encoder' in c) && 'value' in c && Array.isArray(c.value)
        ? c.value.join('').trim()
        : '',
    )
    .find((text) => text !== '');
  if (column && op) {
    acc.push({ column: column.name, op, values: conditionValues(chunks) });
    return acc;
  }
  for (const c of chunks) comparisons(c, acc);
  return acc;
}

/** A running task at epoch 5 behind a db whose task writes land only while the epoch they name,
 *  if any, is still the task's. `onSelect` stands in for whatever the job does next. */
const h = vi.hoisted(() => {
  const state = {
    taskEpoch: 5,
    /** Reads answer empty instead of stopping the job. */
    readsAnswer: false,
    onSelect: (() => {}) as () => void,
    /** Runs once a read of the task row has answered, so a Retry can land right after one. */
    onRead: (() => {}) as () => void,
    taskWrites: [] as { epochs: unknown[]; landed: boolean }[],
    events: [] as unknown[],
    inserted: [] as { eventType?: unknown; payload?: unknown }[],
    /** What the task queue is asked to enqueue. */
    add: vi.fn(async (..._args: unknown[]) => undefined),
    /** The source row still reads as this pass's, not reset by a Retry. */
    sourceOwned: true,
    /** The task's fix-round cap; unset means the default. */
    maxFixRounds: undefined as number | undefined,
    /** What a read of the task's recorded fix requests answers. */
    requestedEvents: [] as unknown[],
    /** The task's status: a Stop fails it without moving the epoch. */
    taskStatus: 'running',
    /** Set to hold the task on a pause. */
    pausedAt: null as Date | null,
    /** The step row an advance reads before it runs the step. */
    existingRow: null as Record<string, unknown> | null,
    /** The row a park writes to, as upsertRow answers it. */
    parkRow: {} as Record<string, unknown>,
    /** The envelope seen under the park transaction's row lock, independent of the older snapshot. */
    currentIntegrationWait: null as null | { causes: unknown[]; continuation?: true },
    /** What the runtime-admission gate answers. */
    admission: { decision: 'admit' } as Record<string, unknown>,
    /** Reads that confirm the job still holds the task. */
    taskHolds: [] as { epochs: unknown[]; landed: boolean }[],
    /** Every patch written to a step row. */
    stepPatches: [] as Record<string, unknown>[],
    /** Every patch a task write landed. */
    landedTaskPatches: [] as Record<string, unknown>[],
    taskType: 'workflow',
    currentStepId: 'epoch-job-step',
    /** Set when the task's repository is gone, so the job cannot resolve the task. */
    repoGone: false,
    /** Set when the task row itself cannot be read. */
    taskReadFails: false,
    /** What a read of a step's ended runs answers, newest first. */
    endedRuns: [] as Record<string, unknown>[],
    /** Every error hint written to a step row and not rolled back. */
    hints: [] as Record<string, unknown>[],
    /** Set to fail the step's error-hint write and the usage-snapshot read. */
    hintWriteFails: false,
    snapshotReadFails: false,
    /** What the skip-first step's shouldRun answers. */
    shouldRun: (async () => true) as () => Promise<boolean>,
    /** What classifyRuntime reports for an if-serving step. */
    runtimeMode: 'none' as string,
    /** What a read of a module's row answers. */
    moduleRows: [] as { deactivatedAt: Date | null }[],
    /** What the reads after the first answer, when an admin switches the module in between. */
    laterModuleRows: null as { deactivatedAt: Date | null }[] | null,
    /** How many reads of a module's row were made. */
    moduleReads: 0,
  };
  return { state };
});

/** Whether a task write or read matches the task: every comparison it makes on the status or the
 *  epoch holds for the task as it stands. */
function taskMatches(cond: unknown): { epochs: unknown[]; landed: boolean } {
  const epochs = conditionValues(cond).filter((v) => typeof v === 'number');
  const status = h.state.taskStatus;
  const landed = comparisons(cond).every(({ column, op, values }) => {
    if (column === 'orchestration_epoch') return values[0] === h.state.taskEpoch;
    if (column !== 'status') return true;
    if (op === '=') return values[0] === status;
    if (op === 'in') return values.includes(status);
    if (op === 'not in') return !values.includes(status);
    throw new Error(`the fake does not model status ${op}`);
  });
  return { epochs, landed };
}

const db = {
  query: {
    tasks: {
      findFirst: async () => {
        if (h.state.taskReadFails) throw new Error('the task read failed');
        const task = {
          id: 'task-1',
          userId: 'user-1',
          type: h.state.taskType,
          repositoryId: 'repo-1',
          status: h.state.taskStatus,
          orchestrationEpoch: h.state.taskEpoch,
          metadata: null,
          cliProviderId: null,
          ignoreSavedStepClis: false,
          executionPath: null,
          currentStepId: h.state.currentStepId,
          currentRound: 0,
          maxFixRounds: h.state.maxFixRounds,
        };
        h.state.onRead();
        return task;
      },
    },
    repositories: {
      findFirst: async () =>
        h.state.repoGone ? undefined : { storagePath: '/tmp/repo', localPath: null },
    },
    cliProviders: { findFirst: async () => ({ name: 'claude-code' }) },
    // The root merge fence a reopen checks: no setup row, no merge claim, no merge left open.
    taskSteps: { findFirst: async () => undefined, findMany: async () => [] },
    mergeDirClaims: { findFirst: async () => undefined },
    taskEvents: { findFirst: async () => undefined, findMany: async () => [] },
    taskTypeDefinitions: {
      findFirst: async () =>
        h.state.taskType === 'workflow' ? undefined : { runListStrategy: 'static' },
    },
  },
  select: (fields?: Record<string, unknown>) => {
    h.state.onSelect();
    if (!h.state.readsAnswer) throw new Error('the job went no further');
    return {
      // No recorded module intents in this fixture; the keyed moduleRows below are per-step gate probes.
      from: (table: unknown) =>
        Object.assign(tableNameOf(table) === 'modules' ? Promise.resolve([]) : {}, {
          where: (cond: unknown) => {
            const name = tableNameOf(table);
            // Awaited directly by some reads, cut with .limit() by others, and locked by the
            // hand-off and the park.
            return Object.assign(Promise.resolve([]), {
              limit: async () => {
                if (name === 'usage_window_snapshots' && h.state.snapshotReadFails) {
                  throw new Error('the usage snapshot read failed');
                }
                if (name === 'modules') {
                  h.state.moduleReads += 1;
                  return h.state.moduleReads > 1 && h.state.laterModuleRows
                    ? h.state.laterModuleRows
                    : h.state.moduleRows;
                }
                if (fields && 'pausedAt' in fields) {
                  return h.state.pausedAt ? [{ pausedAt: h.state.pausedAt }] : [];
                }
                if (fields && 'status' in fields && name === 'tasks') {
                  return [{ status: h.state.taskStatus }];
                }
                if (!fields && name === 'task_steps' && h.state.existingRow) {
                  return [h.state.existingRow];
                }
                return [];
              },
              for: async () => {
                if (name === 'task_steps' && fields && 'integrationWait' in fields) {
                  return h.state.sourceOwned
                    ? [{ integrationWait: h.state.currentIntegrationWait }]
                    : [];
                }
                if (name === 'modules') {
                  h.state.moduleReads += 1;
                  return h.state.moduleReads > 1 && h.state.laterModuleRows
                    ? h.state.laterModuleRows
                    : h.state.moduleRows;
                }
                if (name === 'tasks') {
                  const held = taskMatches(cond);
                  h.state.taskHolds.push(held);
                  return held.landed ? [{ id: 'task-1' }] : [];
                }
                return h.state.sourceOwned ? [{ id: 'ts-1' }] : [];
              },
              orderBy: () => {
                const rows =
                  name === 'cli_invocations' ? h.state.endedRuns : h.state.requestedEvents;
                return Object.assign(Promise.resolve(rows), { limit: async () => rows });
              },
            });
          },
        }),
    };
  },
  insert: () => ({
    values: async (v: { eventType?: unknown; payload?: unknown }) => {
      h.state.events.push(v.eventType);
      h.state.inserted.push(v);
    },
  }),
  update: (table: unknown) => ({
    set: (patch: Record<string, unknown>) => {
      if (tableNameOf(table) === 'task_steps') h.state.stepPatches.push(patch);
      if (tableNameOf(table) === 'task_steps' && 'errorHint' in patch) h.state.hints.push(patch);
      return {
        where: (cond: unknown) => ({
          then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => {
            const failed = tableNameOf(table) === 'task_steps' && 'errorHint' in patch;
            return (
              failed && h.state.hintWriteFails
                ? Promise.reject(new Error('the hint write failed'))
                : Promise.resolve(undefined)
            ).then(resolve, reject);
          },
          returning: async () => {
            const values = conditionValues(cond);
            // A step row written under the ownership guard lands only while the pass still owns it.
            if (tableNameOf(table) === 'task_steps') {
              if ('errorHint' in patch && h.state.hintWriteFails) {
                throw new Error('the hint write failed');
              }
              const guarded = values.includes('pending') && values.includes('skipped');
              return guarded && !h.state.sourceOwned ? [] : [{ id: 'ts-1' }];
            }
            const write = taskMatches(cond);
            h.state.taskWrites.push(write);
            if (write.landed) h.state.landedTaskPatches.push(patch);
            return write.landed ? [{ id: 'task-1' }] : [];
          },
        }),
      };
    },
  }),
  execute: async () => undefined,
  // A throw rolls back the hints the transaction wrote.
  transaction: async (fn: (tx: unknown) => unknown) => {
    const written = h.state.hints.length;
    try {
      return await fn(db);
    } catch (err) {
      h.state.hints.length = written;
      throw err;
    }
  },
};

vi.mock('../src/db.js', () => ({ getDb: () => db }));
vi.mock('../src/redis.js', () => ({
  getBullRedis: () => ({}),
  getRedis: () => ({ scan: async () => ['0', []], del: async () => 0 }),
}));
vi.mock('bullmq', async (importOriginal) => ({
  ...(await importOriginal<typeof import('bullmq')>()),
  Queue: class {
    add(...args: unknown[]) {
      return h.state.add(...args);
    }
  },
}));
vi.mock('../src/step-engine/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/step-engine/index.js')>()),
  upsertRow: vi.fn(async () => h.state.parkRow),
  advanceStep: vi.fn(async () => ({ status: 'superseded', row: h.state.parkRow })),
}));
vi.mock('../src/sandbox/runtime-admission.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/sandbox/runtime-admission.js')>()),
  runtimeAdmission: vi.fn(async () => h.state.admission),
}));
vi.mock('../src/step-engine/steps/workflow/_app-runtime.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/step-engine/steps/workflow/_app-runtime.js')>()),
  classifyRuntime: vi.fn(async () => ({ mode: h.state.runtimeMode })),
}));
vi.mock('../src/queues/_step-reset.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/queues/_step-reset.js')>()),
  resetStepAndDownstream: vi.fn(async () => ({ newEpoch: 7 })),
}));
// A task's teardown would otherwise run docker against the host: every CLI's auth volume on a
// failure, and the runners and the IDE's volume on a definitive end.
vi.mock('../src/sandbox/task-auth-volume.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/sandbox/task-auth-volume.js')>()),
  findTaskAuthVolumes: async () => [],
  cleanupTaskAuthVolumes: vi.fn(async () => ({ removed: [], failed: [] })),
  syncRefreshedAuthToUserVolumes: vi.fn(async () => undefined),
}));
vi.mock('../src/sandbox/ddev-runner.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/sandbox/ddev-runner.js')>()),
  killTaskDdevRunners: vi.fn(async () => 0),
}));
vi.mock('../src/sandbox/app-runner.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/sandbox/app-runner.js')>()),
  killTaskAppRunners: vi.fn(async () => 0),
}));
vi.mock('../src/sandbox/ide-runner.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/sandbox/ide-runner.js')>()),
  killTaskIdeContainers: vi.fn(async () => 0),
}));
vi.mock('../src/sandbox/ollama-provision.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/sandbox/ollama-provision.js')>()),
  unloadTaskOllamaCliModels: vi.fn(async () => undefined),
}));
vi.mock('@haive/shared/rag', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@haive/shared/rag')>()),
  resolveTaskEmbedTarget: vi.fn(async () => null),
}));

// The admission fence stays closed in production; this file lifts it only so a pin reaches the router.
vi.mock('../src/step-engine/execution-contract-support.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/step-engine/execution-contract-support.js')>()),
  assertWorkerExecutionContractSupported: vi.fn(),
}));

stepRegistry.register(gate2VerifyApprovalStep as unknown as StepDefinition);
const plainStep = (id: string, workflowType: string, extra: object = {}) =>
  ({
    metadata: { id, workflowType, index: 1, title: id, description: id, requiresCli: false },
    async detect() {
      return {};
    },
    async apply() {
      return {};
    },
    ...extra,
  }) as unknown as StepDefinition;
for (const id of ['epoch-job-step', 'epoch-job-target', '07-phase-2-implement'])
  stepRegistry.register(plainStep(id, 'workflow'));
const CAPABLE = 'module.epoch-fix.target';
const PLAIN = 'module.epoch-fix.plain';
stepRegistry.register(
  plainStep(CAPABLE, 'module.epoch-fix', { fixConsumer: { version: 1 }, editsCodeOrTests: true }),
);
stepRegistry.register(plainStep(PLAIN, 'module.epoch-fix'));

beforeEach(() => {
  vi.spyOn(configService, 'getFresh').mockResolvedValue('normal');
});

afterEach(() => {
  h.state.taskEpoch = 5;
  h.state.readsAnswer = false;
  h.state.onSelect = () => {};
  h.state.onRead = () => {};
  h.state.taskWrites = [];
  h.state.events = [];
  h.state.inserted = [];
  h.state.add.mockClear();
  h.state.sourceOwned = true;
  h.state.maxFixRounds = undefined;
  h.state.requestedEvents = [];
  h.state.taskStatus = 'running';
  h.state.pausedAt = null;
  h.state.existingRow = null;
  h.state.parkRow = {};
  h.state.currentIntegrationWait = null;
  h.state.admission = { decision: 'admit' };
  h.state.taskHolds = [];
  h.state.stepPatches = [];
  h.state.hints = [];
  h.state.landedTaskPatches = [];
  h.state.taskType = 'workflow';
  h.state.currentStepId = 'epoch-job-step';
  h.state.repoGone = false;
  h.state.taskReadFails = false;
  h.state.endedRuns = [];
  h.state.hintWriteFails = false;
  h.state.snapshotReadFails = false;
  h.state.shouldRun = async () => true;
  h.state.runtimeMode = 'none';
  h.state.moduleRows = [];
  h.state.laterModuleRows = null;
  h.state.moduleReads = 0;
  markModuleSchemaReady('epoch-fix');
  vi.restoreAllMocks();
  vi.mocked(advanceStep).mockClear();
  setContainerCleanupRunner(null);
});

const pin = (stepId: string) => ({
  version: 1,
  guardedSpans: [],
  fixTarget: { stepId, capabilityVersion: 1 },
});
const GATE = { id: 'ts-1', stepId: 'epoch-job-step', round: 1 };
const ctx = (snapshot: string[], executionContract: unknown) => ({
  taskId: 'task-1',
  userId: 'user-1',
  status: 'running',
  workflowType: 'custom',
  orchestrationEpoch: 5,
  runListStrategy: 'static',
  runListSnapshot: snapshot,
  executionContract,
});
const loopBack = {
  status: 'loop_back',
  row: { id: 'ts-1', round: 0 },
  diagnosis: 'a defect',
  sourceStepId: 'epoch-job-step',
  uncapped: true,
};
const failure = () => h.state.landedTaskPatches.find((p) => p.status === 'failed');
const notCapable = (id: string) =>
  `fix loop target ${id} of task type custom is not a registered module step with fix consumer version 1`;

describe('a fix round whose pinned custom target cannot be routed', () => {
  const cases: [string, string[], string, string][] = [
    [
      'an unregistered module step',
      ['epoch-job-target', 'epoch-job-step'],
      'module.epoch-fix.ghost',
      notCapable('module.epoch-fix.ghost'),
    ],
    [
      'a registered step without the capability',
      ['epoch-job-target', PLAIN, 'epoch-job-step'],
      PLAIN,
      notCapable(PLAIN),
    ],
    [
      'a capable step that is not in the run list',
      ['epoch-job-target', 'epoch-job-step'],
      CAPABLE,
      `fix loop target ${CAPABLE} is not in the run list of task type custom`,
    ],
  ];
  describe.each(cases)('%s', (_name, snapshot, target, reason) => {
    it('fails the task naming the reason and resets and queues nothing, on a step fix request', async () => {
      h.state.readsAnswer = true;
      vi.mocked(resetStepAndDownstream).mockClear();
      await handleResult(
        db as never,
        ctx(snapshot, pin(target)) as never,
        'epoch-job-step',
        loopBack as never,
      );
      expect(failure()?.errorMessage).toBe(reason);
      expect(h.state.events).toContain('fix_loop.unroutable');
      expect(h.state.events).not.toContain('fix_loop.started');
      expect(vi.mocked(resetStepAndDownstream)).not.toHaveBeenCalled();
      expect(h.state.add).not.toHaveBeenCalled();
    });

    it('fails the task naming the reason and resets and queues nothing, on the round-limit Continue', async () => {
      h.state.readsAnswer = true;
      vi.mocked(resetStepAndDownstream).mockClear();
      await resolveFixLoopGate(
        db as never,
        ctx(snapshot, pin(target)) as never,
        GATE as never,
        'continue',
        1,
        '',
      );
      expect(failure()?.errorMessage).toBe(reason);
      expect(h.state.events).toContain('fix_loop.unroutable');
      expect(h.state.events).not.toContain('fix_loop.continued');
      expect(vi.mocked(resetStepAndDownstream)).not.toHaveBeenCalled();
      expect(h.state.add).not.toHaveBeenCalled();
    });
  });

  it('fails a malformed pin by name instead of routing to 07, at a step fix request', async () => {
    h.state.readsAnswer = true;
    vi.mocked(resetStepAndDownstream).mockClear();
    await handleResult(
      db as never,
      ctx(['epoch-job-target', '07-phase-2-implement', 'epoch-job-step'], { version: 99 }) as never,
      'epoch-job-step',
      loopBack as never,
    );
    expect(failure()?.errorMessage).toBe(
      'fix loop target of task type custom cannot be read from its pinned execution contract',
    );
    expect(vi.mocked(resetStepAndDownstream)).not.toHaveBeenCalled();
    expect(h.state.add).not.toHaveBeenCalled();
  });

  it('fails a malformed pin by name at the round-limit Continue', async () => {
    h.state.readsAnswer = true;
    vi.mocked(resetStepAndDownstream).mockClear();
    await resolveFixLoopGate(
      db as never,
      ctx(['epoch-job-target', '07-phase-2-implement', 'epoch-job-step'], { version: 99 }) as never,
      GATE as never,
      'continue',
      1,
      '',
    );
    expect(failure()?.errorMessage).toBe(
      'fix loop target of task type custom cannot be read from its pinned execution contract',
    );
    expect(h.state.events).not.toContain('fix_loop.continued');
    expect(vi.mocked(resetStepAndDownstream)).not.toHaveBeenCalled();
    expect(h.state.add).not.toHaveBeenCalled();
  });
});

describe('a fix round whose pinned custom target is valid', () => {
  const snapshot = ['epoch-job-target', CAPABLE, 'epoch-job-step'];

  it('routes a step fix request to the pinned step, which also proves the reset spy is wired', async () => {
    h.state.readsAnswer = true;
    vi.mocked(resetStepAndDownstream).mockClear();
    vi.mocked(resetStepAndDownstream).mockResolvedValueOnce(null);
    await handleResult(
      db as never,
      ctx(snapshot, pin(CAPABLE)) as never,
      'epoch-job-step',
      loopBack as never,
    );
    expect(failure()).toBeUndefined();
    expect(vi.mocked(resetStepAndDownstream)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(resetStepAndDownstream).mock.calls[0]![2]).toBe(CAPABLE);
    expect(h.state.events).toContain('fix_loop.started');
    expect(h.state.add.mock.lastCall?.[1]).toMatchObject({ stepId: CAPABLE, round: 1 });
  });

  it('still routes to 07 with no pin while the capable step sits in the run list', async () => {
    h.state.readsAnswer = true;
    vi.mocked(resetStepAndDownstream).mockClear();
    vi.mocked(resetStepAndDownstream).mockResolvedValueOnce(null);
    await handleResult(
      db as never,
      ctx([...snapshot, '07-phase-2-implement'], null) as never,
      'epoch-job-step',
      loopBack as never,
    );
    expect(failure()).toBeUndefined();
    expect(vi.mocked(resetStepAndDownstream).mock.calls[0]![2]).toBe('07-phase-2-implement');
  });

  it('lets the pin win over a live fix loop that names another step', async () => {
    h.state.readsAnswer = true;
    vi.mocked(resetStepAndDownstream).mockClear();
    vi.mocked(resetStepAndDownstream).mockResolvedValueOnce(null);
    const withLive = {
      ...ctx(snapshot, pin(CAPABLE)),
      fixLoop: {
        targetStepId: '08c-code-review',
        humanRejectSourceStepIds: [],
        honoredConstraintSourceStepIds: [],
      },
    };
    await handleResult(db as never, withLive as never, 'epoch-job-step', loopBack as never);
    expect(failure()).toBeUndefined();
    expect(vi.mocked(resetStepAndDownstream).mock.calls[0]![2]).toBe(CAPABLE);
  });

  it('routes the round-limit Continue to the pinned step', async () => {
    vi.mocked(resetStepAndDownstream).mockResolvedValueOnce(null);
    h.state.readsAnswer = true;
    await resolveFixLoopGate(
      db as never,
      ctx(snapshot, pin(CAPABLE)) as never,
      GATE as never,
      'continue',
      1,
      '',
    );
    expect(failure()).toBeUndefined();
    expect(h.state.events).not.toContain('fix_loop.unroutable');
    expect(h.state.add.mock.lastCall?.[1]).toMatchObject({ stepId: CAPABLE, round: 2 });
  });
});

describe('a fix round whose pinned custom target module cannot run', () => {
  const snapshot = ['epoch-job-target', CAPABLE, 'epoch-job-step'];
  const off: [string, () => void][] = [
    ['deactivated', () => (h.state.moduleRows = [{ deactivatedAt: new Date() }])],
    [
      'schema setup failed',
      () => {
        markModuleSchemaUnready('epoch-fix');
        markModuleSchemaFailed('epoch-fix');
      },
    ],
  ];

  describe.each(off)('%s', (_name, switchOff) => {
    it('fails the task by name before the round is entered, at a step fix request', async () => {
      h.state.readsAnswer = true;
      switchOff();
      vi.mocked(resetStepAndDownstream).mockClear();
      await handleResult(
        db as never,
        ctx(snapshot, pin(CAPABLE)) as never,
        'epoch-job-step',
        loopBack as never,
      );
      expect(failure()?.errorMessage).toContain(`fix loop target ${CAPABLE}`);
      expect(h.state.events).toContain('fix_loop.unroutable');
      expect(h.state.events).not.toContain('fix_loop.started');
      expect(vi.mocked(resetStepAndDownstream)).not.toHaveBeenCalled();
      expect(h.state.add).not.toHaveBeenCalled();
    });

    it('fails the task by name before the round is entered, at the round-limit Continue', async () => {
      h.state.readsAnswer = true;
      switchOff();
      vi.mocked(resetStepAndDownstream).mockClear();
      await resolveFixLoopGate(
        db as never,
        ctx(snapshot, pin(CAPABLE)) as never,
        GATE as never,
        'continue',
        1,
        '',
      );
      expect(failure()?.errorMessage).toContain(`fix loop target ${CAPABLE}`);
      expect(h.state.events).toContain('fix_loop.unroutable');
      expect(h.state.events).not.toContain('fix_loop.continued');
      expect(vi.mocked(resetStepAndDownstream)).not.toHaveBeenCalled();
      expect(h.state.add).not.toHaveBeenCalled();
    });
  });

  const routes: [string, () => void][] = [
    ['an active module row', () => (h.state.moduleRows = [{ deactivatedAt: null }])],
    ['no module row', () => {}],
    ['a schema that is merely unready', () => markModuleSchemaUnready('epoch-fix')],
  ];
  it.each(routes)('still routes with %s', async (_name, setUp) => {
    h.state.readsAnswer = true;
    setUp();
    vi.mocked(resetStepAndDownstream).mockClear();
    vi.mocked(resetStepAndDownstream).mockResolvedValueOnce(null);
    await handleResult(
      db as never,
      ctx(snapshot, pin(CAPABLE)) as never,
      'epoch-job-step',
      loopBack as never,
    );
    expect(failure()).toBeUndefined();
    expect(vi.mocked(resetStepAndDownstream).mock.calls[0]![2]).toBe(CAPABLE);
    expect(h.state.events).toContain('fix_loop.started');
  });

  it('reads no module row for a leg with no pin or a malformed pin', async () => {
    h.state.readsAnswer = true;
    vi.mocked(resetStepAndDownstream).mockClear();
    vi.mocked(resetStepAndDownstream).mockResolvedValueOnce(null);
    await handleResult(
      db as never,
      ctx([...snapshot, '07-phase-2-implement'], null) as never,
      'epoch-job-step',
      loopBack as never,
    );
    await handleResult(
      db as never,
      ctx(['epoch-job-target', '07-phase-2-implement', 'epoch-job-step'], { version: 99 }) as never,
      'epoch-job-step',
      loopBack as never,
    );
    expect(h.state.moduleReads).toBe(0);
  });
});
