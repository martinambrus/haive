import { describe, expect, it } from 'vitest';
import type { Database } from '@haive/database';
import type { CliExecJobPayload } from '@haive/shared';
import { advanceStep } from '../src/step-engine/step-runner.js';
import type { StepDefinition } from '../src/step-engine/step-definition.js';
import type { CliProviderRecord } from '../src/cli-adapters/types.js';

interface MockState {
  taskStepRow: Record<string, unknown>;
  cliInvocationRow: Record<string, unknown> | null;
  updates: Record<string, unknown>[];
  inserts: { table: string; row: Record<string, unknown> }[];
}

function makeMockDb(state: MockState): Database {
  let nextId = 1;
  const db = {
    select: () => ({
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
                  return state.cliInvocationRow ? [state.cliInvocationRow] : [];
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
            } else if (tableName === 'cli_invocations') {
              state.cliInvocationRow = { ...row, endedAt: null };
            }
            return [row];
          },
          // recordStepCliPreference uses .values().onConflictDoUpdate()
          // (no .returning()). The chain still needs to be awaitable to
          // not throw when the runner records the actually-used provider.
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
          where: (_: unknown) => ({
            returning: async () => {
              state.updates.push({ table: tableName, ...v });
              if (tableName === 'task_steps') {
                state.taskStepRow = { ...state.taskStepRow, ...v };
                return [state.taskStepRow];
              }
              return [];
            },
          }),
        }),
      };
    },
    // db.query.<table>.findFirst is the relation-aware Drizzle API used
    // by helpers like resolvePreferredCli (looks up per-step CLI prefs)
    // and resolveLoopBudget (reads tasks.step_loop_limits). The mock
    // returns no preference / no task overrides so the runner falls back
    // to params.cliProviderId and the loopSpec defaults — matching
    // production behavior for users who haven't set anything.
    query: {
      userStepCliPreferences: { findFirst: async () => undefined },
      tasks: { findFirst: async () => undefined },
    },
    // db.insert(table).values(...).onConflictDoUpdate({...}) is used by
    // recordStepCliPreference to upsert the per-(user, step) preference
    // after a successful dispatch. The mock chain mirrors the existing
    // values().returning() shape and is a no-op for tests.
  } as unknown as Database;
  return db;
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

