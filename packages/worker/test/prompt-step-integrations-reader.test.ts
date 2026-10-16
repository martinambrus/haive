import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '@haive/database';
import type { CliExecJobPayload } from '@haive/shared';
import type { ComposableStepEntry } from '@haive/shared/modularity';
import type { CliProviderRecord } from '../src/cli-adapters/types.js';
import type { StepDefinition } from '../src/step-engine/step-definition.js';
import {
  setComposableCatalog,
  stepIntegrationRequirements,
} from '../src/step-engine/step-integrations.js';
import { advanceStep } from '../src/step-engine/step-runner.js';
import {
  BAD_REQUIREMENTS,
  FORGE_READ,
  STEP_ID,
  TRACKER_OPTIONAL,
  pinnedPromptStep,
} from './support/prompt-step-integrations.js';

// Controls of J6a (task #185), worker side, no database. Tags: [C2] is inside the brief, [C2+] is a pin the
// brief does not state (listed in the harness README), [C0] passes before and after.

const h = vi.hoisted(() => {
  process.env.LOG_LEVEL ??= 'error';
  return { resolveCalls: [] as unknown[][], grantCalls: [] as unknown[][] };
});

vi.mock('../src/orchestrator/global-kb-context.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveGlobalKbContext: async () => ({
    digest: { entries: [], omitted: 0, scanSaturated: false },
    rules: [],
    refused: [],
    status: 'ok',
  }),
}));
vi.mock('@haive/shared/integrations', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@haive/shared/integrations')>()),
  resolveStepIntegrations: async (...args: unknown[]) => {
    h.resolveCalls.push(args);
    return [];
  },
  recordTaskGrants: async (...args: unknown[]) => {
    h.grantCalls.push(args);
  },
}));

