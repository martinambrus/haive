import { describe, expect, it } from 'vitest';
import type { Database } from '@haive/database';
import type { FormSchema } from '@haive/shared';
import { advanceStep } from '../src/step-engine/step-runner.js';
import type { StepDefinition } from '../src/step-engine/step-definition.js';

interface MockState {
  taskStepRow: Record<string, unknown>;
  taskRow: Record<string, unknown> | null;
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
    select: () => ({
      from: (table: unknown) => {
        const tableName = tableNameOf(table);
        return {
          where: () => ({
            limit: async () => {
              if (tableName === 'task_steps') {
                return state.taskStepRow.id ? [state.taskStepRow] : [];
              }
              return [];
            },
            orderBy: () => ({ limit: async () => [] }),
          }),
        };
      },
    }),
    insert: (table: unknown) => {
      const tableName = tableNameOf(table);
      return {
        values: (v: Record<string, unknown>) => ({
          returning: async () => {
            const row = { id: `mock-${nextId++}`, createdAt: new Date(), ...v };
            if (tableName === 'task_steps') {
              state.taskStepRow = { ...state.taskStepRow, ...row };
            }
            return [row];
          },
          onConflictDoUpdate: async () => undefined,
        }),
      };
    },
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
      stepId: 'cfg-step',
      stepIndex: 0,
      title: 'cfg step',
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
    taskRow: null,
    updates: [],
  };
}

interface StepOpts {
  form?: (() => FormSchema | null) | undefined;
  hasFormMethod?: boolean;
  autoSubmitDefaults?: boolean;
}

function makeStep(opts: StepOpts): StepDefinition {
  const def: StepDefinition = {
    metadata: {
      id: 'cfg-step',
      workflowType: 'workflow',
      index: 0,
      title: 'cfg step',
      description: 'config test step',
      requiresCli: false,
      autoSubmitDefaults: opts.autoSubmitDefaults ?? false,
    },
    async detect() {
      return { ok: true };
    },
    async apply(_ctx, args) {
      return { applied: true, values: args.formValues };
    },
  };
  if (opts.hasFormMethod !== false && opts.form) {
    def.form = opts.form;
  }
  return def;
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
    ...(formValues ? { formValues } : {}),
  });
}

const ZERO_FIELD_FORM: FormSchema = { title: 'Info only', fields: [], submitLabel: 'OK' };

const QUESTION_FORM: FormSchema = {
  title: 'Pick',
  fields: [
    {
      type: 'radio',
      id: 'action',
      label: 'Action',
      options: [
        { value: 'update', label: 'Update' },
        { value: 'skip', label: 'Skip' },
      ],
      default: 'update',
      required: true,
    },
    { type: 'checkbox', id: 'flag', label: 'Flag', default: true },
  ],
};

