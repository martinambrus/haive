import { describe, expect, it } from 'vitest';
import type { Database } from '@haive/database';
import type { CliExecJobPayload } from '@haive/shared';
import { advanceStep } from '../src/step-engine/step-runner.js';
import { MiningRetryError } from '../src/step-engine/step-definition.js';
import type { StepApplyArgs, StepDefinition } from '../src/step-engine/step-definition.js';
import type { CliProviderRecord } from '../src/cli-adapters/types.js';

interface MiningRow {
  id: string;
  agentId: string;
  agentTitle: string;
  status: string;
  output: unknown;
  rawOutput: string | null;
  errorMessage: string | null;
  cliInvocationId: string | null;
  attempts: number;
}

interface MockState {
  taskStepRow: Record<string, unknown>;
  miningRows: MiningRow[];
  updates: Record<string, unknown>[];
  inserts: { table: string; row: Record<string, unknown> }[];
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
  const rowsFor = (table: string): unknown[] => {
    if (table === 'task_steps') return state.taskStepRow.id ? [state.taskStepRow] : [];
    if (table === 'task_step_agent_minings') return state.miningRows;
    return [];
  };
  const db = {
    select: (_projection?: unknown) => ({
      from: (table: unknown) => {
        const rows = rowsFor(tableNameOf(table));
        // .where() and .orderBy() are each awaited directly by some reads and chained
        // further by others, so both must be thenable AND chainable.
        const thenable = () => ({
          then: (res: (v: unknown[]) => unknown, rej: (e: unknown) => unknown) =>
            Promise.resolve(rows).then(res, rej),
          limit: async () => rows,
          orderBy: () => thenable(),
        });
        return { where: thenable };
      },
    }),
    insert: (table: unknown) => {
      const tableName = tableNameOf(table);
      const values = (v: Record<string, unknown>) => {
        const commit = () => {
          const id = `mock-${nextId++}`;
          const row = { id, createdAt: new Date(), ...v };
          state.inserts.push({ table: tableName, row });
          return [row];
        };
        return {
          returning: async () => commit(),
          onConflictDoNothing: () => ({ returning: async () => commit() }),
          onConflictDoUpdate: async () => {
            state.inserts.push({ table: tableName, row: v });
          },
        };
      };
      return { values };
    },
    update: (table: unknown) => {
      const tableName = tableNameOf(table);
      return {
        set: (v: Record<string, unknown>) => {
          const record = () => {
            state.updates.push({ table: tableName, ...v });
            if (tableName === 'task_steps') state.taskStepRow = { ...state.taskStepRow, ...v };
          };
          return {
            where: () => ({
              then: (res: (v: unknown[]) => unknown, rej: (e: unknown) => unknown) => {
                record();
                return Promise.resolve([]).then(res, rej);
              },
              returning: async () => {
                record();
                return tableName === 'task_steps' ? [state.taskStepRow] : [];
              },
            }),
          };
        },
      };
    },
    query: {
      userStepCliPreferences: { findFirst: async () => undefined },
      tasks: { findFirst: async () => undefined },
    },
  } as unknown as Database;
  return db;
}

function miningRow(agentId: string, attempts: number): MiningRow {
  return {
    id: `mining-${agentId}`,
    agentId,
    agentTitle: agentId,
    status: 'done',
    output: null,
    rawOutput: 'prose, no json',
    errorMessage: null,
    cliInvocationId: `inv-${agentId}`,
    attempts,
  };
}

