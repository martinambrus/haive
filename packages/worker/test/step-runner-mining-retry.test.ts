import { describe, expect, it } from 'vitest';
import type { Database } from '@haive/database';
import type { CliExecJobPayload } from '@haive/shared';
import { advanceStep } from '../src/step-engine/step-runner.js';
import { MiningRetryError, MiningWaveError } from '../src/step-engine/step-definition.js';
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
  /** Simulate the (task_step_id, agent_id) unique index rejecting a mining insert, so
   *  onConflictDoNothing().returning() yields no row and nothing is enqueued. */
  miningInsertConflicts?: boolean;
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
          onConflictDoNothing: () => ({
            returning: async () =>
              state.miningInsertConflicts && tableName === 'task_step_agent_minings'
                ? []
                : commit(),
          }),
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

function miningRow(
  agentId: string,
  attempts: number,
  overrides: Partial<MiningRow> = {},
): MiningRow {
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
    ...overrides,
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

/** A mining step that retries only a known transient terminal failure before
 *  apply() receives the completed batch. Mirrors discovery's opt-in policy. */
function terminalFailureRetryStep(applyCalls: StepApplyArgs[]): StepDefinition {
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
      retry: {
        maxAttempts: 3,
        retryOnInvocationFailure: (result) =>
          result.errorMessage?.includes('Connection closed mid-response') === true,
      },
      async selectAgents() {
        return [
          { agentId: 'peer-reviewer', agentTitle: 'peer-reviewer', prompt: 'review' },
          { agentId: 'security-code-reviewer', agentTitle: 'security', prompt: 'audit' },
        ];
      },
    },
    async apply(_ctx, args) {
      applyCalls.push(args);
      return { settled: true };
    },
  } as unknown as StepDefinition;
}

/** A mining step whose apply() asks for a SECOND wave (one refuter per finding) the
 *  first time it runs, and settles once those agents' results are present — the exact
 *  contract 08c's refutation pass implements. */
function waveStep(applyCalls: StepApplyArgs[], waveAgentIds: string[]): StepDefinition {
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
      async selectAgents() {
        return [{ agentId: 'peer-reviewer', agentTitle: 'peer-reviewer', prompt: 'review' }];
      },
    },
    async apply(_ctx, args) {
      applyCalls.push(args);
      const present = new Set((args.agentMiningResults ?? []).map((r) => r.agentId));
      const missing = waveAgentIds.filter((id) => !present.has(id));
      // Never ask twice: once the wave's rows exist (or the runner says none are
      // coming), settle. Otherwise the step would park on a barrier forever.
      if (missing.length > 0 && !args.miningWaveExhausted) {
        throw new MiningWaveError(
          missing.map((id) => ({ agentId: id, agentTitle: id, prompt: `refute ${id}` })),
        );
      }
      return { refuted: missing.length === 0, waveExhausted: args.miningWaveExhausted === true };
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
  it('re-runs only a transiently failed terminal before apply, preserving its siblings', async () => {
    const state = freshState([
      miningRow('peer-reviewer', 1, {
        status: 'failed',
        errorMessage: 'API Error: Connection closed mid-response. The response may be incomplete.',
      }),
      miningRow('security-code-reviewer', 1),
    ]);
    const applyCalls: StepApplyArgs[] = [];
    const enqueued: CliExecJobPayload[] = [];
    const result = await run(makeMockDb(state), terminalFailureRetryStep(applyCalls), enqueued);

    expect(result.status).toBe('waiting_cli');
    expect(applyCalls).toHaveLength(0);
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]!.agentMiningId).toBe('mining-peer-reviewer');

    const miningUpdates = state.updates.filter((u) => u.table === 'task_step_agent_minings');
    expect(miningUpdates).toHaveLength(1);
    expect(miningUpdates[0]!.status).toBe('pending');
    expect(miningUpdates[0]!.attempts).toBe(2);
  });

  it('stops re-running a transient terminal after its third total attempt', async () => {
    const state = freshState([
      miningRow('peer-reviewer', 3, {
        status: 'failed',
        errorMessage: 'API Error: Connection closed mid-response. The response may be incomplete.',
      }),
      miningRow('security-code-reviewer', 1),
    ]);
    const applyCalls: StepApplyArgs[] = [];
    const enqueued: CliExecJobPayload[] = [];
    const result = await run(makeMockDb(state), terminalFailureRetryStep(applyCalls), enqueued);

    expect(result.status).toBe('done');
    expect(applyCalls).toHaveLength(1);
    expect(enqueued).toHaveLength(0);
  });

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
    // the step declares no softTimeout, so the re-roll must not opt into one either
    expect(enqueued[0]!.softTimeout).toBe(false);

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

describe('advanceStep agentMining second wave', () => {
  it('dispatches the wave and parks, leaving the first wave’s row alone', async () => {
    const state = freshState([miningRow('peer-reviewer', 1)]);
    const applyCalls: StepApplyArgs[] = [];
    const enqueued: CliExecJobPayload[] = [];
    const result = await run(
      makeMockDb(state),
      waveStep(applyCalls, ['refute-abc', 'refute-def']),
      enqueued,
    );

    expect(result.status).toBe('waiting_cli');
    expect(applyCalls).toHaveLength(1);

    // one fresh row + one job per wave agent; the reviewer's row is never updated
    expect(enqueued.map((e) => e.agentMiningId)).toHaveLength(2);
    const miningInserts = state.inserts.filter((i) => i.table === 'task_step_agent_minings');
    expect(miningInserts.map((i) => i.row.agentId)).toEqual(['refute-abc', 'refute-def']);
    expect(miningInserts.every((i) => i.row.status === 'pending')).toBe(true);
    expect(state.updates.filter((u) => u.table === 'task_step_agent_minings')).toHaveLength(0);
  });

  it('settles without asking again once the wave’s results are present', async () => {
    const state = freshState([
      miningRow('peer-reviewer', 1),
      miningRow('refute-abc', 1),
      miningRow('refute-def', 1),
    ]);
    const applyCalls: StepApplyArgs[] = [];
    const enqueued: CliExecJobPayload[] = [];
    const result = await run(
      makeMockDb(state),
      waveStep(applyCalls, ['refute-abc', 'refute-def']),
      enqueued,
    );

    expect(result.status).toBe('done');
    expect(applyCalls).toHaveLength(1);
    expect(enqueued).toHaveLength(0);
    if (result.status === 'done') {
      expect(result.output).toEqual({ refuted: true, waveExhausted: false });
    }
  });

  it('continues without the wave rather than parking on a barrier nothing will clear', async () => {
    // Every insert loses the (task_step_id, agent_id) race, so no job is enqueued and no
    // row goes pending. Parking here would hang the step forever; apply must be re-run
    // and told the wave is not coming.
    const state = freshState([miningRow('peer-reviewer', 1)]);
    state.miningInsertConflicts = true;
    const applyCalls: StepApplyArgs[] = [];
    const enqueued: CliExecJobPayload[] = [];
    const result = await run(makeMockDb(state), waveStep(applyCalls, ['refute-abc']), enqueued);

    expect(result.status).toBe('done');
    expect(enqueued).toHaveLength(0);
    expect(applyCalls).toHaveLength(2);
    expect(applyCalls[0]!.miningWaveExhausted).toBeUndefined();
    expect(applyCalls[1]!.miningWaveExhausted).toBe(true);
    if (result.status === 'done') {
      expect(result.output).toEqual({ refuted: false, waveExhausted: true });
    }
  });
});
