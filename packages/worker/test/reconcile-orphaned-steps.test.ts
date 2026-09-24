import { describe, expect, it } from 'vitest';
import type { Database } from '@haive/database';
import { reconcileOrphanedSteps } from '../src/queues/task-queue.js';

/** Every column referenced anywhere in a drizzle condition tree. Structural, so the test
 *  asserts what the query actually filters on rather than matching source text. */
function conditionColumns(node: unknown, acc: string[] = []): string[] {
  if (!node || typeof node !== 'object') return acc;
  const obj = node as Record<string, unknown>;
  if (typeof obj.name === 'string' && 'columnType' in obj) acc.push(obj.name);
  const chunks = obj.queryChunks;
  if (Array.isArray(chunks)) for (const c of chunks) conditionColumns(c, acc);
  return acc;
}

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

interface RecordedUpdate {
  table: string;
  set: Record<string, unknown>;
  where: unknown;
}

/** One `waiting_cli` step that the task has ALREADY moved past, so reconcile takes the
 *  abandoned-chain branch: it requeues the row and never touches BullMQ. That keeps the test
 *  on the only thing it is about — the predicate of the orphan update. */
function makeDb(recorded: RecordedUpdate[]): Database {
  const stuck = {
    taskStepId: 'ts-1',
    taskId: 'task-1',
    stepId: '09_5-skill-generation',
    round: 0,
    userId: 'user-1',
    epoch: 3,
    currentStepId: 'some-later-step',
    currentRound: 0,
  };
  let pass = 0;
  const db = {
    select: (_fields?: unknown) => ({
      from: (_table: unknown) => {
        const whereFn = (_cond: unknown) => ({
          // requeueAbandonedOrphan's read of the step row — empty, so it returns early.
          limit: async (_n: number) => [],
          // The two reconcile passes await .where() directly. Pass 1 finds the stuck step,
          // pass 2 (steps left `running`) finds nothing.
          then: (onOk: (r: unknown) => unknown, onErr?: (e: unknown) => unknown) =>
            Promise.resolve(pass++ === 0 ? [stuck] : []).then(onOk, onErr),
        });
        return { innerJoin: (_t: unknown, _c: unknown) => ({ where: whereFn }), where: whereFn };
      },
    }),
    update: (table: unknown) => ({
      set: (v: Record<string, unknown>) => ({
        where: async (cond: unknown) => {
          recorded.push({ table: tableNameOf(table), set: v, where: cond });
        },
      }),
    }),
  } as unknown as Database;
  return db;
}

describe('reconcileOrphanedSteps', () => {
  it('only orphans invocations that actually STARTED', async () => {
    // Under GLOBAL_PAUSE the cli-exec pickup gate holds every invocation at started_at NULL,
    // so without this filter each worker restart during a pause window ends queued runs as
    // "orphaned by a worker restart" — work the BullMQ job still owes, and three of them spend
    // MAX_ORPHAN_REDISPATCH on runs that never happened (task 977e1c5a, step 09_5).
    const recorded: RecordedUpdate[] = [];
    await reconcileOrphanedSteps(makeDb(recorded));

    const orphanUpdate = recorded.find((u) => u.table === 'cli_invocations');
    expect(orphanUpdate).toBeDefined();
    expect(String(orphanUpdate!.set.errorMessage)).toMatch(/orphaned by a worker restart/);
    expect(conditionColumns(orphanUpdate!.where)).toContain('started_at');
  });
});

/** Every bound value in a drizzle condition tree, flattened. */
function conditionValues(node: unknown, acc: unknown[] = []): unknown[] {
  if (!node || typeof node !== 'object') return acc;
  if (Array.isArray(node)) {
    for (const n of node) conditionValues(n, acc);
    return acc;
  }
  const obj = node as Record<string, unknown>;
  if ('value' in obj && 'encoder' in obj) {
    if (Array.isArray(obj.value)) acc.push(...obj.value);
    else acc.push(obj.value);
  }
  const chunks = obj.queryChunks;
  if (Array.isArray(chunks)) for (const c of chunks) conditionValues(c, acc);
  return acc;
}

interface CurrentStepScenario {
  /** Never-started, unended invocations of the stuck step. */
  unstarted: string[];
  /** What the epoch fence's UPDATE ... RETURNING yields: empty when the task stopped running. */
  fenced: { epoch: number }[];
}

