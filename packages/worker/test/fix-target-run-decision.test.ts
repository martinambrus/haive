import { describe, expect, it, vi } from 'vitest';
import type { Database } from '@haive/database';
import type { StepDefinition } from '../src/step-engine/step-definition.js';

vi.mock('../src/queues/cli-park-timing.js', () => ({
  foldCliParkOnResume: vi.fn(async () => {}),
  markCliParkBegin: vi.fn(async () => {}),
  foldAbandonedPark: vi.fn(async () => {}),
  foldOtherTaskParks: vi.fn(async () => {}),
  foldOrphanedCliParkOnBoot: vi.fn(async () => {}),
}));

const { advanceStep, willSkipBeforeAdmission } = await import('../src/step-engine/step-runner.js');
const { stepRunDecision } = await import('../src/step-engine/fix-consumer.js');

const TARGET = 'module.fix-demo.repair';
const ROUND = 2;
const pin = (stepId: string) => ({
  version: 1,
  guardedSpans: [],
  fixTarget: { stepId, capabilityVersion: 1 },
});

function tableNameOf(table: unknown): string {
  const obj = table as Record<string, unknown>;
  const sym = Object.getOwnPropertySymbols(obj).find((s) => s.description === 'drizzle:Name');
  return sym ? String(obj[sym as unknown as string]) : '';
}

function makeDb(contract: unknown, requestedRounds: number[]) {
  const state = { reads: 0, row: stepRow(), updates: [] as Record<string, unknown>[] };
  const db = {
    select: () => ({
      from: (table: unknown) => {
        const name = tableNameOf(table);
        if (name === 'task_events') state.reads++;
        const rows =
          name === 'task_steps'
            ? [state.row]
            : name === 'task_events'
              ? requestedRounds.map((round) => ({ round }))
              : [];
        return {
          where: () => {
            const chain = Promise.resolve(rows) as Promise<unknown[]> & Record<string, unknown>;
            chain.limit = async () => rows;
            chain.orderBy = () => ({ limit: async () => rows });
            return chain;
          },
        };
      },
    }),
    update: () => ({
      set: (v: Record<string, unknown>) => ({
        where: () => ({
          returning: async () => {
            state.updates.push(v);
            state.row = { ...state.row, ...v };
            return [state.row];
          },
        }),
      }),
    }),
    query: {
      tasks: {
        findFirst: async () => {
          state.reads++;
          return {
            id: 'task-1',
            status: 'running',
            autoContinue: true,
            preAnswers: {},
            repositoryId: null,
            type: 'workflow',
            executionContract: contract,
          };
        },
      },
      cliInvocations: { findFirst: async () => undefined },
    },
  } as unknown as Database;
  return { db, state };
}

function stepRow(): Record<string, unknown> {
  return {
    id: 'ts-1',
    taskId: 'task-1',
    stepId: TARGET,
    stepIndex: 0,
    round: ROUND,
    runSeq: 0,
    status: 'pending',
    output: null,
    formSchema: null,
    formValues: null,
    detectOutput: null,
    iterations: [],
    iterationCount: 0,
    idleMs: 0,
    userActiveMs: 0,
    carriedWorkMs: 0,
    carriedIdleMs: 0,
    carriedUserActiveMs: 0,
    pauseFormOnRetry: false,
    startedAt: null,
    endedAt: null,
    waitingStartedAt: null,
  };
}

function stepDef(
  capable: boolean,
  id = TARGET,
  shouldRun: () => Promise<boolean> = async () => false,
): StepDefinition {
  return {
    metadata: {
      id,
      workflowType: 'workflow',
      index: 0,
      title: 'repair',
      description: 'repair',
      requiresCli: false,
    },
    ...(capable ? { fixConsumer: { version: 1 }, editsCodeOrTests: true } : {}),
    shouldRun,
    async apply() {
      return { ok: true };
    },
  } as unknown as StepDefinition;
}

const params = (db: Database, def: StepDefinition) => ({
  db,
  taskId: 'task-1',
  userId: 'user-1',
  repoPath: '/tmp',
  workspacePath: '/tmp',
  cliProviderId: null,
  stepDef: def,
  providers: [],
  round: ROUND,
  runSeq: 0,
  deps: {
    async enqueueCliInvocation() {
      throw new Error('no CLI invocation expected');
    },
  },
});

const undefinedShouldRun = (async () => undefined) as unknown as () => Promise<boolean>;

const gates = async (
  contract: unknown,
  rounds: number[],
  capable = true,
  shouldRun?: () => Promise<boolean>,
) => {
  const skipAtAdmission = makeDb(contract, rounds);
  const admission = await willSkipBeforeAdmission(
    params(skipAtAdmission.db, stepDef(capable, TARGET, shouldRun)) as never,
    stepRow() as never,
  );
  const advance = makeDb(contract, rounds);
  const result = await advanceStep(
    params(advance.db, stepDef(capable, TARGET, shouldRun)) as never,
  );
  return { admission, advanced: result.status, reads: advance.state.reads };
};

describe('run decision of a pinned fix target', () => {
  it('is not skipped by its own shouldRun at a recorded fix round, before admission', async () => {
    const r = await gates(pin(TARGET), [ROUND]);
    expect(r.admission).toBe(false);
  });

  it('is not skipped by its own shouldRun at a recorded fix round, when it advances', async () => {
    const r = await gates(pin(TARGET), [ROUND]);
    expect(r.advanced).toBe('done');
  });

  it('is still skipped by its own shouldRun at a round with no recorded request', async () => {
    const r = await gates(pin(TARGET), [ROUND + 1]);
    expect(r.admission).toBe(true);
    expect(r.advanced).toBe('skipped');
  });

  it.each([
    ['no pin', null],
    ['a pin naming another step', pin('module.fix-demo.other')],
  ])('is still skipped with %s', async (_name, contract) => {
    const r = await gates(contract, [ROUND]);
    expect(r.admission).toBe(true);
    expect(r.advanced).toBe('skipped');
  });

  it('is skipped as before for a step without the capability', async () => {
    const r = await gates(pin(TARGET), [ROUND], false);
    expect(r.admission).toBe(true);
    expect(r.advanced).toBe('skipped');
  });

  it('reads nothing to decide a step without the capability', async () => {
    const probe = makeDb(pin(TARGET), [ROUND]);
    const ctx = { db: probe.db, taskId: 'task-1', round: ROUND } as never;
    expect(await stepRunDecision(ctx, stepDef(false))).toBe(false);
    expect(probe.state.reads).toBe(0);
  });

  it('reads nothing to decide a capable step whose shouldRun returns true', async () => {
    const probe = makeDb(pin(TARGET), [ROUND]);
    const ctx = { db: probe.db, taskId: 'task-1', round: ROUND } as never;
    expect(
      await stepRunDecision(
        ctx,
        stepDef(true, TARGET, async () => true),
      ),
    ).toBe(true);
    expect(probe.state.reads).toBe(0);
  });

  it.each([
    ['a step without the capability', false],
    ['the capable pinned target', true],
  ])(
    'skips %s whose shouldRun resolves undefined, with no recorded request',
    async (_n, capable) => {
      const r = await gates(pin(TARGET), [ROUND + 1], capable, undefinedShouldRun);
      expect(r.admission).toBe(true);
      expect(r.advanced).toBe('skipped');
    },
  );

  it('still runs the capable pinned target whose shouldRun resolves undefined, at a recorded round', async () => {
    const r = await gates(pin(TARGET), [ROUND], true, undefinedShouldRun);
    expect(r.admission).toBe(false);
    expect(r.advanced).toBe('done');
  });
});