function freshState(miningRows: MiningRow[]): MockState {
  return {
    taskStepRow: {
      id: 'ts-1',
      taskId: 'task-1',
      stepId: 'test-mining-step',
      stepIndex: 0,
      title: 'test',
      status: 'waiting_cli',
      formSchema: null,
      formValues: {},
      detectOutput: { foo: 'bar' },
      output: null,
      errorMessage: null,
      startedAt: new Date(),
      endedAt: null,
    },
    miningRows,
    updates: [],
    inserts: [],
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

/** A mining step whose apply() throws for `unreadable` agents until it is told the
 *  re-roll budget is spent — the exact contract 08c/08d implement. */
function miningStep(unreadable: string[], applyCalls: StepApplyArgs[]): StepDefinition {
  return {
    metadata: {
      id: 'test-mining-step',
      workflowType: 'workflow',
      index: 0,
      title: 'test',
      description: 'test',
      requiresCli: true,
    },
    async detect() {
      return { foo: 'bar' };
    },
    form() {
      return null;
    },
    agentMining: {
      requiredCapabilities: [],
      retry: { maxAttempts: 2 },
      async selectAgents() {
        return [
          { agentId: 'peer-reviewer', agentTitle: 'peer-reviewer', prompt: 'review' },
          { agentId: 'security-code-reviewer', agentTitle: 'security', prompt: 'audit' },
        ];
      },
    },
    async apply(_ctx, args) {
      applyCalls.push(args);
      if (unreadable.length > 0 && args.isFinalMiningAttempt === false) {
        throw new MiningRetryError(unreadable);
      }
      return { reviewIncomplete: unreadable.length > 0 };
    },
  } as unknown as StepDefinition;
}

function run(db: Database, stepDef: StepDefinition, enqueued: CliExecJobPayload[]) {
  return advanceStep({
    db,
    taskId: 'task-1',
    userId: 'user-1',
    repoPath: '/tmp',
    workspacePath: '/tmp',
    cliProviderId: 'prov-1',
    stepDef,
    providers: [makeProvider()],
    deps: {
      async enqueueCliInvocation(payload) {
        // maybeEnqueueStepSummary also enqueues (kind 'cli') on a done step; only the
        // mining re-rolls are under test here.
        if (payload.kind === 'agent_mining') enqueued.push(payload);
      },
    },
  });
}

describe('advanceStep agentMining retry', () => {
  it('re-rolls only the unreadable agent and parks, leaving the readable one alone', async () => {
    const state = freshState([
      miningRow('peer-reviewer', 1),
      miningRow('security-code-reviewer', 1),
    ]);
    const applyCalls: StepApplyArgs[] = [];
    const enqueued: CliExecJobPayload[] = [];
    const result = await run(
      makeMockDb(state),
      miningStep(['peer-reviewer'], applyCalls),
      enqueued,
    );

    expect(result.status).toBe('waiting_cli');
    expect(applyCalls).toHaveLength(1);
    expect(applyCalls[0]!.isFinalMiningAttempt).toBe(false);

    // exactly one re-enqueue, onto the peer row (mining id preserved by the unique index)
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]!.kind).toBe('agent_mining');
    expect(enqueued[0]!.agentMiningId).toBe('mining-peer-reviewer');

    // the peer row goes back to pending with attempts bumped; the security row is untouched
    const miningUpdates = state.updates.filter((u) => u.table === 'task_step_agent_minings');
    expect(miningUpdates).toHaveLength(1);
    expect(miningUpdates[0]!.status).toBe('pending');
    expect(miningUpdates[0]!.attempts).toBe(2);
    expect(miningUpdates[0]!.rawOutput).toBeNull();

    // the superseded invocation is the one whose output apply() could not read
    const supersedes = state.updates.filter(
      (u) => u.table === 'cli_invocations' && u.supersededAt instanceof Date,
    );
    expect(supersedes).toHaveLength(1);
  });

  it('degrades instead of failing when the named agent is spent but another has budget', async () => {
    // The mixed-budget case: peer already re-rolled (attempts 2 of 2), security is on its
    // first (attempts 1). miningAgentsWithBudget sees security's spare budget, so
    // isFinalMiningAttempt is false and apply() throws for peer -- but peer cannot be
    // re-rolled. The step must degrade, not die.
    const state = freshState([
      miningRow('peer-reviewer', 2),
      miningRow('security-code-reviewer', 1),
    ]);
    const applyCalls: StepApplyArgs[] = [];
    const enqueued: CliExecJobPayload[] = [];
    const result = await run(
      makeMockDb(state),
      miningStep(['peer-reviewer'], applyCalls),
      enqueued,
    );

    expect(result.status).toBe('done');
    expect(enqueued).toHaveLength(0);
    expect(applyCalls).toHaveLength(2);
    expect(applyCalls[0]!.isFinalMiningAttempt).toBe(false);
    expect(applyCalls[1]!.isFinalMiningAttempt).toBe(true);
    if (result.status === 'done') {
      expect(result.output).toEqual({ reviewIncomplete: true });
    }
    expect(state.updates.filter((u) => u.table === 'task_step_agent_minings')).toHaveLength(0);
  });

  it('reports the final attempt once every agent is spent, so apply degrades without throwing', async () => {
    const state = freshState([
      miningRow('peer-reviewer', 2),
      miningRow('security-code-reviewer', 2),
    ]);
    const applyCalls: StepApplyArgs[] = [];
    const enqueued: CliExecJobPayload[] = [];
    const result = await run(
      makeMockDb(state),
      miningStep(['peer-reviewer'], applyCalls),
      enqueued,
    );

    expect(result.status).toBe('done');
    expect(applyCalls).toHaveLength(1);
    expect(applyCalls[0]!.isFinalMiningAttempt).toBe(true);
    expect(enqueued).toHaveLength(0);
  });

  it('leaves apply on its first attempt while every agent still has budget', async () => {
    const state = freshState([
      miningRow('peer-reviewer', 1),
      miningRow('security-code-reviewer', 1),
    ]);
    const applyCalls: StepApplyArgs[] = [];
    const enqueued: CliExecJobPayload[] = [];
    // no unreadable agents -> apply never throws, so no re-roll and no degrade
    const result = await run(makeMockDb(state), miningStep([], applyCalls), enqueued);

    expect(result.status).toBe('done');
    expect(applyCalls).toHaveLength(1);
    expect(applyCalls[0]!.isFinalMiningAttempt).toBe(false);
    expect(enqueued).toHaveLength(0);
  });
});
