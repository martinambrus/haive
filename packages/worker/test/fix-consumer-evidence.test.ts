import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '@haive/database';
vi.mock('../src/step-engine/steps/workflow/_fix-test-store.js', () => ({
  beginFixTestCapture: vi.fn(async () => undefined),
  finishFixTestCapture: vi.fn(async () => undefined),
  loadFixTestRecords: vi.fn(async () => []),
}));
vi.mock('../src/repo/worktree-git-boundary.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveInvocationWorkerTree: async () => '/tmp',
}));
vi.mock('../src/orchestrator/global-kb-context.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveGlobalKbContext: async () => ({
    digest: { entries: [], omitted: 0, scanSaturated: false },
    rules: [],
    refused: [],
    status: 'ok',
  }),
}));
import {
  beginFixTestCapture,
  finishFixTestCapture,
} from '../src/step-engine/steps/workflow/_fix-test-store.js';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { advanceStep } from '../src/step-engine/step-runner.js';
import type { StepDefinition } from '../src/step-engine/step-definition.js';
import type { CliProviderRecord } from '../src/cli-adapters/types.js';

interface MockState {
  roundChoice?: CliProviderRecord;
  taskStepRow: Record<string, unknown>;
  cliInvocationRow: Record<string, unknown> | null;
  /** Rows the WIDE invocation reads see — the trailing-history counters
   *  (countTrailingOrphans and friends read `limit(10)`, newest first). Unset means
   *  "the history is just the live row", which is what every test predating it assumes. */
  cliInvocationHistory?: Record<string, unknown>[];
  /** Task ledger events, as `loadLedgerEntries` reads them. Unset means an empty ledger. */
  taskEvents?: { payload: Record<string, unknown>; taskStepId: string | null }[];
  /** The task's `custom_steps` as stored; unset means the read of it finds no task. */
  customSteps?: unknown;
  /** The task type's `requires_repository`; unset means the type has no row. */
  requiresRepository?: boolean;
  executionContract?: unknown;
  requests?: { payload: Record<string, unknown> }[];
  updates: Record<string, unknown>[];
  inserts: { table: string; row: Record<string, unknown> }[];
}

interface MockDbOptions {
  refuseUpdate?: (
    table: string,
    values: Record<string, unknown>,
    draft: MockState,
    inTransaction: boolean,
  ) => boolean;
}