interface MockState {
  taskStepRow: Record<string, unknown>;
  cliInvocationRow: Record<string, unknown> | null;
  customSteps?: unknown;
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

// The hand-rolled database of the step-runner unit tests (test/step-runner-llm.test.ts): it answers what a
// prompt step's dispatch reads, records what it inserts, and has no integration tables and no `execute`.
function makeMockDb(state: MockState): Database {
  let nextId = 1;
  const db = {
    select: () => ({
      from: (table: unknown) => {
        const tableName = tableNameOf(table);
        const allRows = async () =>
          tableName === 'task_steps' && state.taskStepRow.id ? [state.taskStepRow] : [];
        return {
          where: (_cond: unknown) => ({
            limit: async (_n: number) =>
              tableName === 'task_steps' && state.taskStepRow.id ? [state.taskStepRow] : [],
            orderBy: (_o: unknown) => ({
              limit: async (_n: number) =>
                tableName === 'cli_invocations' && state.cliInvocationRow
                  ? [state.cliInvocationRow]
                  : [],
              ...(tableName === 'task_events'
                ? {
                    then: (onOk: (r: unknown) => unknown, onErr?: (e: unknown) => unknown) =>
                      Promise.resolve([]).then(onOk, onErr),
                  }
                : {}),
            }),
            then: (onOk: (r: unknown) => unknown, onErr?: (e: unknown) => unknown) =>
              allRows().then(onOk, onErr),
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
    transaction: async (fn: (tx: unknown) => unknown) => fn(db),
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
          onConflictDoUpdate: async (_opts: unknown) => {
            state.inserts.push({ table: tableName, row: v });
          },
        }),
      };
    },
    update: (table: unknown) => {
      const tableName = tableNameOf(table);
      const apply = (v: Record<string, unknown>): Record<string, unknown>[] => {
        state.updates.push({ table: tableName, ...v });
        if (tableName === 'task_steps') {
          state.taskStepRow = { ...state.taskStepRow, ...v };
          return [state.taskStepRow];
        }
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
    query: {
      userStepCliPreferences: { findFirst: async () => undefined },
      userStepCliRolePreferences: { findFirst: async () => undefined },
      taskStepCliChoices: { findFirst: async () => undefined },
      taskStepCliTouched: { findFirst: async () => undefined },
      tasks: {
        findFirst: async (opts?: { columns?: { customSteps?: boolean } }) =>
          opts?.columns?.customSteps && state.customSteps !== undefined
            ? { customSteps: state.customSteps, repositoryId: 'repo-1', type: 'demo' }
            : undefined,
      },
      taskSteps: { findFirst: async () => undefined },
      envTemplates: { findFirst: async () => undefined },
      repositories: { findFirst: async () => undefined },
    },
  } as unknown as Database;
  return db;
}

function freshState(stepId: string): MockState {
  return {
    taskStepRow: {
      id: 'ts-1',
      taskId: 'task-1',
      stepId,
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

async function dispatch(stepDef: StepDefinition, stored: unknown) {
  const state = freshState(stepDef.metadata.id);
  state.customSteps = stored;
  const enqueued: CliExecJobPayload[] = [];
  const result = await advanceStep({
    db: makeMockDb(state),
    taskId: 'task-1',
    userId: 'user-1',
    repoPath: '/tmp',
    workspacePath: '/tmp',
    cliProviderId: 'prov-1',
    stepDef,
    providers: [makeProvider()],
    deps: {
      async enqueueCliInvocation(payload) {
        enqueued.push(payload);
      },
    },
  });
  const runs = state.inserts.filter((i) => i.table === 'cli_invocations');
  return { result, state, enqueued, runs };
}

const failure = (result: Awaited<ReturnType<typeof dispatch>>['result']): string =>
  result.status === 'failed' ? result.error : '';

beforeEach(() => {
  h.resolveCalls.length = 0;
  h.grantCalls.length = 0;
  setComposableCatalog(new Map());
});

describe('[C2] the one reader of what a step declares, and a pinned prompt step', () => {
  it('[C2] returns the requirements a pinned prompt step declares, in order', () => {
    const { stepDef } = pinnedPromptStep([FORGE_READ, TRACKER_OPTIONAL]);

    const read = stepIntegrationRequirements(stepDef);

    expect(Array.isArray(read)).toBe(true);
    expect(read).toEqual([FORGE_READ, TRACKER_OPTIONAL]);
  });

  it('[C2] reads the list of the step it is given, not of another pinned step', () => {
    const first = pinnedPromptStep([FORGE_READ]);
    const second = pinnedPromptStep([TRACKER_OPTIONAL], {
      id: 'custom.demo.other',
      slug: 'other',
    });

    expect(stepIntegrationRequirements(first.stepDef)).toEqual([FORGE_READ]);
    expect(stepIntegrationRequirements(second.stepDef)).toEqual([TRACKER_OPTIONAL]);
  });

  it('[C2+] reads what the task pinned, not a catalog entry that happens to sit under the same id', () => {
    const stale: ComposableStepEntry = {
      stepId: STEP_ID,
      label: STEP_ID,
      group: 'build',
      dispatchesCli: true,
      requires: [],
      provides: [],
      integrations: [{ id: 'stale', category: 'chat', access: 'read' }],
    };
    setComposableCatalog(new Map([[STEP_ID, stale]]));
    const { stepDef } = pinnedPromptStep([FORGE_READ]);

    expect(stepIntegrationRequirements(stepDef)).toEqual([FORGE_READ]);
  });

  it('[C0] returns nothing for a pinned prompt step that declares none', () => {
    for (const declared of [undefined, []]) {
      const { stepDef } = pinnedPromptStep(declared);

      expect(stepIntegrationRequirements(stepDef)).toEqual([]);
    }
  });
});

describe('[C2] the dispatch of a pinned prompt step that declares integrations', () => {
  it('[C2] hands what it declares to the resolver and goes on to queue the run', async () => {
    const { stepDef, stored } = pinnedPromptStep([FORGE_READ, TRACKER_OPTIONAL]);

    const { result, runs, enqueued } = await dispatch(stepDef, stored);

    expect(result.status).toBe('waiting_cli');
    expect(h.resolveCalls.length, 'calls of the resolver').toBeGreaterThan(0);
    for (const call of h.resolveCalls) {
      expect(call[1]).toMatchObject({ taskId: 'task-1' });
      expect(call[2]).toEqual([FORGE_READ, TRACKER_OPTIONAL]);
    }
    expect(runs).toHaveLength(1);
    expect(enqueued).toHaveLength(1);
  });

  describe.each([
    ['alone', (bad: unknown) => [bad]],
    ['after a valid one', (bad: unknown) => [FORGE_READ, bad]],
    ['before a valid one', (bad: unknown) => [bad, FORGE_READ]],
  ])('a requirement that no longer parses, %s', (_where, declare) => {
    it.each(BAD_REQUIREMENTS)(
      '[C2] fails the step integration-requirement-invalid naming a requirement with %s, before any resolution, with no invocation row',
      async (_label, bad, id) => {
        const { stepDef, stored } = pinnedPromptStep(declare(bad));

        const { result, state, runs, enqueued } = await dispatch(stepDef, stored);

        expect(result.status).toBe('failed');
        expect(failure(result)).toMatch(/^integration-requirement-invalid\b/);
        expect(failure(result)).toContain(id);
        expect(state.taskStepRow.status).toBe('failed');
        expect(runs, 'cli_invocations inserts').toEqual([]);
        expect(enqueued, 'enqueues').toEqual([]);
        expect(h.resolveCalls, 'calls of the resolver').toEqual([]);
        expect(h.grantCalls, 'grants written').toEqual([]);
      },
    );
  });

  it('[C2+] names every requirement that no longer parses', async () => {
    const bad = BAD_REQUIREMENTS[0]![1];
    const { stepDef, stored } = pinnedPromptStep([
      bad,
      FORGE_READ,
      { id: 'second-broken', access: 'read' },
    ]);

    const { result } = await dispatch(stepDef, stored);

    expect(failure(result)).toMatch(/^integration-requirement-invalid\b/);
    expect(failure(result)).toContain('broken');
    expect(failure(result)).toContain('second-broken');
  });

  it('[C0] a pinned prompt step that declares none resolves nothing and queues one unstamped run', async () => {
    const { stepDef, stored } = pinnedPromptStep(undefined);

    const { result, runs, enqueued } = await dispatch(stepDef, stored);

    expect(result.status).toBe('waiting_cli');
    expect(h.resolveCalls).toEqual([]);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.row.integrations ?? null).toBeNull();
    expect(enqueued).toHaveLength(1);
  });
});