function baseStep(): StepDefinition {
  return {
    metadata: {
      id: 'test-llm-step',
      workflowType: 'onboarding',
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
    llm: {
      requiredCapabilities: ['tool_use'],
      buildPrompt: (args) => `prompt with detected=${JSON.stringify(args.detected)}`,
    },
    async apply(_ctx, args) {
      return { llmOutput: args.llmOutput };
    },
  };
}

function freshState(): MockState {
  return {
    taskStepRow: {
      id: 'ts-1',
      taskId: 'task-1',
      stepId: 'test-llm-step',
      stepIndex: 0,
      title: 'test',
      status: 'pending',
      formSchema: null,
      formValues: null,
      detectOutput: null,
      output: null,
      errorMessage: null,
      startedAt: null,
      endedAt: null,
    },
    cliInvocationRow: null,
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

describe('advanceStep LLM phase', () => {
  it('fails when a step has llm but no providers and deps are supplied', async () => {
    const state = freshState();
    const db = makeMockDb(state);
    const result = await advanceStep({
      db,
      taskId: 'task-1',
      userId: 'user-1',
      repoPath: '/tmp',
      workspacePath: '/tmp',
      cliProviderId: null,
      stepDef: baseStep(),
    });
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error).toMatch(/no providers/);
    }
  });

  it('inserts a cli invocation row and enqueues a cli-exec job', async () => {
    const state = freshState();
    const db = makeMockDb(state);
    const enqueued: CliExecJobPayload[] = [];
    const result = await advanceStep({
      db,
      taskId: 'task-1',
      userId: 'user-1',
      repoPath: '/tmp',
      workspacePath: '/tmp',
      cliProviderId: 'prov-1',
      stepDef: baseStep(),
      providers: [makeProvider()],
      deps: {
        async enqueueCliInvocation(payload) {
          enqueued.push(payload);
        },
      },
    });
    expect(result.status).toBe('waiting_cli');
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]!.cliProviderId).toBe('prov-1');
    expect(enqueued[0]!.kind).toBe('cli');
    const invInsert = state.inserts.find((i) => i.table === 'cli_invocations');
    expect(invInsert).toBeDefined();
    expect(invInsert!.row.prompt).toContain('prompt with detected=');
  });

  it('routes api_key zai providers through the claude CLI binary', async () => {
    const state = freshState();
    const db = makeMockDb(state);
    const enqueued: CliExecJobPayload[] = [];
    const zaiProvider: CliProviderRecord = {
      ...makeProvider(),
      id: 'prov-zai',
      name: 'zai',
      authMode: 'api_key',
    } as CliProviderRecord;
    const stepDef = baseStep();
    stepDef.llm = {
      requiredCapabilities: [],
      buildPrompt: (args) => `synth ${JSON.stringify(args.detected)}`,
    };
    const result = await advanceStep({
      db,
      taskId: 'task-1',
      userId: 'user-1',
      repoPath: '/tmp',
      workspacePath: '/tmp',
      cliProviderId: 'prov-zai',
      stepDef,
      providers: [zaiProvider],
      deps: {
        async enqueueCliInvocation(payload) {
          enqueued.push(payload);
        },
      },
    });
    expect(result.status).toBe('waiting_cli');
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]!.kind).toBe('cli');
    const cliSpec = enqueued[0]!.spec as { command: string };
    expect(cliSpec.command).toBe('/usr/bin/claude');
  });

  it('runs apply with llmOutput when the latest invocation completed successfully', async () => {
    const state = freshState();
    state.taskStepRow = {
      ...state.taskStepRow,
      status: 'waiting_cli',
      detectOutput: { foo: 'bar' },
      formSchema: null,
      formValues: {},
    };
    state.cliInvocationRow = {
      id: 'inv-1',
      exitCode: 0,
      rawOutput: 'raw',
      parsedOutput: { result: 42 },
      endedAt: new Date(),
      errorMessage: null,
      createdAt: new Date(),
    };
    const db = makeMockDb(state);
    const result = await advanceStep({
      db,
      taskId: 'task-1',
      userId: 'user-1',
      repoPath: '/tmp',
      workspacePath: '/tmp',
      cliProviderId: 'prov-1',
      stepDef: baseStep(),
      providers: [makeProvider()],
      deps: {
        async enqueueCliInvocation() {
          throw new Error('should not enqueue on resume');
        },
      },
    });
    expect(result.status).toBe('done');
    if (result.status === 'done') {
      expect(result.output).toEqual({ llmOutput: { result: 42 } });
    }
  });

  it('fails the step when the latest invocation exited non-zero', async () => {
    const state = freshState();
    state.taskStepRow = { ...state.taskStepRow, status: 'waiting_cli' };
    state.cliInvocationRow = {
      id: 'inv-1',
      exitCode: 1,
      rawOutput: '',
      parsedOutput: null,
      endedAt: new Date(),
      errorMessage: 'boom',
      createdAt: new Date(),
    };
    const db = makeMockDb(state);
    const result = await advanceStep({
      db,
      taskId: 'task-1',
      userId: 'user-1',
      repoPath: '/tmp',
      workspacePath: '/tmp',
      cliProviderId: 'prov-1',
      stepDef: baseStep(),
      providers: [makeProvider()],
      deps: {
        async enqueueCliInvocation() {
          throw new Error('should not enqueue on failure resume');
        },
      },
    });
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error).toContain('boom');
    }
  });

  it('fails the step when exitCode is 0 but errorMessage is set (stream-json no-result case)', async () => {
    const state = freshState();
    state.taskStepRow = { ...state.taskStepRow, status: 'waiting_cli' };
    state.cliInvocationRow = {
      id: 'inv-1',
      exitCode: 0,
      rawOutput: '{"type":"system","subtype":"init"}',
      parsedOutput: null,
      endedAt: new Date(),
      errorMessage: 'LLM emitted no result event',
      createdAt: new Date(),
    };
    const db = makeMockDb(state);
    const result = await advanceStep({
      db,
      taskId: 'task-1',
      userId: 'user-1',
      repoPath: '/tmp',
      workspacePath: '/tmp',
      cliProviderId: 'prov-1',
      stepDef: baseStep(),
      providers: [makeProvider()],
      deps: {
        async enqueueCliInvocation() {
          throw new Error('should not enqueue');
        },
      },
    });
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error).toMatch(/no result event/);
    }
  });

  it('fails the step when exitCode is null (abnormal termination)', async () => {
    const state = freshState();
    state.taskStepRow = { ...state.taskStepRow, status: 'waiting_cli' };
    state.cliInvocationRow = {
      id: 'inv-1',
      exitCode: null,
      rawOutput: null,
      parsedOutput: null,
      endedAt: new Date(),
      errorMessage: null,
      createdAt: new Date(),
    };
    const db = makeMockDb(state);
    const result = await advanceStep({
      db,
      taskId: 'task-1',
      userId: 'user-1',
      repoPath: '/tmp',
      workspacePath: '/tmp',
      cliProviderId: 'prov-1',
      stepDef: baseStep(),
      providers: [makeProvider()],
      deps: {
        async enqueueCliInvocation() {
          throw new Error('should not enqueue');
        },
      },
    });
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error).toMatch(/cli exited with code unknown/);
    }
  });
});
