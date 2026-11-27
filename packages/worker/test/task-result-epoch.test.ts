import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '@haive/database';
import {
  handleResult,
  markTaskCompleted,
  markTaskFailed,
  setContainerCleanupRunner,
} from '../src/queues/task-queue.js';
import {
  cleanupTaskAuthVolumes,
  findTaskAuthVolumes,
  syncRefreshedAuthToUserVolumes,
} from '../src/sandbox/task-auth-volume.js';
import { reapAllSessionsForTask } from '../src/sandbox/terminal-session-reaper.js';
import { resyncAfterTaskEnd } from '../src/project-state/set-aside.js';
import { unloadTaskOllamaCliModels } from '../src/sandbox/ollama-provision.js';
import { reconcileKbAuthorEntryOnTaskEnd } from '../src/step-engine/steps/_global-kb-promote.js';
import { resolveTaskEmbedTarget } from '@haive/shared/rag';
import { stepRegistry } from '../src/step-engine/registry.js';
import type { StepDefinition } from '../src/step-engine/step-definition.js';

vi.mock('../src/db.js', () => ({
  getDb: vi.fn(() => {
    throw new Error('no database in this test');
  }),
}));
// The failed-task teardown would otherwise inspect every CLI's auth volume on the host's Docker.
vi.mock('../src/sandbox/task-auth-volume.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/sandbox/task-auth-volume.js')>()),
  findTaskAuthVolumes: vi.fn(async () => []),
  cleanupTaskAuthVolumes: vi.fn(async () => ({ removed: [], failed: [] })),
  syncRefreshedAuthToUserVolumes: vi.fn(async () => undefined),
}));
vi.mock('../src/redis.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/redis.js')>()),
  getRedis: () => ({ scan: async () => ['0', []], del: async () => 0 }),
}));
vi.mock('../src/sandbox/ollama-provision.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/sandbox/ollama-provision.js')>()),
  unloadTaskOllamaCliModels: vi.fn(async () => undefined),
}));
vi.mock('@haive/shared/rag', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@haive/shared/rag')>()),
  resolveTaskEmbedTarget: vi.fn(async () => null),
}));

vi.mock('../src/sandbox/terminal-session-reaper.js', () => ({
  reapAllSessionsForTask: vi.fn(async () => 0),
}));
vi.mock('../src/project-state/set-aside.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resyncAfterTaskEnd: vi.fn(async () => undefined),
}));
vi.mock('../src/step-engine/steps/_global-kb-promote.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  reconcileKbAuthorEntryOnTaskEnd: vi.fn(async () => undefined),
}));

const TASK_UUID = '00000000-0000-4000-8000-000000000003';
const STEP_ID = 'epoch-fence-step';
stepRegistry.register({
  metadata: {
    id: STEP_ID,
    workflowType: 'workflow',
    index: 0,
    title: 'epoch fence step',
    description: 'a step whose result is handed off',
    requiresCli: false,
  },
  async detect() {
    return {};
  },
  async apply() {
    return {};
  },
} as StepDefinition);

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

/** A task behind a db that records every statement it is sent. The epoch a read returns and the
 *  one a write is matched against can differ: that is a Retry landing between the two. A write
 *  that names no epoch lands whatever the task's is. A step row write carrying the ownership
 *  guard lands only while `rowStatus` is not `pending` or `skipped`; `selectRows` is what a read
 *  of the task's events answers. */
