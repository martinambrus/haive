import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '@haive/database';
import { logger } from '@haive/shared';
import { bootRecoveryAction, reconcileOrphanedSteps } from '../src/queues/task-queue.js';
import { resetStepAndDownstream } from '../src/queues/_step-reset.js';

vi.mock('../src/queues/_step-reset.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/queues/_step-reset.js')>();
  return { ...actual, resetStepAndDownstream: vi.fn(async () => ({ newEpoch: 9 })) };
});

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

/** Every bound value in a drizzle condition tree, flattened. A primitive interpolated into a raw
 *  `sql` template sits in the chunks as itself, and is bound all the same. */
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
  if (Array.isArray(chunks)) {
    for (const c of chunks) {
      if (c === null || typeof c !== 'object') acc.push(c);
      else conditionValues(c, acc);
    }
  }
  return acc;
}

interface CurrentStepScenario {
  /** Never-started, unended invocations of the stuck step. */
  unstarted: string[];
  /** What the epoch fence's UPDATE ... RETURNING yields: empty when the task stopped running. */
  fenced: { epoch: number }[];
  /** The task as a read after a lost fence finds it. */
  taskNow?: { status: string; currentStepId: string | null; currentRound: number };
  /** The step row the abandoned-row requeue reads. */
  stepRow?: Record<string, unknown>;
}