/** One `waiting_cli` step that IS the task's current step, so reconcile re-drives it. */
function makeCurrentStepDb(recorded: RecordedUpdate[], scenario: CurrentStepScenario): Database {
  const stuck = {
    taskStepId: 'ts-1',
    taskId: 'task-1',
    stepId: '09_5-skill-generation',
    round: 0,
    userId: 'user-1',
    currentStepId: '09_5-skill-generation',
    currentRound: 0,
  };
  let joinedReads = 0;
  return {
    select: (_fields?: unknown) => ({
      from: (table: unknown) => {
        const rows = (): unknown[] =>
          tableNameOf(table) === 'cli_invocations'
            ? scenario.unstarted.map((id) => ({ id }))
            : joinedReads++ === 0
              ? [stuck]
              : [];
        const whereFn = (_cond: unknown) => ({
          limit: async (_n: number) => [],
          then: (onOk: (r: unknown) => unknown, onErr?: (e: unknown) => unknown) =>
            Promise.resolve(rows()).then(onOk, onErr),
        });
        return { innerJoin: (_t: unknown, _c: unknown) => ({ where: whereFn }), where: whereFn };
      },
    }),
    update: (table: unknown) => ({
      set: (v: Record<string, unknown>) => ({
        where: (cond: unknown) => {
          recorded.push({ table: tableNameOf(table), set: v, where: cond });
          const done = Promise.resolve(undefined);
          return {
            then: (onOk: (r: unknown) => unknown, onErr?: (e: unknown) => unknown) =>
              done.then(onOk, onErr),
            returning: async () => (tableNameOf(table) === 'tasks' ? scenario.fenced : []),
          };
        },
      }),
    }),
  } as unknown as Database;
}

describe('reconcileOrphanedSteps re-driving the current step', () => {
  const advances: { stepId: string; epoch: number }[] = [];
  const deps = (queued: Set<string> | null) => ({
    enqueueAdvance: async (
      _taskId: string,
      _userId: string,
      stepId: string,
      _round: number,
      epoch: number,
    ) => {
      advances.push({ stepId, epoch });
    },
    queuedInvocationIds: async () => queued,
  });

  it('re-drives at a freshly fenced epoch, so an advance queued before the restart is stale', async () => {
    advances.length = 0;
    const recorded: RecordedUpdate[] = [];
    await reconcileOrphanedSteps(
      makeCurrentStepDb(recorded, { unstarted: [], fenced: [{ epoch: 4 }] }),
      deps(new Set()),
    );
    const fence = recorded.find((u) => u.table === 'tasks');
    expect(fence?.set).toHaveProperty('orchestrationEpoch');
    // Guarded on the task still running, so a task cancelled meanwhile is not re-driven.
    expect(conditionColumns(fence!.where)).toContain('status');
    expect(advances).toEqual([{ stepId: '09_5-skill-generation', epoch: 4 }]);
  });

  it('does not re-drive a task that stopped running before the fence', async () => {
    advances.length = 0;
    await reconcileOrphanedSteps(
      makeCurrentStepDb([], { unstarted: [], fenced: [] }),
      deps(new Set()),
    );
    expect(advances).toEqual([]);
  });

  it('ends a never-started run that no job owes, and leaves a queued one alone', async () => {
    const recorded: RecordedUpdate[] = [];
    await reconcileOrphanedSteps(
      makeCurrentStepDb(recorded, {
        unstarted: ['inv-queued', 'inv-lost'],
        fenced: [{ epoch: 4 }],
      }),
      deps(new Set(['inv-queued'])),
    );
    const released = recorded.filter(
      (u) =>
        u.table === 'cli_invocations' &&
        String(u.set.errorMessage).includes('before it was queued'),
    );
    expect(released).toHaveLength(1);
    // Still an orphan to every classifier that recovers one.
    expect(String(released[0]!.set.errorMessage)).toMatch(/orphaned by a worker restart/);
    const ids = conditionValues(released[0]!.where);
    expect(ids).toContain('inv-lost');
    expect(ids).not.toContain('inv-queued');
    // Re-checked at the write, so a run that started meanwhile is never ended.
    expect(conditionColumns(released[0]!.where)).toContain('started_at');
  });

  it('ends no never-started run when the queue cannot be read', async () => {
    const recorded: RecordedUpdate[] = [];
    await reconcileOrphanedSteps(
      makeCurrentStepDb(recorded, { unstarted: ['inv-lost'], fenced: [{ epoch: 4 }] }),
      deps(null),
    );
    expect(
      recorded.some(
        (u) =>
          u.table === 'cli_invocations' &&
          String(u.set.errorMessage).includes('before it was queued'),
      ),
    ).toBe(false);
  });
});
