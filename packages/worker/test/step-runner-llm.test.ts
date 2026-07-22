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
      // Apply the side-effect eagerly in set() so an update that does NOT call
      // .returning() (e.g. superseding an orphaned invocation) still takes effect,
      // matching Drizzle's awaitable builder. .returning() then reflects the result.
      const apply = (v: Record<string, unknown>): Record<string, unknown>[] => {
        state.updates.push({ table: tableName, ...v });
        if (tableName === 'task_steps') {
          state.taskStepRow = { ...state.taskStepRow, ...v };
          return [state.taskStepRow];
        }
        // A cli_invocations supersede drops the row from the live/unconsumed set, so a
        // re-dispatch on re-entry sees no ended invocation and dispatches a fresh one.
        if (tableName === 'cli_invocations' && v.supersededAt) state.cliInvocationRow = null;
        return [];
      };
      return {
        set: (v: Record<string, unknown>) => {
          const rows = apply(v);
          return { where: (_: unknown) => ({ returning: async () => rows }) };
        },
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

  it('re-dispatches a fresh invocation when the prior one was killed (null exit, transient)', async () => {
    // A null exit code means the process was terminated before it finished (worker
    // restart, timeout, SIGKILL) — an infrastructure event, not a model failure. The
    // step now supersedes the orphan and dispatches a fresh invocation (bounded by
    // countTrailingOrphans) instead of failing, so a restart mid-run self-heals.
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
    let enqueued = 0;
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
          enqueued += 1;
        },
      },
    });
    expect(result.status).toBe('waiting_cli');
    expect(enqueued).toBe(1);
    expect(state.updates.some((u) => u.table === 'cli_invocations' && u.supersededAt)).toBe(true);
  });

  it('blocks a local Ollama model on an unsafeForLocalModels step', async () => {
    const state = freshState();
    const db = makeMockDb(state);
    const enqueued: CliExecJobPayload[] = [];
    const ollamaProvider = {
      ...makeProvider(),
      id: 'prov-ollama',
      name: 'ollama',
      authMode: 'api_key',
      model: 'qwen3-coder:30b',
      envVars: null, // unset base URL → default in-stack daemon → local
    } as CliProviderRecord;
    const stepDef = baseStep();
    stepDef.metadata.unsafeForLocalModels = true;
    const result = await advanceStep({
      db,
      taskId: 'task-1',
      userId: 'user-1',
      repoPath: '/tmp',
      workspacePath: '/tmp',
      cliProviderId: 'prov-ollama',
      stepDef,
      providers: [ollamaProvider],
      deps: {
        async enqueueCliInvocation(payload) {
          enqueued.push(payload);
        },
      },
    });
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error).toMatch(/blocked for local Ollama models/i);
    }
    expect(enqueued).toHaveLength(0);
    expect(state.inserts.find((i) => i.table === 'cli_invocations')).toBeUndefined();
  });

  it('allows a cloud Ollama model on an unsafeForLocalModels step', async () => {
    const state = freshState();
    const db = makeMockDb(state);
    const enqueued: CliExecJobPayload[] = [];
    const cloudOllama = {
      ...makeProvider(),
      id: 'prov-ollama-cloud',
      name: 'ollama',
      authMode: 'api_key',
      model: 'qwen3-coder:480b-cloud',
      envVars: { ANTHROPIC_BASE_URL: 'https://ollama.com' }, // cloud → not local
    } as CliProviderRecord;
    const stepDef = baseStep();
    stepDef.metadata.unsafeForLocalModels = true;
    const result = await advanceStep({
      db,
      taskId: 'task-1',
      userId: 'user-1',
      repoPath: '/tmp',
      workspacePath: '/tmp',
      cliProviderId: 'prov-ollama-cloud',
      stepDef,
      providers: [cloudOllama],
      deps: {
        async enqueueCliInvocation(payload) {
          enqueued.push(payload);
        },
      },
    });
    expect(result.status).toBe('waiting_cli');
    expect(enqueued).toHaveLength(1);
  });

  it('allows a cloud Ollama model even when no base URL is set (real provider shape)', async () => {
    const state = freshState();
    const db = makeMockDb(state);
    const enqueued: CliExecJobPayload[] = [];
    // Real cloud providers store NO ANTHROPIC_BASE_URL (the local daemon proxies
    // cloud), so detection must key on the -cloud/:cloud model suffix, not the
    // base URL. This is the shape that wrongly tripped the guard in production.
    const cloudOllamaNoUrl = {
      ...makeProvider(),
      id: 'prov-ollama-cloud-nourl',
      name: 'ollama',
      authMode: 'api_key',
      model: 'qwen3-coder:480b-cloud',
      envVars: null,
    } as CliProviderRecord;
    const stepDef = baseStep();
    stepDef.metadata.unsafeForLocalModels = true;
    const result = await advanceStep({
      db,
      taskId: 'task-1',
      userId: 'user-1',
      repoPath: '/tmp',
      workspacePath: '/tmp',
      cliProviderId: 'prov-ollama-cloud-nourl',
      stepDef,
      providers: [cloudOllamaNoUrl],
      deps: {
        async enqueueCliInvocation(payload) {
          enqueued.push(payload);
        },
      },
    });
    expect(result.status).toBe('waiting_cli');
    expect(enqueued).toHaveLength(1);
  });
});