/** One `waiting_cli` step that IS the task's current step, so reconcile re-drives it. */
function makeCurrentStepDb(recorded: RecordedUpdate[], scenario: CurrentStepScenario): Database {
  const stuck = {
    taskStepId: 'ts-1',
    taskId: 'task-1',
    stepId: '09_5-skill-generation',
    round: 2,
    userId: 'user-1',
    epoch: 3,
    currentStepId: '09_5-skill-generation',
    currentRound: 2,
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
        const limited = (): unknown[] => {
          const name = tableNameOf(table);
          if (name === 'tasks') return scenario.taskNow ? [scenario.taskNow] : [];
          if (name === 'task_steps') return scenario.stepRow ? [scenario.stepRow] : [];
          return [];
        };
        const whereFn = (_cond: unknown) => ({
          limit: async (_n: number) => limited(),
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

/** Pass 1 finds nothing; pass 2 finds a `running` row the task has moved past. */
function makeAbandonedRunningDb(recorded: RecordedUpdate[]): Database {
  const abandoned = {
    taskStepId: 'ts-2',
    taskId: 'task-1',
    stepId: '04-tooling-infrastructure',
    round: 0,
    userId: 'user-1',
    currentStepId: '05-later-step',
    currentRound: 0,
  };
  const stepRow = {
    id: 'ts-2',
    status: 'running',
    startedAt: new Date(Date.now() - 60_000),
    endedAt: null,
    idleMs: 0,
    userActiveMs: 0,
    waitingStartedAt: null,
    carriedWorkMs: 0,
    carriedIdleMs: 0,
    carriedUserActiveMs: 0,
  };
  let joinedReads = 0;
  return {
    select: (_fields?: unknown) => ({
      from: (table: unknown) => {
        const whereFn = (_cond: unknown) => ({
          limit: async (_n: number) => (tableNameOf(table) === 'task_steps' ? [stepRow] : []),
          then: (onOk: (r: unknown) => unknown, onErr?: (e: unknown) => unknown) =>
            Promise.resolve(joinedReads++ === 1 ? [abandoned] : []).then(onOk, onErr),
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
}

describe('reconcileOrphanedSteps requeueing a running row the task moved past', () => {
  it('requeues it, the requeue admitting a running row as well as a parked one', async () => {
    const recorded: RecordedUpdate[] = [];
    await reconcileOrphanedSteps(makeAbandonedRunningDb(recorded), {
      enqueueAdvance: async () => undefined,
      queuedInvocationIds: async () => new Set(),
    });
    const requeue = recorded.find((u) => u.table === 'task_steps' && u.set.status === 'pending');
    expect(requeue).toBeDefined();
    expect(conditionValues(requeue!.where)).toEqual(
      expect.arrayContaining(['waiting_cli', 'running']),
    );
  });
});

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
    // A compare-and-swap on what the pass read: a task cancelled meanwhile, or one a step retry
    // re-targeted (which moves the current step and bumps the epoch itself), is not re-driven.
    const columns = conditionColumns(fence!.where);
    for (const column of ['status', 'orchestration_epoch', 'current_step_id', 'current_round']) {
      expect(columns).toContain(column);
    }
    expect(conditionValues(fence!.where)).toEqual(
      expect.arrayContaining(['running', 3, '09_5-skill-generation', 2]),
    );
    expect(advances).toEqual([{ stepId: '09_5-skill-generation', epoch: 4 }]);
  });

  it('does not re-drive a task the fence no longer matches', async () => {
    advances.length = 0;
    const errors = vi.spyOn(logger, 'error');
    try {
      await reconcileOrphanedSteps(
        makeCurrentStepDb([], { unstarted: [], fenced: [] }),
        deps(new Set()),
      );
      expect(advances).toEqual([]);
      // Skipped as a result, not abandoned by a throw the pass then swallows.
      expect(errors).not.toHaveBeenCalled();
    } finally {
      errors.mockRestore();
    }
  });

  describe('after losing the fence to an api action taken during boot', () => {
    const stepRow = {
      id: 'ts-1',
      status: 'waiting_cli',
      startedAt: new Date(Date.now() - 60_000),
      endedAt: null,
      idleMs: 0,
      userActiveMs: 0,
      waitingStartedAt: null,
      carriedWorkMs: 0,
      carriedIdleMs: 0,
      carriedUserActiveMs: 0,
    };
    const lose = async (taskNow: CurrentStepScenario['taskNow']) => {
      advances.length = 0;
      const recorded: RecordedUpdate[] = [];
      await reconcileOrphanedSteps(
        makeCurrentStepDb(recorded, { unstarted: [], fenced: [], taskNow, stepRow }),
        deps(new Set()),
      );
      return recorded.filter((u) => u.table === 'task_steps' && u.set.status === 'pending');
    };

    it('requeues the row when the task moved to another step', async () => {
      const requeues = await lose({
        status: 'running',
        currentStepId: '08b-test-management',
        currentRound: 2,
      });
      expect(requeues).toHaveLength(1);
      // Only while still parked: a row the api reset since is its to run.
      expect(conditionValues(requeues[0]!.where)).toContain('waiting_cli');
      expect(advances).toEqual([]);
    });

    it('leaves the row to a retry of this same step', async () => {
      const requeues = await lose({
        status: 'running',
        currentStepId: '09_5-skill-generation',
        currentRound: 2,
      });
      expect(requeues).toEqual([]);
    });

    it('leaves the row alone once the task stopped running', async () => {
      const requeues = await lose({
        status: 'cancelled',
        currentStepId: '08b-test-management',
        currentRound: 2,
      });
      expect(requeues).toEqual([]);
    });
  });

  it('retries a re-drive that could not be queued, and keeps the fence once it is', async () => {
    advances.length = 0;
    const recorded: RecordedUpdate[] = [];
    let attempts = 0;
    await reconcileOrphanedSteps(
      makeCurrentStepDb(recorded, { unstarted: [], fenced: [{ epoch: 4 }] }),
      {
        enqueueAdvance: async (_t, _u, stepId, _r, epoch) => {
          attempts += 1;
          if (attempts < 3) throw new Error('redis blinked');
          advances.push({ stepId, epoch });
        },
        queuedInvocationIds: async () => new Set(),
        redriveRetryDelaysMs: [0, 0],
      },
    );
    expect(advances).toEqual([{ stepId: '09_5-skill-generation', epoch: 4 }]);
    expect(recorded.find((u) => u.table === 'tasks' && u.set.orchestrationEpoch === 3)).toBe(
      undefined,
    );
  });

  it('hands the epoch back when the re-drive cannot be queued at all', async () => {
    const recorded: RecordedUpdate[] = [];
    const errors = vi.spyOn(logger, 'error');
    let attempts = 0;
    try {
      await reconcileOrphanedSteps(
        makeCurrentStepDb(recorded, { unstarted: [], fenced: [{ epoch: 4 }] }),
        {
          enqueueAdvance: async () => {
            attempts += 1;
            throw new Error('redis refused the job');
          },
          queuedInvocationIds: async () => new Set(),
          redriveRetryDelaysMs: [0, 0],
        },
      );
      expect(attempts).toBe(3);
      const revert = recorded.find((u) => u.table === 'tasks' && u.set.orchestrationEpoch === 3);
      expect(revert).toBeDefined();
      expect(conditionColumns(revert!.where)).toContain('orchestration_epoch');
      expect(conditionValues(revert!.where)).toContain(4);
      expect(errors).toHaveBeenCalled();
    } finally {
      errors.mockRestore();
    }
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

describe('bootRecoveryAction', () => {
  it('requeues a row the task left, demotes one with agent work, and resets the rest', () => {
    expect(bootRecoveryAction({ current: false, cliWork: true })).toBe('requeue');
    expect(bootRecoveryAction({ current: false, cliWork: false })).toBe('requeue');
    expect(bootRecoveryAction({ current: true, cliWork: true })).toBe('demote');
    expect(bootRecoveryAction({ current: true, cliWork: false })).toBe('reset');
  });
});

interface RunningScenario {
  iterationCount: number;
  agentRows: boolean;
  ownRun: boolean;
  /** Whether the guarded demote still finds the row `running`. */
  demotes: boolean;
}

/** Pass 1 finds nothing; pass 2 finds the task's current step left `running`. */
function makeRunningCurrentDb(
  recorded: RecordedUpdate[],
  scenario: RunningScenario,
  cliWorkReads: unknown[],
): Database {
  const running = {
    taskStepId: 'ts-3',
    taskId: 'task-1',
    stepId: '09_5-skill-generation',
    round: 0,
    userId: 'user-1',
    epoch: 3,
    currentStepId: '09_5-skill-generation',
    currentRound: 0,
    iterationCount: scenario.iterationCount,
  };
  let joinedReads = 0;
  return {
    select: (_fields?: unknown) => ({
      from: (table: unknown) => {
        const name = tableNameOf(table);
        const whereFn = (cond: unknown) => ({
          // hasCliWork's two probes.
          limit: async (_n: number) => {
            cliWorkReads.push({ table: name, where: cond });
            if (name === 'task_step_agent_minings') return scenario.agentRows ? [{ id: 'm' }] : [];
            if (name === 'cli_invocations') return scenario.ownRun ? [{ id: 'inv' }] : [];
            return [];
          },
          then: (onOk: (r: unknown) => unknown, onErr?: (e: unknown) => unknown) =>
            Promise.resolve(
              name === 'cli_invocations' ? [] : joinedReads++ === 1 ? [running] : [],
            ).then(onOk, onErr),
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
            returning: async () => {
              const name = tableNameOf(table);
              if (name === 'tasks') return [{ epoch: 4 }];
              if (name === 'task_steps' && v.status === 'waiting_cli') {
                return scenario.demotes ? [{ id: 'ts-3' }] : [];
              }
              return [];
            },
          };
        },
      }),
    }),
  } as unknown as Database;
}

describe('reconcileOrphanedSteps recovering the current step left running', () => {
  const advances: { stepId: string; epoch: number }[] = [];
  const deps = {
    enqueueAdvance: async (
      _taskId: string,
      _userId: string,
      stepId: string,
      _round: number,
      epoch: number,
    ) => {
      advances.push({ stepId, epoch });
    },
    queuedInvocationIds: async () => new Set<string>(),
  };
  const none: RunningScenario = {
    iterationCount: 0,
    agentRows: false,
    ownRun: false,
    demotes: true,
  };

  beforeEach(() => {
    advances.length = 0;
    vi.mocked(resetStepAndDownstream).mockClear();
  });

  const recover = async (scenario: RunningScenario) => {
    const recorded: RecordedUpdate[] = [];
    const cliWorkReads: unknown[] = [];
    await reconcileOrphanedSteps(makeRunningCurrentDb(recorded, scenario, cliWorkReads), deps);
    const demote = recorded.find((u) => u.table === 'task_steps' && u.set.status === 'waiting_cli');
    return { recorded, cliWorkReads, demote };
  };

  it('demotes one with agent rows and re-drives it at a fenced epoch, keeping its work', async () => {
    const { recorded, demote } = await recover({ ...none, agentRows: true });

    expect(demote).toBeDefined();
    expect(conditionValues(demote!.where)).toEqual(expect.arrayContaining(['ts-3', 'running']));
    expect(recorded.find((u) => u.table === 'tasks')?.set).toHaveProperty('orchestrationEpoch');
    expect(advances).toEqual([{ stepId: '09_5-skill-generation', epoch: 4 }]);
    expect(vi.mocked(resetStepAndDownstream)).not.toHaveBeenCalled();
    expect(recorded.filter((u) => 'formValues' in u.set)).toEqual([]);
  });

  it('demotes one with a finished loop pass', async () => {
    const { demote } = await recover({ ...none, iterationCount: 2 });
    expect(demote).toBeDefined();
    expect(vi.mocked(resetStepAndDownstream)).not.toHaveBeenCalled();
  });

  it('demotes one with a run of its own that nothing superseded', async () => {
    const { demote, cliWorkReads } = await recover({ ...none, ownRun: true });
    expect(demote).toBeDefined();
    const runProbe = cliWorkReads.find(
      (r) => (r as { table: string }).table === 'cli_invocations',
    ) as { where: unknown } | undefined;
    expect(conditionColumns(runProbe?.where)).toEqual(
      expect.arrayContaining(['task_step_id', 'superseded_at']),
    );
  });

  it('resets one that ran nothing an agent did, as before', async () => {
    const { demote } = await recover(none);
    expect(demote).toBeUndefined();
    expect(vi.mocked(resetStepAndDownstream)).toHaveBeenCalledTimes(1);
    // At the epoch the pass read, so a Retry the api took during boot keeps the task.
    expect(vi.mocked(resetStepAndDownstream).mock.calls[0]![4]).toBe(3);
    expect(advances).toEqual([{ stepId: '09_5-skill-generation', epoch: 9 }]);
  });

  it('re-drives nothing once a Retry moved the task on before the reset', async () => {
    vi.mocked(resetStepAndDownstream).mockResolvedValueOnce('superseded');
    await recover(none);
    expect(advances).toEqual([]);
  });

  it('leaves a row to whatever moved it before the demote', async () => {
    const { recorded } = await recover({ ...none, agentRows: true, demotes: false });
    expect(recorded.find((u) => u.table === 'tasks')).toBeUndefined();
    expect(advances).toEqual([]);
    expect(vi.mocked(resetStepAndDownstream)).not.toHaveBeenCalled();
  });
});
