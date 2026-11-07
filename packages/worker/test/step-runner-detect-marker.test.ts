import { describe, expect, it } from 'vitest';
import type { Database } from '@haive/database';
import type { FormSchema } from '@haive/shared';
import { advanceStep } from '../src/step-engine/step-runner.js';
import type { StepDefinition } from '../src/step-engine/step-definition.js';
import type { CliProviderRecord } from '../src/cli-adapters/types.js';

// The mock DB does not evaluate WHERE, so these tests assert on the patches the runner
// writes and on how often the step's detect and apply ran.

interface MockState {
  taskStepRow: Record<string, unknown>;
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
  return {
    select: () => ({
      from: (table: unknown) => {
        const tableName = tableNameOf(table);
        return {
          where: () => ({
            limit: async () => (tableName === 'task_steps' ? [state.taskStepRow] : []),
            orderBy: () => ({ limit: async () => [] }),
          }),
        };
      },
    }),
    update: (table: unknown) => {
      const tableName = tableNameOf(table);
      return {
        set: (v: Record<string, unknown>) => ({
          where: () => ({
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
      taskStepCliChoices: { findFirst: async () => undefined },
      tasks: {
        findFirst: async () => ({
          id: 'task-1',
          status: 'running',
          autoContinue: true,
          preAnswers: null,
          repositoryId: 'repo-1',
          type: 'env_replicate',
        }),
      },
    },
  } as unknown as Database;
}

const OLD_FORM: FormSchema = {
  title: 'Old',
  fields: [{ type: 'text', id: 'name', label: 'Name', required: true }],
};

function freshState(row: Record<string, unknown>): MockState {
  return {
    taskStepRow: {
      id: 'ts-1',
      taskId: 'task-1',
      stepId: 'marker-step',
      stepIndex: 0,
      round: 0,
      title: 'marker step',
      status: 'pending',
      formSchema: null,
      formValues: null,
      detectOutput: null,
      detectCliProviderId: null,
      output: null,
      iterations: null,
      iterationCount: 0,
      errorMessage: null,
      startedAt: null,
      endedAt: null,
      ...row,
    },
    updates: [],
  };
}

function makeProvider(): CliProviderRecord {
  return {
    id: 'prov-new',
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

function markerStep(opts: { providerSensitive: boolean }) {
  const calls = { detect: 0, apply: 0 };
  const stepDef: StepDefinition = {
    metadata: {
      id: 'marker-step',
      workflowType: 'env_replicate',
      index: 0,
      title: 'marker step',
      description: 'marker step',
      requiresCli: false,
      ...(opts.providerSensitive ? { providerSensitive: true } : {}),
    },
    async detect() {
      calls.detect += 1;
      return { fresh: true };
    },
    form(): FormSchema {
      return {
        title: 'New',
        fields: [{ type: 'text', id: 'name', label: 'Name', required: true }],
      };
    },
    async apply(_ctx, args) {
      calls.apply += 1;
      return { received: args.formValues };
    },
  };
  return { stepDef, calls };
}

function run(state: MockState, stepDef: StepDefinition, formValues?: Record<string, unknown>) {
  return advanceStep({
    db: makeMockDb(state),
    taskId: 'task-1',
    userId: 'user-1',
    repoPath: '/tmp',
    workspacePath: '/tmp',
    cliProviderId: null,
    stepDef,
    providers: [makeProvider()],
    ...(formValues ? { formValues } : {}),
    deps: {
      async enqueueCliInvocation() {
        throw new Error('no CLI invocation expected for a deterministic step');
      },
    },
  });
}

const STORED = {
  detectOutput: { stale: true },
  formSchema: OLD_FORM,
  detectCliProviderId: 'prov-old',
};

describe('advanceStep detect marker', () => {
  it('stamps the provider id the first detect was computed for', async () => {
    const { stepDef, calls } = markerStep({ providerSensitive: true });
    const state = freshState({});
    await run(state, stepDef);
    expect(calls.detect).toBe(1);
    expect(state.taskStepRow.detectCliProviderId).toBe('prov-new');
  });

  it('reuses the stored detect and form when the marker equals the current default', async () => {
    const { stepDef, calls } = markerStep({ providerSensitive: true });
    const state = freshState({
      status: 'waiting_form',
      ...STORED,
      detectCliProviderId: 'prov-new',
    });
    const result = await run(state, stepDef);
    expect(calls.detect).toBe(0);
    expect(result.status).toBe('waiting_form');
    expect(state.taskStepRow.detectOutput).toEqual({ stale: true });
    expect(state.taskStepRow.formSchema).toEqual(OLD_FORM);
  });

  for (const entry of ['waiting_form', 'pending'] as const) {
    it(`re-detects a provider-sensitive step entered ${entry} when the default moved`, async () => {
      const { stepDef, calls } = markerStep({ providerSensitive: true });
      const state = freshState({ status: entry, ...STORED });
      const result = await run(state, stepDef, { name: 'Acme' });
      expect(calls.detect).toBe(1);
      expect(calls.apply).toBe(0);
      expect(result.status).toBe('waiting_form');
      expect(state.taskStepRow.detectOutput).toEqual({ fresh: true });
      expect((state.taskStepRow.formSchema as FormSchema).title).toBe('New');
      expect(state.taskStepRow.formValues ?? null).toBeNull();
      expect(state.taskStepRow.detectCliProviderId).toBe('prov-new');
    });
  }

  it('reuses the stored detect on a step that is not provider-sensitive', async () => {
    const { stepDef, calls } = markerStep({ providerSensitive: false });
    const state = freshState({ status: 'waiting_form', ...STORED });
    await run(state, stepDef);
    expect(calls.detect).toBe(0);
    expect(state.taskStepRow.detectOutput).toEqual({ stale: true });
    expect(state.taskStepRow.formSchema).toEqual(OLD_FORM);
  });

  it('reuses the stored detect when the entry is waiting_cli', async () => {
    const { stepDef, calls } = markerStep({ providerSensitive: true });
    const state = freshState({ status: 'waiting_cli', ...STORED });
    await run(state, stepDef);
    expect(calls.detect).toBe(0);
    expect(state.taskStepRow.detectOutput).toEqual({ stale: true });
    expect(state.taskStepRow.formSchema).toEqual(OLD_FORM);
  });

  it('never re-detects on an unknown marker', async () => {
    const { stepDef, calls } = markerStep({ providerSensitive: true });
    const state = freshState({ status: 'waiting_form', ...STORED, detectCliProviderId: null });
    await run(state, stepDef);
    expect(calls.detect).toBe(0);
    expect(state.taskStepRow.detectOutput).toEqual({ stale: true });
    expect(state.taskStepRow.formSchema).toEqual(OLD_FORM);
  });
});
