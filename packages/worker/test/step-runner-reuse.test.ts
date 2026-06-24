import { describe, expect, it } from 'vitest';
import type { Database } from '@haive/database';
import type { FormSchema } from '@haive/shared';
import { advanceStep } from '../src/step-engine/step-runner.js';
import type { StepDefinition } from '../src/step-engine/step-definition.js';
import type { CliProviderRecord } from '../src/cli-adapters/types.js';

// Unit coverage for the runner's "reuse a prior completed task's form values"
// auto-submit path (metadata.reuseLastCompletedFormValues). These tests drive the
// RUNNER branching with a synthetic step; the SQL filter inside
// loadLastCompletedFormValues (completed task + done step + non-null formValues)
// is exercised by the real-stack e2e path, since the mock DB below does not
// evaluate WHERE conditions. `priorFormValues` stands in for whatever that query
// returns; `reuseQueried` records whether the runner issued the join at all.

interface MockState {
  taskStepRow: Record<string, unknown>;
  taskRow: Record<string, unknown> | null;
  /** Rows the reuse join returns. null => no prior completed task with this form. */
  priorFormValues: Record<string, unknown> | null;
  reuseQueried: boolean;
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
          // upsertRow: task_steps where(...).limit(1). cli_invocations is never
          // queried here (the synthetic step dispatches no CLI).
          where: (_cond: unknown) => ({
            limit: async (_n: number) => {
              if (tableName === 'task_steps') {
                return state.taskStepRow.id ? [state.taskStepRow] : [];
              }
              return [];
            },
            orderBy: (_o: unknown) => ({
              limit: async (_n: number) => [],
            }),
          }),
          // loadLastCompletedFormValues: select(formValues).from(task_steps)
          //   .innerJoin(tasks).where(...).orderBy(desc).limit(1)
          innerJoin: (_joinTable: unknown, _on: unknown) => ({
            where: (_cond: unknown) => ({
              orderBy: (_o: unknown) => ({
                limit: async (_n: number) => {
                  state.reuseQueried = true;
                  void cols;
                  return state.priorFormValues !== null
                    ? [{ formValues: state.priorFormValues }]
                    : [];
                },
              }),
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
          where: (_: unknown) => ({
            returning: async () => {
              state.updates.push({ table: tableName, patch: v });
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
    query: {
      userStepCliPreferences: { findFirst: async () => undefined },
      tasks: {
        findFirst: async () => state.taskRow ?? undefined,
      },
    },
  } as unknown as Database;
  return db;
}

function freshState(overrides?: {
  taskRow?: Record<string, unknown> | null;
  priorFormValues?: Record<string, unknown> | null;
}): MockState {
  return {
    taskStepRow: {
      id: 'ts-1',
      taskId: 'task-1',
      stepId: 'reuse-form-step',
      stepIndex: 0,
      round: 0,
      title: 'reuse form step',
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
    taskRow:
      overrides?.taskRow === undefined
        ? {
            id: 'task-1',
            status: 'running',
            autoContinue: true,
            preAnswers: null,
            repositoryId: 'repo-1',
            type: 'env_replicate',
          }
        : overrides.taskRow,
    priorFormValues: overrides?.priorFormValues ?? null,
    reuseQueried: false,
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

/** A deterministic env-replicate-style step: detect + a 2-field form + apply,
 *  no CLI. Opts into prior-task reuse unless `optIn: false`. */
function reuseFormStep(opts?: { optIn?: boolean }): StepDefinition {
  return {
    metadata: {
      id: 'reuse-form-step',
      workflowType: 'env_replicate',
      index: 0,
      title: 'reuse form step',
      description: 'reuse form step',
      requiresCli: false,
      ...(opts?.optIn === false ? {} : { reuseLastCompletedFormValues: true }),
    },
    async detect() {
      return { ready: true };
    },
    form(): FormSchema {
      return {
        title: 'Deps',
        fields: [
          { type: 'text', id: 'name', label: 'Name', required: true },
          {
            type: 'select',
            id: 'color',
            label: 'Color',
            required: true,
            options: [
              { value: 'red', label: 'Red' },
              { value: 'green', label: 'Green' },
            ],
          },
        ],
      };
    },
    async apply(_ctx, args) {
      return { received: args.formValues };
    },
  };
}

function runParams(state: MockState, stepDef: StepDefinition) {
  return {
    db: makeMockDb(state),
    taskId: 'task-1',
    userId: 'user-1',
    repoPath: '/tmp',
    workspacePath: '/tmp',
    cliProviderId: null,
    stepDef,
    providers: [makeProvider()],
    deps: {
      async enqueueCliInvocation() {
        throw new Error('no CLI invocation expected for a deterministic step');
      },
    },
  };
}

describe('advanceStep prior-task form-value reuse', () => {
  it("reuses a prior completed task's exact form values when auto-continue is on", async () => {
    const state = freshState({ priorFormValues: { name: 'Acme', color: 'green' } });
    const result = await advanceStep(runParams(state, reuseFormStep()));
    expect(state.reuseQueried).toBe(true);
    expect(result.status).toBe('done');
    expect(state.taskStepRow.formValues).toEqual({ name: 'Acme', color: 'green' });
    // apply received exactly the reused values.
    expect((state.taskStepRow.output as { received?: unknown }).received).toEqual({
      name: 'Acme',
      color: 'green',
    });
  });

  it('does not reuse and parks on waiting_form when auto-continue is off', async () => {
    const state = freshState({
      taskRow: {
        id: 'task-1',
        status: 'running',
        autoContinue: false,
        preAnswers: null,
        repositoryId: 'repo-1',
        type: 'env_replicate',
      },
      priorFormValues: { name: 'Acme', color: 'green' },
    });
    const result = await advanceStep(runParams(state, reuseFormStep()));
    expect(state.reuseQueried).toBe(false);
    expect(result.status).toBe('waiting_form');
    expect(state.taskStepRow.formValues).toBeNull();
  });

  it('parks on waiting_form when no prior completed task exists (first task on the repo)', async () => {
    const state = freshState({ priorFormValues: null });
    const result = await advanceStep(runParams(state, reuseFormStep()));
    expect(state.reuseQueried).toBe(true);
    expect(result.status).toBe('waiting_form');
    expect(state.taskStepRow.formValues).toBeNull();
  });

  it('does not query reuse for a step that has not opted in', async () => {
    const state = freshState({ priorFormValues: { name: 'Acme', color: 'green' } });
    const result = await advanceStep(runParams(state, reuseFormStep({ optIn: false })));
    expect(state.reuseQueried).toBe(false);
    // No opt-in, no autoSubmitDefaults/autoSubmit => still parks even under auto-continue.
    expect(result.status).toBe('waiting_form');
  });

  it('does not reuse when the task has no repository', async () => {
    const state = freshState({
      taskRow: {
        id: 'task-1',
        status: 'running',
        autoContinue: true,
        preAnswers: null,
        repositoryId: null,
        type: 'env_replicate',
      },
      priorFormValues: { name: 'Acme', color: 'green' },
    });
    const result = await advanceStep(runParams(state, reuseFormStep()));
    expect(state.reuseQueried).toBe(false);
    expect(result.status).toBe('waiting_form');
  });

  it('falls back to waiting_form when reused values fail validation against the current schema', async () => {
    // `purple` is no longer an offered option => validation fails => manual entry.
    const state = freshState({ priorFormValues: { name: 'Acme', color: 'purple' } });
    const result = await advanceStep(runParams(state, reuseFormStep()));
    expect(state.reuseQueried).toBe(true);
    expect(result.status).toBe('waiting_form');
    expect(state.taskStepRow.formValues).toBeNull();
  });

  it('lets a gate pre-answer take precedence over reused values', async () => {
    const state = freshState({
      taskRow: {
        id: 'task-1',
        status: 'running',
        autoContinue: true,
        preAnswers: { 'reuse-form-step': { name: 'Gate', color: 'red' } },
        repositoryId: 'repo-1',
        type: 'env_replicate',
      },
      priorFormValues: { name: 'Acme', color: 'green' },
    });
    const result = await advanceStep(runParams(state, reuseFormStep()));
    // Pre-answer wins; reuse query is skipped entirely.
    expect(state.reuseQueried).toBe(false);
    expect(result.status).toBe('done');
    expect(state.taskStepRow.formValues).toEqual({ name: 'Gate', color: 'red' });
  });
});
