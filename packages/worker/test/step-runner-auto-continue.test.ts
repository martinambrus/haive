import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '@haive/database';
import type { FormSchema } from '@haive/shared';
import { advanceStep } from '../src/step-engine/step-runner.js';
import { recordLedgerEntry } from '../src/step-engine/task-ledger.js';
import type { StepDefinition } from '../src/step-engine/step-definition.js';

vi.mock('../src/step-engine/task-ledger.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/step-engine/task-ledger.js')>();
  return { ...actual, recordLedgerEntry: vi.fn(async () => undefined) };
});

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

/** Values a drizzle condition binds, in order. */
function conditionValues(node: unknown, acc: unknown[] = []): unknown[] {
  if (!node || typeof node !== 'object') return acc;
  if (Array.isArray(node)) {
    for (const item of node) conditionValues(item, acc);
    return acc;
  }
  const obj = node as Record<string, unknown>;
  if ('value' in obj && 'encoder' in obj) acc.push(obj.value);
  const chunks = obj.queryChunks;
  if (Array.isArray(chunks)) for (const c of chunks) conditionValues(c, acc);
  return acc;
}

/** The row guards, evaluated against the mock row: a pass's write lands only while the row is not
 *  `pending` or `skipped`, and the claim that opens a pass only while it is still `pending`. */