describe('advanceStep auto-continue', () => {
  it('auto mode passes zero-field info forms without stopping', async () => {
    const state = freshState();
    state.taskRow = { id: 'task-1', autoContinue: true, preAnswers: null };
    const result = await run(state, makeStep({ form: () => ZERO_FIELD_FORM }));
    expect(result.status).toBe('done');
    expect(state.taskStepRow.formValues).toEqual({});
  });

  it('missing task row behaves like auto mode (legacy fixtures)', async () => {
    const state = freshState();
    state.taskRow = null;
    const result = await run(state, makeStep({ form: () => ZERO_FIELD_FORM }));
    expect(result.status).toBe('done');
  });

  it('auto mode still stops on forms with real questions and no pre-answer', async () => {
    const state = freshState();
    state.taskRow = { id: 'task-1', autoContinue: true, preAnswers: null };
    const result = await run(state, makeStep({ form: () => QUESTION_FORM }));
    expect(result.status).toBe('waiting_form');
    expect(state.taskStepRow.status).toBe('waiting_form');
  });

  it('auto mode never auto-passes submitAction retry forms', async () => {
    const state = freshState();
    state.taskRow = { id: 'task-1', autoContinue: true, preAnswers: null };
    const retryForm: FormSchema = { ...ZERO_FIELD_FORM, submitAction: 'retry' };
    const result = await run(state, makeStep({ form: () => retryForm }));
    expect(result.status).toBe('waiting_form');
  });

  it('auto mode submits a valid pre-answer and fills omitted fields from defaults', async () => {
    const state = freshState();
    state.taskRow = {
      id: 'task-1',
      autoContinue: true,
      preAnswers: { 'cfg-step': { action: 'skip' } },
    };
    const result = await run(state, makeStep({ form: () => QUESTION_FORM }));
    expect(result.status).toBe('done');
    const values = state.taskStepRow.formValues as Record<string, unknown>;
    expect(values.action).toBe('skip');
    // omitted checkbox falls back to the (overlaid) schema default
    expect(values.flag).toBe(true);
  });

  it('auto mode falls back to waiting_form when the pre-answer fails validation', async () => {
    const state = freshState();
    state.taskRow = {
      id: 'task-1',
      autoContinue: true,
      preAnswers: { 'cfg-step': { action: 'not-an-option' } },
    };
    const result = await run(state, makeStep({ form: () => QUESTION_FORM }));
    expect(result.status).toBe('waiting_form');
    expect(state.taskStepRow.status).toBe('waiting_form');
    expect(state.taskStepRow.errorMessage).toBeNull();
    // Invalid option must NOT be forced into the persisted schema defaults.
    const schema = state.taskStepRow.formSchema as FormSchema;
    const radio = schema.fields.find((f) => f.id === 'action');
    expect(radio && 'default' in radio ? radio.default : undefined).toBe('update');
  });

  it('pre-answers overlay the persisted schema defaults for forms that stop', async () => {
    const state = freshState();
    state.taskRow = {
      id: 'task-1',
      autoContinue: false,
      preAnswers: { 'cfg-step': { action: 'skip', flag: false } },
    };
    const result = await run(state, makeStep({ form: () => QUESTION_FORM }));
    expect(result.status).toBe('waiting_form');
    const schema = state.taskStepRow.formSchema as FormSchema;
    const radio = schema.fields.find((f) => f.id === 'action');
    const checkbox = schema.fields.find((f) => f.id === 'flag');
    expect(radio && 'default' in radio ? radio.default : undefined).toBe('skip');
    expect(checkbox && 'default' in checkbox ? checkbox.default : undefined).toBe(false);
  });

  it('manual mode pauses formless steps on a synthesized Continue schema', async () => {
    const state = freshState();
    state.taskRow = { id: 'task-1', autoContinue: false, preAnswers: null };
    const result = await run(state, makeStep({}));
    expect(result.status).toBe('waiting_form');
    const schema = state.taskStepRow.formSchema as FormSchema;
    expect(schema.fields).toEqual([]);
    expect(schema.submitLabel).toBe('Continue');
    expect(schema.title).toBe('cfg step');

    // Submitting the empty confirm advances to apply.
    const second = await run(state, makeStep({}), {});
    expect(second.status).toBe('done');
  });

  it('manual mode leaves steps with real forms unchanged', async () => {
    const state = freshState();
    state.taskRow = { id: 'task-1', autoContinue: false, preAnswers: null };
    const result = await run(state, makeStep({ form: () => QUESTION_FORM }));
    expect(result.status).toBe('waiting_form');
    const schema = state.taskStepRow.formSchema as FormSchema;
    expect(schema.fields).toHaveLength(2);
  });

  it('manual mode pauses zero-field info forms too', async () => {
    const state = freshState();
    state.taskRow = { id: 'task-1', autoContinue: false, preAnswers: null };
    const result = await run(state, makeStep({ form: () => ZERO_FIELD_FORM }));
    expect(result.status).toBe('waiting_form');
  });

  it('auto mode submits step field defaults when autoSubmitDefaults is set', async () => {
    const state = freshState();
    state.taskRow = { id: 'task-1', autoContinue: true, preAnswers: null };
    const result = await run(
      state,
      makeStep({ form: () => QUESTION_FORM, autoSubmitDefaults: true }),
    );
    expect(result.status).toBe('done');
    const values = state.taskStepRow.formValues as Record<string, unknown>;
    expect(values.action).toBe('update');
    expect(values.flag).toBe(true);
  });

  it('autoSubmitDefaults still stops when a required field has no default', async () => {
    const state = freshState();
    state.taskRow = { id: 'task-1', autoContinue: true, preAnswers: null };
    const requiredNoDefault: FormSchema = {
      title: 'Need input',
      fields: [{ type: 'text', id: 'name', label: 'Name', required: true }],
    };
    const result = await run(
      state,
      makeStep({ form: () => requiredNoDefault, autoSubmitDefaults: true }),
    );
    expect(result.status).toBe('waiting_form');
  });

  it('autoSubmitDefaults does not auto-submit when auto-continue is off', async () => {
    const state = freshState();
    state.taskRow = { id: 'task-1', autoContinue: false, preAnswers: null };
    const result = await run(
      state,
      makeStep({ form: () => QUESTION_FORM, autoSubmitDefaults: true }),
    );
    expect(result.status).toBe('waiting_form');
  });

  it('pauseFormOnRetry stops an autoSubmitDefaults step at its form and clears the flag', async () => {
    // A user clicked Retry on a step that would normally auto-submit its defaults.
    const state = freshState();
    state.taskStepRow.pauseFormOnRetry = true;
    state.taskRow = { id: 'task-1', autoContinue: true, preAnswers: null };
    const result = await run(
      state,
      makeStep({ form: () => QUESTION_FORM, autoSubmitDefaults: true }),
    );
    expect(result.status).toBe('waiting_form');
    expect(state.taskStepRow.status).toBe('waiting_form');
    // One-shot: cleared on park so a later automatic re-run auto-continues normally.
    expect(state.taskStepRow.pauseFormOnRetry).toBe(false);
  });

  it('pauseFormOnRetry stops zero-field info forms that would otherwise auto-pass', async () => {
    const state = freshState();
    state.taskStepRow.pauseFormOnRetry = true;
    state.taskRow = { id: 'task-1', autoContinue: true, preAnswers: null };
    const result = await run(state, makeStep({ form: () => ZERO_FIELD_FORM }));
    expect(result.status).toBe('waiting_form');
    expect(state.taskStepRow.pauseFormOnRetry).toBe(false);
  });

  it('pauseFormOnRetry stops a gate pre-answer from auto-submitting on retry', async () => {
    const state = freshState();
    state.taskStepRow.pauseFormOnRetry = true;
    state.taskRow = {
      id: 'task-1',
      autoContinue: true,
      preAnswers: { 'cfg-step': { action: 'skip' } },
    };
    const result = await run(state, makeStep({ form: () => QUESTION_FORM }));
    expect(result.status).toBe('waiting_form');
    // The pre-answer still overlays as an editable default the user can change.
    const schema = state.taskStepRow.formSchema as FormSchema;
    const radio = schema.fields.find((f) => f.id === 'action');
    expect(radio && 'default' in radio ? radio.default : undefined).toBe('skip');
  });

  it('pauseFormOnRetry stops a self-autoSubmit form even when auto-continue is off', async () => {
    const state = freshState();
    state.taskStepRow.pauseFormOnRetry = true;
    state.taskRow = { id: 'task-1', autoContinue: false, preAnswers: null };
    const selfSubmit: FormSchema = { ...QUESTION_FORM, autoSubmit: true };
    const result = await run(state, makeStep({ form: () => selfSubmit }));
    expect(result.status).toBe('waiting_form');
  });

  it('pauseFormOnRetry does not block the submit that follows the pause', async () => {
    // The guard lives only in the pre-submit branch, so submitting the parked form
    // (params.formValues present) runs straight to apply regardless of the flag.
    const state = freshState();
    state.taskStepRow.pauseFormOnRetry = true;
    state.taskRow = { id: 'task-1', autoContinue: true, preAnswers: null };
    const result = await run(state, makeStep({ form: () => QUESTION_FORM }), {
      action: 'update',
      flag: true,
    });
    expect(result.status).toBe('done');
  });
});