function taskDb(
  readEpoch: number,
  writeEpoch = readEpoch,
  opts: { rowStatus?: string; selectRows?: unknown[] } = {},
) {
  const statements: string[] = [];
  const events: unknown[] = [];
  const db = {
    query: {
      tasks: { findFirst: async () => ({ orchestrationEpoch: readEpoch }) },
    },
    update: (table: unknown) => {
      statements.push(`update ${tableNameOf(table)}`);
      return {
        set: () => ({
          where: (cond: unknown) => ({
            returning: async () => {
              const values = conditionValues(cond);
              if (tableNameOf(table) === 'task_steps') {
                const guarded = values.includes('pending') && values.includes('skipped');
                const taken = opts.rowStatus === 'pending' || opts.rowStatus === 'skipped';
                return guarded && taken ? [] : [{ id: 'ts-1' }];
              }
              const epochs = values.filter((v) => typeof v === 'number');
              return epochs.length > 0 && !epochs.includes(writeEpoch) ? [] : [{ id: 'task-1' }];
            },
          }),
        }),
      };
    },
    execute: async () => undefined,
    transaction: async (fn: (tx: Database) => Promise<unknown>) =>
      fn({ ...db, execute: async () => undefined } as unknown as Database),
    insert: (table: unknown) => {
      statements.push(`insert ${tableNameOf(table)}`);
      return {
        values: async (v: { eventType?: unknown }) => {
          events.push(v.eventType);
        },
      };
    },
    select: () => {
      statements.push('select');
      if (!opts.selectRows) throw new Error('this test reads nothing but the epoch');
      const rows = opts.selectRows;
      // Awaited directly by some reads and cut with .limit() by others, ordered or not.
      const result = {
        then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
          Promise.resolve(rows).then(res, rej),
        limit: async () => rows,
        orderBy: () => ({ limit: async () => rows }),
      };
      return {
        from: (table: unknown) => ({
          where: (cond: unknown) => ({
            ...result,
            for: async () => {
              const values = conditionValues(cond);
              if (tableNameOf(table) === 'tasks' && values.includes('failed'))
                return [{ id: 'task-1' }];
              const owned = values.includes('pending') && values.includes('skipped');
              const taken = opts.rowStatus === 'pending' || opts.rowStatus === 'skipped';
              return tableNameOf(table) === 'task_steps' && owned && taken ? [] : rows;
            },
          }),
        }),
      };
    },
  } as unknown as Database;
  return { db, statements, events };
}

const ctx = { taskId: 'task-1', userId: 'user-1', orchestrationEpoch: 5 } as never;
const row = { id: 'ts-1', round: 0 } as never;