function refusedByRowGuard(cond: unknown, status: unknown): boolean {
  const values = conditionValues(cond);
  if (values.includes('pending') && values.includes('skipped')) {
    return status === 'pending' || status === 'skipped';
  }
  return values.includes('pending') && status !== 'pending';
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
          where: (cond: unknown) => {
            const write = (): unknown[] => {
              if (tableName === 'task_steps' && refusedByRowGuard(cond, state.taskStepRow.status)) {
                return [];
              }
              state.updates.push({ table: tableName, patch: v });
              if (tableName === 'task_steps') {
                state.taskStepRow = { ...state.taskStepRow, ...v };
                return [state.taskStepRow];
              }
              return [];
            };
            return {
              returning: async () => write(),
              // Awaited directly by a write that needs no row back.
              then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
                Promise.resolve()
                  .then(() => {
                    write();
                  })
                  .then(res, rej),
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
    // Stamped by the write that parks, so no instant exists where the form is parked unstamped.
    expect(
      state.updates.find((u) => u.table === 'task_steps' && u.patch.status === 'waiting_form')
        ?.patch,
    ).toMatchObject({ waitingStartedAt: expect.any(Date) });
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

  it('pauseFormOnRetry parks the form instead of applying values a job carries', async () => {
    // A reopen held the form and the worker died before parking it; the submit that led there is
    // redelivered still carrying the answers typed into the old form.
    const state = freshState();
    state.taskRow = { id: 'task-1', autoContinue: true, preAnswers: null };
    state.taskStepRow = { ...state.taskStepRow, status: 'running', pauseFormOnRetry: true };
    const applied: unknown[] = [];
    const def = makeStep({ form: () => QUESTION_FORM });
    def.apply = async (_ctx, args) => {
      applied.push(args.formValues);
      return { applied: true };
    };
    const result = await run(state, def, { action: 'skip', flag: false });

    expect(result.status).toBe('waiting_form');
    expect(applied).toEqual([]);
    expect(state.taskStepRow.formValues).toBeNull();
    expect(state.taskStepRow.pauseFormOnRetry).toBe(false);
  });

  it('pauseFormOnRetry does not block the submit that follows the pause', async () => {
    // The pause parks the form and releases the hold, so the submit that answers it runs.
    const state = freshState();
    state.taskStepRow.pauseFormOnRetry = true;
    state.taskRow = { id: 'task-1', autoContinue: true, preAnswers: null };
    const step = makeStep({ form: () => QUESTION_FORM });
    expect((await run(state, step)).status).toBe('waiting_form');
    const result = await run(state, step, { action: 'update', flag: true });
    expect(result.status).toBe('done');
  });
});

/** What a continuation finds: the step parked on its CLI, its form built and its answers saved. */
function parkedWithAnswers(): MockState {
  const state = freshState();
  state.taskRow = { id: 'task-1', autoContinue: true, preAnswers: null };
  state.taskStepRow = {
    ...state.taskStepRow,
    status: 'waiting_cli',
    detectOutput: { ok: true },
    formSchema: QUESTION_FORM,
    formValues: { action: 'update', flag: true },
    startedAt: new Date(),
  };
  return state;
}

describe('advanceStep continuing a parked step with saved answers', () => {
  const applied: unknown[] = [];
  const step = (): StepDefinition => {
    const def = makeStep({ form: () => QUESTION_FORM });
    def.apply = async (_ctx, args) => {
      applied.push(args.formValues);
      return { applied: true };
    };
    return def;
  };

  it('keeps the step parked and its answers as saved, rather than re-submitting them', async () => {
    applied.length = 0;
    const state = parkedWithAnswers();
    // What the task queue passes a continuation: the answers already on the row.
    const result = await run(state, step(), { action: 'update', flag: true });

    expect(result.status).toBe('done');
    expect(state.updates.filter((u) => u.patch.status === 'running')).toEqual([]);
    expect(state.updates.filter((u) => 'formValues' in u.patch)).toEqual([]);
    expect(applied).toEqual([{ action: 'update', flag: true }]);
  });

  it('ignores the values a submit redelivered onto the parked step carries', async () => {
    applied.length = 0;
    const state = parkedWithAnswers();
    await run(state, step(), { action: 'skip', flag: false });

    expect(applied).toEqual([{ action: 'update', flag: true }]);
    expect(state.updates.filter((u) => 'formValues' in u.patch)).toEqual([]);
  });

  it('still saves a submission and runs the step on it', async () => {
    applied.length = 0;
    const state = parkedWithAnswers();
    state.taskStepRow = { ...state.taskStepRow, status: 'waiting_form', formValues: null };
    const result = await run(state, step(), { action: 'skip', flag: false });

    expect(result.status).toBe('done');
    const saved = state.updates.find((u) => 'formValues' in u.patch);
    expect(saved?.patch).toMatchObject({
      status: 'running',
      formValues: { action: 'skip', flag: false },
    });
    expect(applied).toEqual([{ action: 'skip', flag: false }]);
  });

  it('still fails a submission that does not validate', async () => {
    const state = parkedWithAnswers();
    state.taskStepRow = { ...state.taskStepRow, status: 'waiting_form', formValues: null };
    const result = await run(state, step(), { action: 'not-an-option' });

    expect(result.status).toBe('failed');
  });
});

describe('advanceStep outcome after a Retry or Skip took the row over', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const doneWrites = (state: MockState) =>
    state.updates.filter((u) => u.table === 'task_steps' && u.patch.status === 'done');

  it('writes no outcome over a row a Retry reset while apply ran', async () => {
    const state = freshState();
    state.taskRow = { id: 'task-1', autoContinue: true, preAnswers: null };
    const def = makeStep({ form: () => ZERO_FIELD_FORM });
    def.apply = async () => {
      // The api's Retry resets the row to pending while this pass is still applying.
      state.taskStepRow.status = 'pending';
      return { applied: true };
    };

    const result = await run(state, def);

    expect(result.status).toBe('superseded');
    expect(state.taskStepRow.status).toBe('pending');
    expect(doneWrites(state)).toEqual([]);
  });

  it('stops at its next write, whatever it is, once a Retry reset the row', async () => {
    const state = freshState();
    state.taskRow = { id: 'task-1', autoContinue: true, preAnswers: null };
    const applied: unknown[] = [];
    const def = makeStep({ form: () => ZERO_FIELD_FORM });
    def.detect = async () => {
      state.taskStepRow.status = 'pending';
      return { ok: true };
    };
    def.apply = async () => {
      applied.push(1);
      return { applied: true };
    };

    expect((await run(state, def)).status).toBe('superseded');
    expect(applied).toEqual([]);
    expect(state.taskStepRow.status).toBe('pending');
    // The pass's own write that opened it is the last one that landed.
    expect(state.updates.map((u) => u.patch.status).filter(Boolean)).toEqual(['running']);
  });

  it('writes no failure over a row a Skip took while apply failed', async () => {
    const state = freshState();
    state.taskRow = { id: 'task-1', autoContinue: true, preAnswers: null };
    const def = makeStep({ form: () => ZERO_FIELD_FORM });
    def.apply = async () => {
      state.taskStepRow.status = 'skipped';
      throw new Error('apply lost its workspace');
    };

    const result = await run(state, def);

    expect(result.status).toBe('superseded');
    expect(state.taskStepRow.status).toBe('skipped');
    expect(state.updates.filter((u) => u.patch.status === 'failed')).toEqual([]);
  });

  /** An agent step whose own phase has nothing to do here, so apply's recap is what is tested. */
  const recappingStep = (apply: () => Promise<unknown>) => {
    const def = makeStep({ form: () => ZERO_FIELD_FORM });
    def.llm = { skipIf: () => true } as never;
    def.apply = apply as never;
    return def;
  };

  it('leaves no recap behind for a pass a Retry replaced', async () => {
    vi.mocked(recordLedgerEntry).mockClear();
    const state = freshState();
    state.taskRow = { id: 'task-1', autoContinue: true, preAnswers: null };
    const def = recappingStep(async () => {
      state.taskStepRow.status = 'pending';
      return { summary: 'what the replaced pass did' };
    });

    expect((await run(state, def)).status).toBe('superseded');
    expect(vi.mocked(recordLedgerEntry)).not.toHaveBeenCalled();
  });

  it('records the recap once the outcome has landed', async () => {
    vi.mocked(recordLedgerEntry).mockClear();
    const state = freshState();
    state.taskRow = { id: 'task-1', autoContinue: true, preAnswers: null };
    const def = recappingStep(async () => ({ summary: 'what the pass did' }));

    expect((await run(state, def)).status).toBe('done');
    expect(vi.mocked(recordLedgerEntry)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(recordLedgerEntry).mock.calls[0]![3]).toMatchObject({
      text: 'what the pass did',
      kind: 'summary',
    });
  });

  it('stops a pass whose task a Retry moved to a newer epoch, writing nothing', async () => {
    vi.useFakeTimers();
    const state = freshState();
    state.taskRow = {
      id: 'task-1',
      autoContinue: true,
      preAnswers: null,
      status: 'running',
      orchestrationEpoch: 5,
    };
    const def = makeStep({ form: () => ZERO_FIELD_FORM });
    def.apply = async (ctx) => {
      state.taskRow!.orchestrationEpoch = 6;
      // A long deterministic apply that checks for cancellation, as RAG sync does.
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      ctx.throwIfCancelled();
      return { applied: true };
    };

    const pass = advanceStep({
      db: makeMockDb(state),
      taskId: 'task-1',
      userId: 'user-1',
      repoPath: '/tmp',
      workspacePath: '/tmp',
      cliProviderId: null,
      stepDef: def,
      epoch: 5,
    });
    await vi.advanceTimersByTimeAsync(3_000);
    const result = await pass;

    expect(result.status).toBe('superseded');
    expect(state.taskStepRow.status).toBe('running');
    expect(state.updates.filter((u) => u.patch.status === 'failed')).toEqual([]);
    expect(doneWrites(state)).toEqual([]);
  });

  /** A step whose shouldRun is where a Retry or a Skip lands, and whose detect says it ran. */
  const guardedStep = (onShouldRun: () => void, should = true) => {
    const def = makeStep({ form: () => ZERO_FIELD_FORM });
    const detected: unknown[] = [];
    def.shouldRun = async () => {
      onShouldRun();
      return should;
    };
    def.detect = async () => {
      detected.push(1);
      return { ok: true };
    };
    return { def, detected };
  };

  const runAtEpoch = (state: MockState, stepDef: StepDefinition, epoch: number) =>
    advanceStep({
      db: makeMockDb(state),
      taskId: 'task-1',
      userId: 'user-1',
      repoPath: '/tmp',
      workspacePath: '/tmp',
      cliProviderId: null,
      stepDef,
      epoch,
    });

  const atEpoch = (epoch: number) => ({
    id: 'task-1',
    autoContinue: true,
    preAnswers: null,
    status: 'running',
    orchestrationEpoch: epoch,
  });

  it('gives the row back when a Retry landed while shouldRun ran', async () => {
    const state = freshState();
    state.taskRow = atEpoch(5);
    // The Retry's reset leaves the row `pending`, so only the epoch says it happened.
    const { def, detected } = guardedStep(() => {
      state.taskRow!.orchestrationEpoch = 6;
    });

    expect((await runAtEpoch(state, def, 5)).status).toBe('superseded');
    expect(detected).toEqual([]);
    expect(state.taskStepRow.status).toBe('pending');
    expect(state.taskStepRow.startedAt).toBeNull();
  });

  it('gives back the skip shouldRun chose when a Retry landed meanwhile', async () => {
    const state = freshState();
    state.taskRow = atEpoch(5);
    const { def } = guardedStep(() => {
      state.taskRow!.orchestrationEpoch = 6;
    }, false);

    expect((await runAtEpoch(state, def, 5)).status).toBe('superseded');
    expect(state.taskStepRow.status).toBe('pending');
    expect(state.taskStepRow.endedAt).toBeNull();
  });

  it('leaves a Skip that landed while shouldRun ran in place', async () => {
    const state = freshState();
    state.taskRow = atEpoch(5);
    const { def, detected } = guardedStep(() => {
      state.taskStepRow = { ...state.taskStepRow, status: 'skipped' };
    });

    expect((await runAtEpoch(state, def, 5)).status).toBe('superseded');
    expect(detected).toEqual([]);
    expect(state.taskStepRow.status).toBe('skipped');
    expect(state.updates.filter((u) => u.patch.status === 'running')).toEqual([]);
  });

  it('claims the row as before when nothing landed during shouldRun', async () => {
    const state = freshState();
    state.taskRow = atEpoch(5);
    const { def, detected } = guardedStep(() => {});

    expect((await runAtEpoch(state, def, 5)).status).toBe('done');
    expect(detected).toHaveLength(1);
    expect(state.taskStepRow.status).toBe('done');
  });

  it('lets a pass at the task epoch finish as before', async () => {
    vi.useFakeTimers();
    const state = freshState();
    state.taskRow = {
      id: 'task-1',
      autoContinue: true,
      preAnswers: null,
      status: 'running',
      orchestrationEpoch: 6,
    };
    const def = makeStep({ form: () => ZERO_FIELD_FORM });
    def.apply = async (ctx) => {
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      ctx.throwIfCancelled();
      return { applied: true };
    };

    const pass = advanceStep({
      db: makeMockDb(state),
      taskId: 'task-1',
      userId: 'user-1',
      repoPath: '/tmp',
      workspacePath: '/tmp',
      cliProviderId: null,
      stepDef: def,
      epoch: 6,
    });
    await vi.advanceTimersByTimeAsync(3_000);

    expect((await pass).status).toBe('done');
    expect(doneWrites(state)).toHaveLength(1);
  });
});