function makeMockDb(state: MockState, opts: MockDbOptions = {}, inTransaction = false): Database {
  let nextId = 1;
  const db = {
    select: () => ({
      from: (table: unknown) => {
        const tableName = tableNameOf(table);
        // Every row of the table, for the un-limited/un-ordered form of the query.
        const allRows = async () =>
          tableName === 'task_steps' && state.taskStepRow.id
            ? [state.taskStepRow]
            : tableName === 'task_events'
              ? (state.requests ?? [])
              : tableName === 'tasks'
                ? [{ executionContract: state.executionContract ?? null }]
                : [];
        return {
          where: (_cond: SQL) => ({
            limit: async (_n: number) => {
              if (tableName === 'task_steps') {
                return state.taskStepRow.id ? [state.taskStepRow] : [];
              }
              if (tableName === 'tasks')
                return [{ executionContract: state.executionContract ?? null }];
              if (tableName === 'cli_invocations') {
                const { sql, params } = new PgDialect().sqlToQuery(_cond);
                // The singleton guard's non-ordered read, separate from latest/history.
                expect(sql).toContain('"ended_at" is null');
                expect(sql).toContain('"superseded_at" is null');
                expect(sql).toContain('"mode" not in');
                expect(params.slice(1)).toEqual(['agent_mining', 'dag_parallel']);
                const row = state.cliInvocationRow;
                return row &&
                  row.taskStepId === params[0] &&
                  row.endedAt === null &&
                  row.supersededAt == null &&
                  !params.slice(1).includes(row.mode)
                  ? [row]
                  : [];
              }
              return [];
            },
            orderBy: (_o: unknown) => ({
              limit: async (n: number) => {
                if (tableName === 'cli_invocations') {
                  // limit(1) is the "latest live invocation" read; anything wider is a
                  // trailing-history count, which needs more than the one live row.
                  if (n > 1 && state.cliInvocationHistory)
                    return state.cliInvocationHistory.slice(0, n);
                  return state.cliInvocationRow && !state.cliInvocationRow.consumedAt
                    ? [state.cliInvocationRow]
                    : [];
                }
                return [];
              },
              // The ledger's read awaits the ordered query with no limit.
              ...(tableName === 'task_events'
                ? {
                    then: (onOk: (r: unknown) => unknown, onErr?: (e: unknown) => unknown) =>
                      Promise.resolve(state.taskEvents ?? []).then(onOk, onErr),
                  }
                : {}),
            }),
            // Drizzle's query builder is a thenable: awaiting .where() directly, with no
            // .limit()/.orderBy(), runs the query. learnedTimeoutMs does exactly that, and
            // without this the await yielded the builder object itself — not iterable, so
            // the dispatch threw and the step came back `failed`.
            then: (onOk: (r: unknown) => unknown, onErr?: (e: unknown) => unknown) =>
              allRows().then(onOk, onErr),
            // The lock a run is recorded under: the row, while it is still the pass's own.
            for: async () =>
              tableName === 'task_steps' &&
              state.taskStepRow.id &&
              !['pending', 'skipped', 'failed'].includes(String(state.taskStepRow.status))
                ? [{ id: state.taskStepRow.id }]
                : [],
          }),
        };
      },
    }),
    transaction: async (fn: (tx: unknown) => unknown) => {
      // Isolate transaction writes: a hook accidentally using the outer db must
      // leave its insert behind when the owned checkpoint refuses the draft.
      const draft = {
        ...state,
        taskStepRow: { ...state.taskStepRow },
        cliInvocationRow: state.cliInvocationRow && { ...state.cliInvocationRow },
        updates: [...state.updates],
        inserts: [...state.inserts],
      };
      const result = await fn(makeMockDb(draft, opts, true));
      Object.assign(state, draft);
      return result;
    },
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
          onConflictDoNothing: async () => {
            if (!state.inserts.some((entry) => entry.table === tableName && entry.row.id === v.id))
              state.inserts.push({ table: tableName, row: v });
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
        if (tableName === 'cli_invocations' && v.consumedAt && state.cliInvocationRow)
          Object.assign(state.cliInvocationRow, v);
        return [];
      };
      return {
        set: (v: Record<string, unknown>) => {
          const rows = opts.refuseUpdate?.(tableName, v, state, inTransaction) ? [] : apply(v);
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
      userStepCliRolePreferences: { findFirst: async () => undefined },
      taskStepCliChoices: {
        findFirst: async ({ where }: { where: SQL }) =>
          state.roundChoice && new PgDialect().sqlToQuery(where).params.includes('fix:2:default')
            ? { role: 'fix:2:default', cliProviderId: state.roundChoice.id, effortLevel: null }
            : undefined,
      },
      cliProviders: { findFirst: async () => state.roundChoice },
      tasks: {
        findFirst: async (opts?: { columns?: Record<string, boolean> }) =>
          opts?.columns?.executionContract ||
          (!opts?.columns && state.executionContract !== undefined)
            ? { executionContract: state.executionContract ?? null }
            : opts?.columns?.customSteps && state.customSteps !== undefined
              ? { customSteps: state.customSteps, type: 'custom-type' }
              : undefined,
      },
      taskTypeDefinitions: {
        findFirst: async () =>
          state.requiresRepository === undefined
            ? undefined
            : { requiresRepository: state.requiresRepository },
      },
      // resolveTaskDispatch resolves the invocation's MCP surface so the prompt can
      // state it; that reads the step-04 tooling output and the env template.
      taskSteps: { findFirst: async () => undefined },
      taskEvents: { findFirst: async () => undefined },
      envTemplates: { findFirst: async () => undefined },
      repositories: { findFirst: async () => undefined },
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

const MODULE_TARGET = 'module.fx.fix';
const pin = (stepId: string, capabilityVersion = 1) => ({
  version: 1,
  guardedSpans: [],
  fixTarget: { stepId, capabilityVersion },
});
const request = (round: number) => ({
  payload: { round, sourceStepId: '08c-code-review', diagnosis: 'x' },
});

interface Setup {
  id?: string;
  fixConsumer?: unknown;
  round?: number;
  executionContract?: unknown;
  requests?: { payload: Record<string, unknown> }[];
}
async function dispatch(setup: Setup) {
  const id = setup.id ?? MODULE_TARGET;
  const state = freshState();
  const original = baseStep();
  const step = {
    ...original,
    metadata: { ...original.metadata, id },
    detect: async () => ({ foo: 'bar' }),
    ...(setup.fixConsumer === undefined
      ? {}
      : { fixConsumer: setup.fixConsumer, editsCodeOrTests: true }),
  } as unknown as StepDefinition;
  state.taskStepRow.stepId = id;
  state.taskStepRow.round = setup.round ?? 2;
  state.executionContract = setup.executionContract;
  state.requests = setup.requests ?? [];
  const enqueue = vi.fn();
  const params = {
    db: makeMockDb(state),
    taskId: 'task-1',
    userId: 'user-1',
    round: setup.round ?? 2,
    repoPath: '/tmp',
    workspacePath: '/tmp',
    cliProviderId: 'prov-1',
    stepDef: step,
    providers: [makeProvider()],
    deps: { enqueueCliInvocation: enqueue },
  };
  const result = await advanceStep(params).then(
    (value) => ({ value, error: null as unknown }),
    (error: unknown) => ({ value: null, error }),
  );
  return { result, state, params, enqueue };
}
const capable = {
  fixConsumer: { version: 1 },
  executionContract: pin(MODULE_TARGET),
  requests: [request(2)],
};

describe('repair evidence for a pinned fix target', () => {
  beforeEach(() => {
    vi.mocked(beginFixTestCapture).mockClear();
    vi.mocked(finishFixTestCapture).mockReset();
  });

  it('captures before enqueue and settles before apply for a capable pinned step at a recorded-request round, with no fixContext in its detect output', async () => {
    const { result, enqueue, state, params } = await dispatch(capable);
    expect(result.error).toBeNull();
    expect(result.value?.status).toBe('waiting_cli');
    expect(beginFixTestCapture).toHaveBeenCalledTimes(1);
    expect(beginFixTestCapture).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ stepId: MODULE_TARGET, round: 2 }),
    );
    expect(vi.mocked(beginFixTestCapture).mock.invocationCallOrder[0]).toBeLessThan(
      enqueue.mock.invocationCallOrder[0]!,
    );
    const invocationId = String(state.cliInvocationRow!.id);
    Object.assign(state.cliInvocationRow!, { endedAt: new Date(), exitCode: 0, rawOutput: '{}' });
    const apply = vi.fn(params.stepDef.apply);
    params.stepDef.apply = apply;
    vi.mocked(finishFixTestCapture).mockImplementationOnce(async () => {
      expect(state.updates.some((u) => u.consumedAt)).toBe(false);
      expect(apply).not.toHaveBeenCalled();
    });
    await advanceStep(params);
    expect(finishFixTestCapture).toHaveBeenLastCalledWith(expect.anything(), invocationId);
    expect(vi.mocked(finishFixTestCapture).mock.invocationCallOrder.at(-1)).toBeLessThan(
      apply.mock.invocationCallOrder[0]!,
    );
  });

  const none: [string, Setup][] = [
    [
      'round 0 even with a request recorded for it',
      { ...capable, round: 0, requests: [request(0)] },
    ],
    ['a later round with no recorded request', { ...capable, requests: [] }],
    [
      'a later round whose only request is for another round',
      { ...capable, requests: [request(1)] },
    ],
    ['a pin that names another step', { ...capable, executionContract: pin('module.fx.other') }],
    ['a capability version that differs from the pin', { ...capable, fixConsumer: { version: 2 } }],
    ['a pin whose target is not capable', { ...capable, fixConsumer: undefined }],
    [
      'a pin naming a core step that declares the capability',
      { ...capable, id: '08-phase-5-verify', executionContract: pin('08-phase-5-verify') },
    ],
    ['a task with no pin', { ...capable, executionContract: null }],
    ['a pin without a target', { ...capable, executionContract: { version: 1, guardedSpans: [] } }],
  ];
  it.each(none)('takes no capture for %s', async (_name, setup) => {
    const { result, enqueue } = await dispatch(setup);
    expect(result.error).toBeNull();
    expect(result.value?.status).toBe('waiting_cli');
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(beginFixTestCapture).not.toHaveBeenCalled();
  });

  it('does not swallow a malformed pin: nothing is captured or queued', async () => {
    const { result, enqueue } = await dispatch({ ...capable, executionContract: { version: 99 } });
    expect(result.error !== null || result.value?.status === 'failed').toBe(true);
    expect(enqueue).not.toHaveBeenCalled();
    expect(beginFixTestCapture).not.toHaveBeenCalled();
  });

  it('settles evidence for a step that declares the capability even with no pin', async () => {
    const { state, params } = await dispatch({ fixConsumer: { version: 1 } });
    const invocationId = String(state.cliInvocationRow!.id);
    Object.assign(state.cliInvocationRow!, { endedAt: new Date(), exitCode: 0, rawOutput: '{}' });
    await advanceStep(params);
    expect(finishFixTestCapture).toHaveBeenCalledWith(expect.anything(), invocationId);
  });

  it('settles no evidence for a step without the capability and not on the legacy list', async () => {
    const { state, params } = await dispatch({ id: 'module.fx.plain' });
    Object.assign(state.cliInvocationRow!, { endedAt: new Date(), exitCode: 0, rawOutput: '{}' });
    await advanceStep(params);
    expect(finishFixTestCapture).not.toHaveBeenCalled();
  });

  it('still captures the legacy 07 repair on its fixContext, whatever the pin', async () => {
    const state = freshState();
    const original = baseStep();
    state.taskStepRow.stepId = '07-phase-2-implement';
    state.taskStepRow.round = 2;
    state.executionContract = pin(MODULE_TARGET);
    const step = {
      ...original,
      metadata: { ...original.metadata, id: '07-phase-2-implement' },
      detect: async () => ({ foo: 'bar', fixContext: 'repair' }),
    } as StepDefinition;
    const result = await advanceStep({
      db: makeMockDb(state),
      taskId: 'task-1',
      userId: 'user-1',
      repoPath: '/tmp',
      workspacePath: '/tmp',
      cliProviderId: 'prov-1',
      stepDef: step,
      providers: [makeProvider()],
      deps: { enqueueCliInvocation: vi.fn() },
    });
    expect(result.status).toBe('waiting_cli');
    expect(beginFixTestCapture).toHaveBeenCalledTimes(1);
  });
});