describe('a result handed off after a Retry moved the task on', () => {
  const cleanup = vi.fn(async () => 0);
  afterEach(() => {
    cleanup.mockClear();
    setContainerCleanupRunner(null);
  });

  it('records one auth-volume audit for two settlements of the same failure', async () => {
    const fake = createFakeDb(
      { tasks: schema.tasks, taskEvents: schema.taskEvents },
      { rowLocks: true },
    );
    const taskId = '00000000-0000-4000-8000-000000000001';
    fake.insert(schema.tasks, {
      id: taskId,
      status: 'failed',
      orchestrationEpoch: 5,
      completedAt: new Date(0),
    });
    const db = fake.db as unknown as Database;
    setContainerCleanupRunner(cleanup);
    vi.mocked(cleanupTaskAuthVolumes).mockResolvedValue({
      removed: [],
      failed: [{ name: 'busy', stderr: 'in use' }],
    });
    try {
      for (let i = 0; i < 2; i++)
        await handleResult(
          db,
          { taskId, userId: 'user-1', orchestrationEpoch: 5 } as never,
          STEP_ID,
          { status: 'superseded', row } as never,
        );
      expect(
        fake.rows(schema.taskEvents).filter((e) => e.eventType === 'auth_volumes.destroyed'),
      ).toHaveLength(1);
      fake.patch(schema.tasks, taskId, { orchestrationEpoch: 6 });
      await handleResult(
        db,
        { taskId, userId: 'user-1', orchestrationEpoch: 6 } as never,
        STEP_ID,
        { status: 'superseded', row } as never,
      );
      expect(
        fake.rows(schema.taskEvents).filter((e) => e.eventType === 'auth_volumes.destroyed'),
      ).toHaveLength(2);
    } finally {
      vi.mocked(cleanupTaskAuthVolumes).mockResolvedValue({ removed: [], failed: [] });
    }
  });

  it('records changed removal counts after an earlier failed audit', async () => {
    const fake = createFakeDb(
      { tasks: schema.tasks, taskEvents: schema.taskEvents },
      { rowLocks: true },
    );
    fake.insert(schema.tasks, {
      id: TASK_UUID,
      status: 'failed',
      orchestrationEpoch: 5,
      completedAt: new Date(0),
    });
    setContainerCleanupRunner(cleanup);
    vi.mocked(cleanupTaskAuthVolumes)
      .mockResolvedValueOnce({ removed: [], failed: [{ name: 'busy', stderr: 'in use' }] })
      .mockResolvedValueOnce({ removed: ['busy'], failed: [] });
    for (let i = 0; i < 2; i++)
      await handleResult(
        fake.db as unknown as Database,
        { taskId: TASK_UUID, userId: 'user-1', orchestrationEpoch: 5 } as never,
        STEP_ID,
        { status: 'superseded', row } as never,
      );
    expect(
      fake
        .rows(schema.taskEvents)
        .filter((e) => e.eventType === 'auth_volumes.destroyed')
        .map((e) => e.payload),
    ).toEqual([
      expect.objectContaining({ removed: 0, failed: 1 }),
      expect.objectContaining({ removed: 1, failed: 0 }),
    ]);
  });

  it('probes auth volumes before holding the settlement row and rechecks after the probes', async () => {
    const fake = createFakeDb(
      { tasks: schema.tasks, taskEvents: schema.taskEvents },
      { rowLocks: true },
    );
    fake.insert(schema.tasks, {
      id: TASK_UUID,
      status: 'failed',
      orchestrationEpoch: 5,
      completedAt: new Date(0),
    });
    setContainerCleanupRunner(cleanup);
    vi.mocked(cleanupTaskAuthVolumes).mockClear();
    vi.mocked(findTaskAuthVolumes).mockImplementationOnce(async () => {
      expect(fake.rowLocked(schema.tasks, TASK_UUID)).toBe(false);
      fake.patch(schema.tasks, TASK_UUID, { status: 'running', orchestrationEpoch: 6 });
      return ['volume'];
    });
    await handleResult(
      fake.db as unknown as Database,
      { taskId: TASK_UUID, userId: 'user-1', orchestrationEpoch: 5 } as never,
      STEP_ID,
      { status: 'superseded', row } as never,
    );
    expect(findTaskAuthVolumes).toHaveBeenCalled();
    expect(cleanupTaskAuthVolumes).not.toHaveBeenCalled();
  });

  it('superseded settlement preserves auth state when Retry wins after the failed-task check', async () => {
    const fake = createFakeDb({ tasks: schema.tasks, taskEvents: schema.taskEvents });
    const taskId = '00000000-0000-4000-8000-000000000001';
    fake.insert(schema.tasks, {
      id: taskId,
      status: 'failed',
      orchestrationEpoch: 5,
      completedAt: new Date(0),
    });
    setContainerCleanupRunner(async () => {
      fake.patch(schema.tasks, taskId, { status: 'running', orchestrationEpoch: 6 });
      return 0;
    });
    vi.mocked(cleanupTaskAuthVolumes).mockClear();
    await handleResult(
      fake.db as unknown as Database,
      { taskId, userId: 'user-1', orchestrationEpoch: 5 } as never,
      STEP_ID,
      { status: 'superseded', row } as never,
    );
    expect(fake.rows(schema.tasks)[0]).toMatchObject({ status: 'running', orchestrationEpoch: 6 });
    expect(cleanupTaskAuthVolumes).not.toHaveBeenCalled();
  });

  it('does not settle a newer failed attempt from a superseded pass', async () => {
    setContainerCleanupRunner(cleanup);
    const fake = createFakeDb({ tasks: schema.tasks });
    fake.insert(schema.tasks, { id: TASK_UUID, status: 'failed', orchestrationEpoch: 6 });
    const db = fake.db as unknown as Database;
    const reads = vi.spyOn(db.query.tasks, 'findFirst');
    await handleResult(
      db,
      { taskId: TASK_UUID, userId: 'user-1', orchestrationEpoch: 5 } as never,
      STEP_ID,
      { status: 'superseded', row } as never,
    );
    expect(reads).toHaveResolvedWith(undefined);
    expect(cleanup).not.toHaveBeenCalled();
  });

  it('hands nothing off once the task is at a newer epoch', async () => {
    const { db, statements } = taskDb(6);
    await handleResult(db, ctx, STEP_ID, { status: 'done', row, output: null } as never);
    await handleResult(db, ctx, STEP_ID, { status: 'failed', row, error: 'boom' } as never);
    expect(statements).toEqual([]);
  });

  it('fails nothing when the task moved on between the check and the write', async () => {
    setContainerCleanupRunner(cleanup);
    const { db, statements } = taskDb(5, 6);
    await handleResult(db, ctx, STEP_ID, { status: 'failed', row, error: 'boom' } as never);
    expect(statements).toEqual(['update tasks']);
    expect(cleanup).not.toHaveBeenCalled();
  });

  it('fails the task, and releases what it holds, while it is still at its epoch', async () => {
    setContainerCleanupRunner(cleanup);
    const { db, statements } = taskDb(5, 5, { selectRows: [] });
    await handleResult(db, ctx, STEP_ID, { status: 'failed', row, error: 'boom' } as never);
    expect(statements[0]).toBe('update tasks');
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('stamps a parked form and marks the task waiting while the pass owns the row', async () => {
    const { db, statements } = taskDb(5, 5, { rowStatus: 'waiting_form', selectRows: [] });
    await handleResult(db, ctx, STEP_ID, { status: 'waiting_form', row, formSchema: {} } as never);
    expect(statements[0]).toBe('update task_steps');
    expect(statements).toContain('update tasks');
    expect(statements.at(-1)).toBe('insert task_events');
  });

  it('marks nothing waiting once a Retry reset the parked row after the check', async () => {
    const { db, statements } = taskDb(5, 5, { rowStatus: 'pending' });
    await handleResult(db, ctx, STEP_ID, { status: 'waiting_form', row, formSchema: {} } as never);
    expect(statements).toEqual(['update task_steps']);
  });

  it('raises no fix-loop gate on a row a Retry reset after the check', async () => {
    // Past the fix-round cap, so the loop escalates to its gate on the source row.
    const { db, statements, events } = taskDb(5, 5, {
      rowStatus: 'pending',
      selectRows: [{ n: 99 }],
    });
    const loopBack = { status: 'loop_back', row, diagnosis: 'a defect', sourceStepId: STEP_ID };
    await handleResult(db, ctx, STEP_ID, loopBack as never);
    expect(statements).not.toContain('update task_steps');
    expect(statements).not.toContain('update tasks');
    // No request for a round the gate was never raised for.
    expect(events).toEqual([]);
  });

  it('completes nothing, and reaps nothing, once the task moved to a newer epoch', async () => {
    setContainerCleanupRunner(cleanup);
    const { db, statements } = taskDb(6);
    await markTaskCompleted(db, 'task-1', { epoch: 5 });
    expect(statements).toEqual(['update tasks']);
    expect(cleanup).not.toHaveBeenCalled();
  });
});

describe('failed-task settlement bookkeeping is best-effort', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => setContainerCleanupRunner(null));

  it.each(['capture', 'finish'] as const)(
    'runs the full teardown and does not throw when the %s fails',
    async (stage) => {
      const { db } = taskDb(5, 5, { selectRows: [] });
      const cleanup = vi.fn(async () => 0);
      setContainerCleanupRunner(cleanup);
      const capture = vi.spyOn(db.query.tasks, 'findFirst');
      if (stage === 'capture') capture.mockRejectedValueOnce(new Error('capture unavailable'));
      else capture.mockResolvedValueOnce({ status: 'failed', completedAt: new Date(0) } as never);
      const finish = vi.fn(async () => {
        throw new Error('finish unavailable');
      });
      Object.assign(db, { execute: finish });

      await expect(markTaskFailed(db, 'task-1', 'boom')).resolves.toBe(true);

      expect(cleanup).toHaveBeenCalledWith(db, 'task-1');
      expect(syncRefreshedAuthToUserVolumes).toHaveBeenCalledWith(db, 'task-1');
      expect(cleanupTaskAuthVolumes).toHaveBeenCalledWith('task-1', undefined, []);
      expect(reapAllSessionsForTask).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        'task-1',
        db,
      );
      expect(resyncAfterTaskEnd).toHaveBeenCalledWith(db, 'task-1');
      expect(resolveTaskEmbedTarget).toHaveBeenCalledWith(db, 'task-1');
      expect(unloadTaskOllamaCliModels).toHaveBeenCalledWith(db, 'task-1');
      expect(reconcileKbAuthorEntryOnTaskEnd).toHaveBeenCalledWith(
        db,
        'task-1',
        'failed',
        expect.anything(),
      );
      expect(finish).toHaveBeenCalledTimes(stage === 'capture' ? 0 : 1);
    },
  );
});
