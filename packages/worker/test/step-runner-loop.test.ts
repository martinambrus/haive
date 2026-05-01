import { describe, expect, it } from 'vitest';
import type { Database } from '@haive/database';
import type { CliExecJobPayload } from '@haive/shared';
import { advanceStep } from '../src/step-engine/step-runner.js';
import type {
  StepDefinition,
  StepLoopShouldContinueArgs,
} from '../src/step-engine/step-definition.js';
import type { CliProviderRecord } from '../src/cli-adapters/types.js';

interface CliInvocationMockRow {
  id: string;
  taskId: string;
  taskStepId: string;
  cliProviderId: string | null;
  mode: string;
  prompt: string;
  rawOutput: string | null;
  parsedOutput: unknown;
  exitCode: number | null;
  errorMessage: string | null;
  createdAt: Date;
  endedAt: Date | null;
  supersededAt: Date | null;
  consumedAt: Date | null;
}

interface MockState {
  taskStepRow: Record<string, unknown>;
  cliInvocationRows: CliInvocationMockRow[];
  taskRow: { id: string; stepLoopLimits: Record<string, number> | null } | null;
  inserts: { table: string; row: Record<string, unknown> }[];
  updates: { table: string; patch: Record<string, unknown> }[];
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

function makeMockDb(state: MockState): Database {
  let nextId = 1;
  const db = {
    select: (cols?: Record<string, unknown>) => ({
      from: (table: unknown) => {
        const tableName = tableNameOf(table);
        return {
          where: (_cond: unknown) => ({
            limit: async (_n: number) => {
              if (tableName === 'task_steps') {
                return state.taskStepRow.id ? [state.taskStepRow] : [];
              }
              return [];
            },
            orderBy: (_o: unknown) => ({
              limit: async (_n: number) => {
                if (tableName === 'cli_invocations') {
                  // Mirror runner's filter: latest non-superseded,
                  // non-consumed, non-agent_mining row by createdAt desc.
                  const filtered = state.cliInvocationRows
                    .filter(
                      (r) =>
                        r.supersededAt === null &&
                        r.consumedAt === null &&
                        r.mode !== 'agent_mining',
                    )
                    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
                  if (cols && filtered[0]) {
                    return [{ id: filtered[0].id }];
                  }
                  return filtered.slice(0, 1);
                }
                return [];
              },
            }),
          }),
        };
      },
    }),
    insert: (table: unknown) => {
      const tableName = tableNameOf(table);
      return {
        values: (v: Record<string, unknown>) => ({
          returning: async () => {
            const id = `mock-${nextId++}`;
            const row = { id, createdAt: new Date(), ...v };
            state.inserts.push({ table: tableName, row });
            if (tableName === 'task_steps') {
              state.taskStepRow = { ...state.taskStepRow, ...row };
              return [row];
            }
            if (tableName === 'cli_invocations') {
              const inv: CliInvocationMockRow = {
                id,
                taskId: String(v.taskId ?? ''),
                taskStepId: String(v.taskStepId ?? ''),
                cliProviderId: (v.cliProviderId as string | null) ?? null,
                mode: String(v.mode ?? 'cli'),
                prompt: String(v.prompt ?? ''),
                rawOutput: null,
                parsedOutput: null,
                exitCode: null,
                errorMessage: null,
                createdAt: new Date(),
                endedAt: null,
                supersededAt: null,
                consumedAt: null,
              };
              state.cliInvocationRows.push(inv);
              return [row];
            }
            return [row];
          },
          onConflictDoUpdate: async (_opts: unknown) => {
            state.inserts.push({ table: tableName, row: v });
          },
        }),
      };
    },
    update: (table: unknown) => {
      const tableName = tableNameOf(table);
      return {
        set: (v: Record<string, unknown>) => ({
          where: (_: unknown) => {
            if (tableName === 'cli_invocations') {
              // markLatestInvocationConsumed update path. No .returning().
              // The runner only awaits the chain so we resolve a Promise here.
              state.updates.push({ table: tableName, patch: v });
              if (v.consumedAt) {
                const target = state.cliInvocationRows
                  .filter((r) => r.consumedAt === null && r.supersededAt === null)
                  .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
                if (target) target.consumedAt = v.consumedAt as Date;
              }
              return Promise.resolve(undefined);
            }
            return {
              returning: async () => {
                state.updates.push({ table: tableName, patch: v });
                if (tableName === 'task_steps') {
                  state.taskStepRow = { ...state.taskStepRow, ...v };
                  return [state.taskStepRow];
                }
                return [];
              },
            };
          },
        }),
      };
    },
    query: {
      userStepCliPreferences: { findFirst: async () => undefined },
      tasks: {
        findFirst: async () => state.taskRow ?? undefined,
      },
    },
  } as unknown as Database;
  return db;
}

function freshState(): MockState {
  return {
    taskStepRow: {
      id: 'ts-1',
      taskId: 'task-1',
      stepId: 'loop-step',
      stepIndex: 0,
      title: 'loop step',
      status: 'pending',
      formSchema: null,
      formValues: null,
      detectOutput: null,
      output: null,
      iterations: null,
      iterationCount: 0,
      errorMessage: null,
      startedAt: null,
      endedAt: null,
    },
    cliInvocationRows: [],
    taskRow: null,
    inserts: [],
    updates: [],
  };
}

function makeProvider(): CliProviderRecord {
  return {
    id: 'prov-1',
    userId: 'user-1',
    name: 'claude-code',
    label: 'Claude Code',
    executablePath: '/usr/bin/claude',
    wrapperPath: null,
    envVars: null,
    cliArgs: null,
    supportsSubagents: true,
    authMode: 'subscription',
    enabled: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as CliProviderRecord;
}

interface LoopStepOpts {
  maxIterations: number;
  shouldContinue: (args: StepLoopShouldContinueArgs) => boolean | Promise<boolean>;
  applyReturns?: (iter: number) => unknown;
  buildIterationPrompt?: boolean;
}

function loopStep(opts: LoopStepOpts): StepDefinition {
  return {
    metadata: {
      id: 'loop-step',
      workflowType: 'workflow',
      index: 0,
      title: 'loop step',
      description: 'loop step',
      requiresCli: true,
    },
    async detect() {
      return { ready: true };
    },
    form() {
      return null;
    },
    llm: {
      requiredCapabilities: [],
      buildPrompt: (a) => `base prompt ${JSON.stringify(a.detected)}`,
    },
    loop: {
      maxIterations: opts.maxIterations,
      shouldContinue: opts.shouldContinue,
      ...(opts.buildIterationPrompt
        ? {
            buildIterationPrompt: (a) => `iter=${a.iteration} prev=${a.previousIterations.length}`,
          }
        : {}),
    },
    async apply(_ctx, args) {
      return opts.applyReturns
        ? opts.applyReturns(args.iteration)
        : { iter: args.iteration, llm: args.llmOutput };
    },
  };
}

/** Simulate the worker completing a CLI invocation: set parsedOutput +
 *  endedAt + exitCode=0 on the latest open invocation. */
function completeLatestInvocation(state: MockState, parsedOutput: unknown): void {
  const open = state.cliInvocationRows
    .filter((r) => r.endedAt === null && r.consumedAt === null)
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
  if (!open) throw new Error('no open invocation to complete');
  open.endedAt = new Date();
  open.exitCode = 0;
  open.parsedOutput = parsedOutput;
  open.rawOutput = JSON.stringify(parsedOutput);
}

describe('advanceStep loop hook', () => {
  it('finishes after one pass when shouldContinue returns false', async () => {
    const state = freshState();
    state.taskStepRow = {
      ...state.taskStepRow,
      status: 'waiting_cli',
      detectOutput: { ready: true },
      formValues: {},
    };
    state.cliInvocationRows = [
      {
        id: 'inv-0',
        taskId: 'task-1',
        taskStepId: 'ts-1',
        cliProviderId: 'prov-1',
        mode: 'cli',
        prompt: 'p',
        rawOutput: 'r',
        parsedOutput: { score: 10 },
        exitCode: 0,
        errorMessage: null,
        createdAt: new Date(),
        endedAt: new Date(),
        supersededAt: null,
        consumedAt: null,
      },
    ];
    const db = makeMockDb(state);
    const result = await advanceStep({
      db,
      taskId: 'task-1',
      userId: 'user-1',
      repoPath: '/tmp',
      workspacePath: '/tmp',
      cliProviderId: 'prov-1',
      stepDef: loopStep({ maxIterations: 5, shouldContinue: () => false }),
      providers: [makeProvider()],
      deps: {
        async enqueueCliInvocation() {
          throw new Error('should not enqueue when shouldContinue=false');
        },
      },
    });
    expect(result.status).toBe('done');
    // Iteration 0 recorded; consumed; only 1 entry in iterations.
    const iterations = state.taskStepRow.iterations as Array<{
      iteration: number;
      continueRequested: boolean;
      exhaustedBudget?: boolean;
    }> | null;
    expect(iterations).toHaveLength(1);
    expect(iterations![0]!.iteration).toBe(0);
    expect(iterations![0]!.continueRequested).toBe(false);
    expect(iterations![0]!.exhaustedBudget).toBeUndefined();
    expect(state.cliInvocationRows[0]!.consumedAt).not.toBeNull();
  });

  it('enqueues a fresh invocation and re-enters waiting_cli when shouldContinue=true with budget left', async () => {
    const state = freshState();
    state.taskStepRow = {
      ...state.taskStepRow,
      status: 'waiting_cli',
      detectOutput: { ready: true },
      formValues: {},
    };
    state.cliInvocationRows = [
      {
        id: 'inv-0',
        taskId: 'task-1',
        taskStepId: 'ts-1',
        cliProviderId: 'prov-1',
        mode: 'cli',
        prompt: 'p',
        rawOutput: 'r',
        parsedOutput: { findings: ['err'] },
        exitCode: 0,
        errorMessage: null,
        createdAt: new Date(Date.now() - 1000),
        endedAt: new Date(),
        supersededAt: null,
        consumedAt: null,
      },
    ];
    const db = makeMockDb(state);
    const enqueued: CliExecJobPayload[] = [];
    const result = await advanceStep({
      db,
      taskId: 'task-1',
      userId: 'user-1',
      repoPath: '/tmp',
      workspacePath: '/tmp',
      cliProviderId: 'prov-1',
      stepDef: loopStep({
        maxIterations: 3,
        shouldContinue: (a) => a.iteration === 0,
        buildIterationPrompt: true,
      }),
      providers: [makeProvider()],
      deps: {
        async enqueueCliInvocation(p) {
          enqueued.push(p);
        },
      },
    });
    expect(result.status).toBe('waiting_cli');
    expect(enqueued).toHaveLength(1);
    // Original invocation now consumed, new one inserted, total = 2 rows.
    expect(state.cliInvocationRows).toHaveLength(2);
    expect(state.cliInvocationRows[0]!.consumedAt).not.toBeNull();
    expect(state.cliInvocationRows[1]!.consumedAt).toBeNull();
    // Iteration 0 already recorded with continueRequested=true, no exhausted flag.
    const iterations = state.taskStepRow.iterations as Array<{
      iteration: number;
      continueRequested: boolean;
      exhaustedBudget?: boolean;
    }>;
    expect(iterations).toHaveLength(1);
    expect(iterations[0]!.continueRequested).toBe(true);
    expect(iterations[0]!.exhaustedBudget).toBeUndefined();
    // The new invocation's prompt comes from buildIterationPrompt.
    const inserted = state.inserts.find((i) => i.table === 'cli_invocations');
    expect(inserted!.row.prompt).toMatch(/^iter=1 prev=1/);
  });

  it('marks last entry exhaustedBudget=true and finishes when budget caps the loop', async () => {
    // maxIterations=1 + shouldContinue=true means iteration 0 wants to
    // continue but the next iteration (1) >= budget (1), so the runner
    // must set exhaustedBudget and finish without enqueuing.
    const state = freshState();
    state.taskStepRow = {
      ...state.taskStepRow,
      status: 'waiting_cli',
      detectOutput: { ready: true },
      formValues: {},
    };
    state.cliInvocationRows = [
      {
        id: 'inv-0',
        taskId: 'task-1',
        taskStepId: 'ts-1',
        cliProviderId: 'prov-1',
        mode: 'cli',
        prompt: 'p',
        rawOutput: 'r',
        parsedOutput: { findings: ['still bad'] },
        exitCode: 0,
        errorMessage: null,
        createdAt: new Date(),
        endedAt: new Date(),
        supersededAt: null,
        consumedAt: null,
      },
    ];
    const db = makeMockDb(state);
    const result = await advanceStep({
      db,
      taskId: 'task-1',
      userId: 'user-1',
      repoPath: '/tmp',
      workspacePath: '/tmp',
      cliProviderId: 'prov-1',
      stepDef: loopStep({ maxIterations: 1, shouldContinue: () => true }),
      providers: [makeProvider()],
      deps: {
        async enqueueCliInvocation() {
          throw new Error('should not enqueue when budget exhausted');
        },
      },
    });
    expect(result.status).toBe('done');
    const iterations = state.taskStepRow.iterations as Array<{
      iteration: number;
      continueRequested: boolean;
      exhaustedBudget?: boolean;
    }>;
    expect(iterations).toHaveLength(1);
    expect(iterations[0]!.continueRequested).toBe(true);
    expect(iterations[0]!.exhaustedBudget).toBe(true);
    expect(state.cliInvocationRows).toHaveLength(1); // no new row enqueued
  });

  it('honors task.stepLoopLimits override over the loopSpec default', async () => {
    // Spec default is 5 but task says 1 → exhaust on first pass.
    const state = freshState();
    state.taskRow = { id: 'task-1', stepLoopLimits: { 'loop-step': 1 } };
    state.taskStepRow = {
      ...state.taskStepRow,
      status: 'waiting_cli',
      detectOutput: { ready: true },
      formValues: {},
    };
    state.cliInvocationRows = [
      {
        id: 'inv-0',
        taskId: 'task-1',
        taskStepId: 'ts-1',
        cliProviderId: 'prov-1',
        mode: 'cli',
        prompt: 'p',
        rawOutput: 'r',
        parsedOutput: { findings: ['bad'] },
        exitCode: 0,
        errorMessage: null,
        createdAt: new Date(),
        endedAt: new Date(),
        supersededAt: null,
        consumedAt: null,
      },
    ];
    const db = makeMockDb(state);
    const result = await advanceStep({
      db,
      taskId: 'task-1',
      userId: 'user-1',
      repoPath: '/tmp',
      workspacePath: '/tmp',
      cliProviderId: 'prov-1',
      stepDef: loopStep({ maxIterations: 5, shouldContinue: () => true }),
      providers: [makeProvider()],
      deps: {
        async enqueueCliInvocation() {
          throw new Error('should not enqueue when task.stepLoopLimits caps to 1');
        },
      },
    });
    expect(result.status).toBe('done');
    const iterations = state.taskStepRow.iterations as Array<{
      exhaustedBudget?: boolean;
    }>;
    expect(iterations[0]!.exhaustedBudget).toBe(true);
  });

  it('honors formValues.maxIterations over both task limits and spec default', async () => {
    // Spec default 5, task limit 4, formValues 1 → form override wins.
    const state = freshState();
    state.taskRow = { id: 'task-1', stepLoopLimits: { 'loop-step': 4 } };
    state.taskStepRow = {
      ...state.taskStepRow,
      status: 'waiting_cli',
      detectOutput: { ready: true },
      formValues: { maxIterations: 1 },
    };
    state.cliInvocationRows = [
      {
        id: 'inv-0',
        taskId: 'task-1',
        taskStepId: 'ts-1',
        cliProviderId: 'prov-1',
        mode: 'cli',
        prompt: 'p',
        rawOutput: 'r',
        parsedOutput: { findings: ['bad'] },
        exitCode: 0,
        errorMessage: null,
        createdAt: new Date(),
        endedAt: new Date(),
        supersededAt: null,
        consumedAt: null,
      },
    ];
    const db = makeMockDb(state);
    const result = await advanceStep({
      db,
      taskId: 'task-1',
      userId: 'user-1',
      repoPath: '/tmp',
      workspacePath: '/tmp',
      cliProviderId: 'prov-1',
      stepDef: loopStep({ maxIterations: 5, shouldContinue: () => true }),
      providers: [makeProvider()],
      deps: {
        async enqueueCliInvocation() {
          throw new Error('should not enqueue when formValues.maxIterations=1');
        },
      },
    });
    expect(result.status).toBe('done');
    const iterations = state.taskStepRow.iterations as Array<{
      exhaustedBudget?: boolean;
    }>;
    expect(iterations[0]!.exhaustedBudget).toBe(true);
  });

  it('parses formValues.maxIterations supplied as a string (HTML <select> emits strings)', async () => {
    const state = freshState();
    state.taskStepRow = {
      ...state.taskStepRow,
      status: 'waiting_cli',
      detectOutput: { ready: true },
      formValues: { maxIterations: '1' },
    };
    state.cliInvocationRows = [
      {
        id: 'inv-0',
        taskId: 'task-1',
        taskStepId: 'ts-1',
        cliProviderId: 'prov-1',
        mode: 'cli',
        prompt: 'p',
        rawOutput: 'r',
        parsedOutput: {},
        exitCode: 0,
        errorMessage: null,
        createdAt: new Date(),
        endedAt: new Date(),
        supersededAt: null,
        consumedAt: null,
      },
    ];
    const db = makeMockDb(state);
    const result = await advanceStep({
      db,
      taskId: 'task-1',
      userId: 'user-1',
      repoPath: '/tmp',
      workspacePath: '/tmp',
      cliProviderId: 'prov-1',
      stepDef: loopStep({ maxIterations: 10, shouldContinue: () => true }),
      providers: [makeProvider()],
      deps: {
        async enqueueCliInvocation() {
          throw new Error('should not enqueue: form override "1" should cap');
        },
      },
    });
    expect(result.status).toBe('done');
    const iterations = state.taskStepRow.iterations as Array<{ exhaustedBudget?: boolean }>;
    expect(iterations[0]!.exhaustedBudget).toBe(true);
  });

  it('completes a 2-iteration loop end-to-end (resume after each CLI completion)', async () => {
    // Pass 1: shouldContinue=true → enqueue iter 1.
    // Pass 2: shouldContinue=false → done.
    const state = freshState();
    state.taskStepRow = {
      ...state.taskStepRow,
      status: 'waiting_cli',
      detectOutput: { ready: true },
      formValues: {},
    };
    state.cliInvocationRows = [
      {
        id: 'inv-0',
        taskId: 'task-1',
        taskStepId: 'ts-1',
        cliProviderId: 'prov-1',
        mode: 'cli',
        prompt: 'p',
        rawOutput: 'r',
        parsedOutput: { v: 0 },
        exitCode: 0,
        errorMessage: null,
        createdAt: new Date(Date.now() - 5000),
        endedAt: new Date(),
        supersededAt: null,
        consumedAt: null,
      },
    ];
    const db = makeMockDb(state);
    const enqueued: CliExecJobPayload[] = [];
    const stepDef = loopStep({
      maxIterations: 3,
      shouldContinue: (a) => a.iteration === 0,
    });
    const params = {
      db,
      taskId: 'task-1',
      userId: 'user-1',
      repoPath: '/tmp',
      workspacePath: '/tmp',
      cliProviderId: 'prov-1',
      stepDef,
      providers: [makeProvider()],
      deps: {
        async enqueueCliInvocation(p: CliExecJobPayload) {
          enqueued.push(p);
        },
      },
    };
    const r1 = await advanceStep(params);
    expect(r1.status).toBe('waiting_cli');
    expect(state.cliInvocationRows).toHaveLength(2);

    // Worker completes iter 1's invocation off-band.
    completeLatestInvocation(state, { v: 1 });

    const r2 = await advanceStep(params);
    expect(r2.status).toBe('done');
    const iterations = state.taskStepRow.iterations as Array<{
      iteration: number;
      continueRequested: boolean;
    }>;
    expect(iterations).toHaveLength(2);
    expect(iterations.map((i) => i.iteration)).toEqual([0, 1]);
    expect(iterations[0]!.continueRequested).toBe(true);
    expect(iterations[1]!.continueRequested).toBe(false);
    // Both invocations now consumed — first by pass 1 prep, second by pass 2.
    expect(state.cliInvocationRows.every((r) => r.consumedAt !== null)).toBe(true);
  });
});
