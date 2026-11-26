import { rolePin, REVIEW, PRODUCER } from './replacement-fixtures.js';
import { CODE_REVIEW_OUTPUT_CONTRACT } from '@haive/shared/step-outputs';
import { CODE_AUDIT_OUTPUT_CONTRACT } from '@haive/shared/step-outputs';
import { validateSuccessfulStepOutput } from '../src/step-engine/step-output-contract.js';
vi.mock('../src/step-engine/step-output-contract.js', async (original) => {
  const actual = await original<typeof import('../src/step-engine/step-output-contract.js')>();
  return { ...actual, validateSuccessfulStepOutput: vi.fn(actual.validateSuccessfulStepOutput) };
});
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '@haive/database';
import { configService, FIX_LOOP_ACTION_FIELD, type FormSchema } from '@haive/shared';
import { restoreDatabaseStep } from '../src/step-engine/steps/workflow/01c1-restore-database.js';
import { insightsTriageStep } from '../src/step-engine/steps/workflow/08e-insights-triage.js';
import { runConfigStep } from '../src/step-engine/steps/workflow/06-run-config.js';
import { staleSubmitAction } from '../src/queues/_advance-guards.js';
import * as activation from '../src/modules/activation.js';
import * as dispatcher from '../src/orchestrator/dispatcher.js';
import { advanceStep } from '../src/step-engine/step-runner.js';
import { recordLedgerEntry } from '../src/step-engine/task-ledger.js';
import { ReopenStepFormError, type StepDefinition } from '../src/step-engine/step-definition.js';
import { preRagSourceSelectionStep } from '../src/step-engine/steps/workflow/01g-rag-source-selection.js';
import { workflowRagSourceSelectionStep } from '../src/step-engine/steps/workflow/11b1-rag-source-selection.js';
import { ragSourceSelectionStep } from '../src/step-engine/steps/onboarding/09_7-rag-source-selection.js';

vi.mock('../src/step-engine/task-ledger.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/step-engine/task-ledger.js')>();
  return { ...actual, recordLedgerEntry: vi.fn(async () => undefined) };
});

interface MockState {
  taskStepRow: Record<string, unknown>;
  taskRow: Record<string, unknown> | null;
  updates: { table: string; patch: Record<string, unknown> }[];
  invocation?: Record<string, unknown>;
  invocations?: Record<string, unknown>[];
  beforeWrite?: (table: string, patch: Record<string, unknown>) => void;
  gate?: GateWorld;
  continuationEvent?: { payload: { version: number; rerunGeneration: number } };
}

/** What the insight-gate predicates read: events and the task's other step rows. */
interface GateWorld {
  /** `insight.continuation` events, newest first. */
  continuations: { id: string; payload: Record<string, unknown> }[];
  /** `insight.check` events, oldest first. */
  checks: { payload: Record<string, unknown> }[];
  /** Step rows other than the one being advanced. */
  rows: Record<string, unknown>[];
  /** The newest `step.form_submitted` event after the anchor, as the anchor query would return it. */
  submission?: { payload: Record<string, unknown> };
  /** A prior completed task's saved answers for the step. */
  prior?: Record<string, unknown>;
}

/** Every number a condition binds, a raw `sql` template value included (it sits in the chunks bare). */
function conditionNumbers(node: unknown, acc: number[] = []): number[] {
  if (typeof node === 'number') acc.push(node);
  else if (Array.isArray(node)) for (const item of node) conditionNumbers(item, acc);
  else if (node && typeof node === 'object') {
    const obj = node as Record<string, unknown>;
    if ('value' in obj && 'encoder' in obj) conditionNumbers(obj.value, acc);
    conditionNumbers(obj.queryChunks, acc);
  }
  return acc;
}

/** The gate predicates' step-row reads, evaluated against the rows of the world by the values their
 *  conditions bind: a QA lookup by round range, a settled gate-3 lookup by round range, a source
 *  row lookup by id. */
function gateRowLookup(world: GateWorld, cond: unknown): Record<string, unknown> | undefined {
  const values = conditionValues(cond);
  const numbers = conditionNumbers(cond);
  const settled = (r: Record<string, unknown>) => r.status === 'done' || r.status === 'skipped';
  if (values.includes('08d2-adversarial-qa-review'))
    return world.rows
      .filter(
        (r) =>
          r.stepId === '08d2-adversarial-qa-review' &&
          settled(r) &&
          (r.round as number) >= numbers[0]! &&
          (r.round as number) <= numbers[1]!,
      )
      .sort((a, b) => (b.round as number) - (a.round as number))[0];
  if (values.includes('10-gate-3-commit') && values.includes('step.form_submitted'))
    return world.rows.find(
      (r) =>
        r.stepId === '10-gate-3-commit' &&
        settled(r) &&
        r.ownerAnswered === true &&
        (r.round as number) >= numbers[0]! &&
        (r.round as number) < numbers[1]!,
    );
  if (values.includes('10-gate-3-commit'))
    return world.rows.find(
      (r) =>
        r.stepId === '10-gate-3-commit' &&
        settled(r) &&
        (r.round as number) >= numbers[0]! &&
        (r.round as number) < numbers[1]!,
    );
  return world.rows.find((r) => values.includes(r.id));
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
  // A value interpolated into a raw `sql` template sits in the chunks bare.
  if (typeof node === 'string') acc.push(node);
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

/** The claim's task fence, evaluated against the mock task row: its epoch and a status outside the
 *  refused set. */
function taskFenceHolds(cond: unknown, task: Record<string, unknown> | null): boolean {
  if (!task) return false;
  const values = conditionValues(cond);
  const epoch = values.find((v) => typeof v === 'number');
  const refused = values.filter((v) => typeof v === 'string' && v !== task.id);
  return (
    (epoch === undefined || epoch === task.orchestrationEpoch) && !refused.includes(task.status)
  );
}

function persistedRow(state: MockState) {
  return { ...state.taskStepRow, detectOutput: structuredClone(state.taskStepRow.detectOutput) };
}

function makeMockDb(state: MockState): Database {
  let nextId = 1;
  const db = {
    // Rolls the mock back on a throw, as Postgres rolls the claim's flip back.
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      const row = { ...state.taskStepRow };
      const writes = state.updates.length;
      const task = state.taskRow && { ...state.taskRow };
      const event = state.continuationEvent;
      const invocation = state.invocation && { ...state.invocation };
      try {
        return await fn(db);
      } catch (err) {
        state.taskStepRow = row;
        state.taskRow = task;
        state.continuationEvent = event;
        if (invocation && state.invocation) Object.assign(state.invocation, invocation);
        state.updates.length = writes;
        throw err;
      }
    },
    select: () => ({
      from: (table: unknown) => {
        const tableName = tableNameOf(table);
        return {
          innerJoin: () => ({
            where: () => ({
              orderBy: () => ({
                limit: async () => (state.gate?.prior ? [{ formValues: state.gate.prior }] : []),
              }),
            }),
          }),
          where: (cond: unknown) => ({
            then: (resolve: (rows: unknown[]) => unknown) => Promise.resolve([]).then(resolve),
            limit: async () => {
              if (tableName === 'tasks') return state.taskRow ? [state.taskRow] : [];
              if (tableName === 'task_steps') {
                return state.taskStepRow.id ? [persistedRow(state)] : [];
              }
              return tableName === 'cli_invocations' &&
                state.invocation &&
                state.invocation.endedAt === null &&
                !state.invocation.supersededAt
                ? [state.invocation]
                : [];
            },
            orderBy: () => ({
              then: (resolve: (value: unknown[]) => unknown) =>
                Promise.resolve(tableName === 'task_events' ? (state.gate?.checks ?? []) : []).then(
                  resolve,
                ),
              limit: async () =>
                tableName === 'cli_invocations' &&
                state.invocation &&
                !state.invocation.consumedAt &&
                !state.invocation.supersededAt
                  ? [state.invocation]
                  : [],
            }),
            for: async () => {
              if (tableName === 'task_steps') {
                return refusedByRowGuard(cond, state.taskStepRow.status) ||
                  state.taskStepRow.status === 'failed'
                  ? []
                  : [persistedRow(state)];
              }
              if (tableName === 'cli_invocations')
                return state.invocation ? [state.invocation] : [];
              return tableName === 'tasks' && taskFenceHolds(cond, state.taskRow)
                ? [{ id: state.taskRow!.id }]
                : [];
            },
          }),
        };
      },
    }),
    insert: (table: unknown) => {
      const tableName = tableNameOf(table);
      return {
        values: (v: Record<string, unknown>) => ({
          then: (resolve: (value: unknown) => unknown) => {
            if (tableName === 'task_events' && v.eventType === 'step.pre_form_continuation')
              state.continuationEvent = {
                payload: v.payload as { version: number; rerunGeneration: number },
              };
            return Promise.resolve().then(resolve);
          },
          returning: async () => {
            const row = {
              id: `mock-${state.invocations ? state.invocations.length + 1 : nextId++}`,
              createdAt: new Date(),
              ...v,
            };
            if (tableName === 'cli_invocations' && state.invocations) {
              state.invocation = { ...row, endedAt: null };
              state.invocations.push(state.invocation);
            }
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
              state.beforeWrite?.(tableName, v);
              if (
                tableName === 'task_steps' &&
                (refusedByRowGuard(cond, state.taskStepRow.status) ||
                  state.taskStepRow.status === 'failed')
              ) {
                return [];
              }
              if (
                tableName === 'cli_invocations' &&
                state.invocation &&
                !conditionValues(cond).includes(state.invocation.id)
              )
                return [];
              if (tableName === 'tasks' && state.taskRow) {
                Object.assign(state.taskRow, v);
                state.updates.push({ table: tableName, patch: v });
                return [state.taskRow];
              }
              state.updates.push({ table: tableName, patch: v });
              if (tableName === 'cli_invocations' && state.invocation) {
                Object.assign(state.invocation, v);
                return [state.invocation];
              }
              if (tableName === 'task_steps') {
                state.taskStepRow = {
                  ...state.taskStepRow,
                  ...v,
                  ...('detectOutput' in v ? { detectOutput: structuredClone(v.detectOutput) } : {}),
                };
                return [persistedRow(state)];
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
      userStepCliRolePreferences: { findFirst: async () => undefined },
      taskAttachments: { findMany: async () => [] },
      taskStepCliChoices: { findFirst: async () => undefined },
      tasks: {
        findFirst: async () => state.taskRow ?? undefined,
      },
      taskSteps: {
        findFirst: async ({ where }: { where: unknown }) =>
          state.gate ? gateRowLookup(state.gate, where) : undefined,
      },
      taskEvents: {
        findMany: async () => state.gate?.continuations ?? [],
        findFirst: async ({ where }: { where: unknown }) => {
          const values = conditionValues(where);
          if (values.includes('step.pre_form_continuation')) return state.continuationEvent;
          if (values.includes('step.form_submitted')) return state.gate?.submission;
          return state.gate?.checks.at(-1);
        },
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

function run(
  state: MockState,
  stepDef: StepDefinition,
  formValues?: Record<string, unknown>,
  dispatch: Pick<Parameters<typeof advanceStep>[0], 'providers' | 'deps' | 'epoch'> = {},
) {
  return advanceStep({
    db: makeMockDb(state),
    taskId: 'task-1',
    userId: 'user-1',
    repoPath: '/tmp',
    workspacePath: '/tmp',
    cliProviderId: null,
    stepDef,
    ...(formValues ? { formValues } : {}),
    ...dispatch,
  });
}

const ZERO_FIELD_FORM: FormSchema = { title: 'Info only', fields: [], submitLabel: 'OK' };

describe('pre-form report completion', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('hands the accumulated report to the form instead of only the last invocation output', async () => {
    vi.stubEnv('HAIVE_TEST_BYPASS_LLM', '1');
    const state = freshState();
    state.taskRow = { id: 'task-1', autoContinue: true, preAnswers: null };
    const form = vi.fn((_ctx, _detected, output) => ({
      title: 'Findings',
      fields: [
        { type: 'note' as const, id: 'report', label: 'Report', body: JSON.stringify(output) },
      ],
    }));
    const def = makeStep({});
    def.form = form;
    def.llm = {
      preForm: true,
      requiredCapabilities: [],
      buildPrompt: () => '',
      bypassStub: () => ({ last: true }),
      completePreForm: async () => ({
        llmOutput: { initial: true, last: true },
        continueRequested: false,
      }),
    };
    expect((await run(state, def)).status).toBe('waiting_form');
    expect(form.mock.calls[0]![2]).toEqual({ initial: true, last: true });
  });

  it.each([null, { acknowledged: true }])(
    'consumes the completed invocation and clears any previous answers (%j) while follow-up work is owed',
    async (formValues) => {
      const state = freshState();
      state.taskStepRow.formValues = formValues;
      state.taskRow = { id: 'task-1', autoContinue: true, preAnswers: null };
      state.invocation = {
        id: 'inv-1',
        endedAt: new Date(),
        exitCode: 0,
        rawOutput: '{"findings":[]}',
        parsedOutput: null,
        errorMessage: null,
      };
      const form = vi.fn(() => ZERO_FIELD_FORM);
      const def = makeStep({ form });
      def.llm = {
        preForm: true,
        requiredCapabilities: [],
        buildPrompt: () => '',
        completePreForm: async ({ llmInvocationId }) => {
          expect(llmInvocationId).toBe('inv-1');
          return { llmOutput: { findings: [] }, continueRequested: true };
        },
      };
      // No worker dependencies are supplied: a fresh dispatch must fail instead of
      // replaying the just-consumed result and showing a premature results form.
      expect((await run(state, def)).status).toBe('failed');
      expect(state.invocation.consumedAt).toBeInstanceOf(Date);
      expect(form).not.toHaveBeenCalled();
      expect(state.taskStepRow.formSchema).toBeNull();
      expect(state.taskStepRow.formValues).toBeNull();
    },
  );

  it('does not consume a newer live invocation when the completed report is replayed', async () => {
    const state = freshState();
    state.taskRow = { id: 'task-1', autoContinue: true, preAnswers: null };
    state.invocation = {
      id: 'inv-completed',
      endedAt: new Date(),
      exitCode: 0,
      rawOutput: '{"findings":[]}',
      parsedOutput: null,
      errorMessage: null,
    };
    const followup = {
      id: 'inv-followup',
      startedAt: new Date(),
      endedAt: null,
      exitCode: null,
      consumedAt: null,
      rawOutput: null,
      parsedOutput: null,
      errorMessage: null,
    };
    const form = vi.fn(() => ZERO_FIELD_FORM);
    const def = makeStep({ form });
    def.llm = {
      preForm: true,
      requiredCapabilities: [],
      buildPrompt: () => '',
      completePreForm: async ({ llmInvocationId }) => {
        expect(llmInvocationId).toBe('inv-completed');
        state.invocation = followup;
        return { llmOutput: { findings: [] }, continueRequested: true };
      },
    };
    expect((await run(state, def)).status).toBe('waiting_cli');
    expect(followup.consumedAt).toBeNull();
    expect(form).not.toHaveBeenCalled();
  });
});

describe('pre-form continuation dispatch and recovery', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubEnv('HAIVE_TEST_BYPASS_LLM', '0');
    vi.spyOn(configService, 'getBoolean').mockResolvedValue(false);
    vi.spyOn(configService, 'get').mockResolvedValue(null);
    vi.spyOn(dispatcher, 'resolveTaskDispatch').mockResolvedValue({
      mode: 'cli',
      providerId: 'provider',
      invocation: { kind: 'cli', spec: {} },
    } as unknown as Awaited<ReturnType<typeof dispatcher.resolveTaskDispatch>>);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  // The journal models the consumer's independent durable store; each advance
  // rebuilds its DB/context and reads serialized detection, never a closure cursor.
  function sequence(limit = 52) {
    const state = freshState();
    state.taskRow = {
      id: 'task-1',
      status: 'running',
      orchestrationEpoch: 0,
      autoContinue: false,
      summaryLlmEnabled: false,
    };
    state.invocations = [];
    const accepted = new Map<string, number>();
    state.beforeWrite = (table, patch) => {
      if (table === 'cli_invocations' && patch.consumedAt)
        expect(accepted.has(state.invocation!.id as string)).toBe(true);
    };
    const form = vi.fn(() => ZERO_FIELD_FORM);
    const def = makeStep({ form });
    def.detect = vi.fn(async () => ({ pass: 0 }));
    def.llm = {
      preForm: true,
      requiredCapabilities: [],
      buildPrompt: ({ detected }) => JSON.stringify(detected),
      prepare: async ({ detected }) => {
        (detected as { pass: number }).pass = accepted.size;
      },
      completePreForm: async ({ detected, llmInvocationId, llmOutput }) => {
        expect(llmInvocationId).toBe(state.invocation!.id);
        expect(state.invocation!.consumedAt).toBeUndefined();
        const pass = (detected as { pass: number }).pass;
        expect(JSON.parse(llmOutput as string)).toEqual({ pass });
        if (!accepted.has(llmInvocationId!)) {
          expect(pass).toBe(accepted.size);
          accepted.set(llmInvocationId!, pass);
        }
        return { llmOutput: { accepted: accepted.size }, continueRequested: accepted.size < limit };
      },
    };
    const enqueue = vi.fn(async () => {
      expect(state.taskStepRow.detectOutput).toEqual({ pass: accepted.size });
      expect(
        state
          .invocations!.slice(0, -1)
          .every((r) => accepted.has(r.id as string) && (r.consumedAt || r.supersededAt)),
      ).toBe(true);
    });
    const advance = () =>
      run(state, def, undefined, {
        providers: [],
        deps: { enqueueCliInvocation: enqueue },
        epoch: state.taskRow!.orchestrationEpoch as number,
      });
    const finish = () =>
      Object.assign(state.invocation!, {
        endedAt: new Date(),
        exitCode: 0,
        rawOutput: JSON.stringify(state.taskStepRow.detectOutput),
      });
    return { state, accepted, def, form, enqueue, advance, finish };
  }

  it('completes 52 distinct passes, records acceptance before consume and never dispatches twice on a duplicate advance', async () => {
    const h = sequence();
    expect((await h.advance()).status).toBe('waiting_cli');
    for (let pass = 0; pass < 52; pass++) {
      expect((await h.advance()).status).toBe('waiting_cli');
      expect(h.enqueue).toHaveBeenCalledTimes(pass + 1);
      expect(h.form).not.toHaveBeenCalled();
      h.finish();
      expect((await h.advance()).status).toBe(pass === 51 ? 'waiting_form' : 'waiting_cli');
    }
    expect(h.accepted.size).toBe(52);
    expect(new Set(h.state.invocations!.map((r) => r.id)).size).toBe(52);
    expect(h.def.detect).toHaveBeenCalledOnce();
    expect(h.state.taskStepRow.iterations).toBeNull();
    expect(h.form).toHaveBeenCalledOnce();
    h.state.taskStepRow.formValues = {};
    expect((await h.advance()).status).toBe('done');
    expect(h.enqueue).toHaveBeenCalledTimes(52);
    expect(h.state.taskStepRow.output).toMatchObject({ applied: true });
  });

  it.each(['result', 'accepted', 'consumed'] as const)(
    'restarts after %s without losing or charging a pass twice',
    async (point) => {
      const h = sequence(3);
      await h.advance();
      h.finish();
      if (point !== 'result') {
        let snapshot: ReturnType<typeof structuredClone>;
        const beforeWrite = h.state.beforeWrite;
        h.state.beforeWrite = (table, patch) => {
          beforeWrite?.(table, patch);
          const consume = table === 'cli_invocations' && patch.consumedAt;
          const nextPrepare = table === 'task_steps' && patch.detectOutput;
          if ((point === 'accepted' && consume) || (point === 'consumed' && nextPrepare)) {
            snapshot = {
              row: persistedRow(h.state),
              invocation: { ...h.state.invocation },
            };
            throw new Error('simulated process death');
          }
        };
        await h.advance(); // Discard the dying process's catch writes at the crash cut.
        const saved = snapshot as {
          row: Record<string, unknown>;
          invocation: Record<string, unknown>;
        };
        expect(saved).toBeDefined();
        h.state.taskStepRow = saved.row;
        h.state.invocation = saved.invocation;
        h.state.invocations![0] = saved.invocation;
        delete h.state.beforeWrite;
      }
      h.state.taskStepRow.detectOutput = structuredClone(h.state.taskStepRow.detectOutput);
      expect((await h.advance()).status).toBe('waiting_cli');
      expect(h.enqueue).toHaveBeenCalledTimes(2);
      expect(h.accepted.size).toBe(1);
      expect(h.state.taskStepRow.detectOutput).toEqual({ pass: 1 });
      h.finish();
      expect((await h.advance()).status).toBe('waiting_cli');
      h.finish();
      expect((await h.advance()).status).toBe('waiting_form');
      expect([...h.accepted.values()]).toEqual([0, 1, 2]);
      expect(h.enqueue).toHaveBeenCalledTimes(3);
    },
  );

  it.each(['Stop', 'Retry', 'Cancel'] as const)(
    '%s overtakes completion before the next dispatch',
    async (action) => {
      const h = sequence(3);
      await h.advance();
      h.finish();
      const complete = h.def.llm!.completePreForm!;
      h.def.llm!.completePreForm = async (args) => {
        const result = await complete(args);
        if (action === 'Cancel') h.state.taskRow!.status = 'cancelled';
        else if (action === 'Stop') {
          h.state.taskRow!.status = 'failed';
          h.state.taskStepRow.status = 'failed';
        } else {
          h.state.taskRow!.orchestrationEpoch = 1;
          h.state.taskStepRow.status = 'pending';
          h.state.taskStepRow.detectOutput = null;
        }
        await vi.advanceTimersByTimeAsync(2000);
        return result;
      };
      expect((await h.advance()).status).toBe(action === 'Cancel' ? 'failed' : 'superseded');
      expect(h.enqueue).toHaveBeenCalledOnce();
      expect(h.state.invocation!.consumedAt).toBeUndefined();
      if (action === 'Retry') {
        h.def.llm!.completePreForm = complete;
        h.state.invocation!.supersededAt = new Date();
        expect((await h.advance()).status).toBe('waiting_cli');
        expect(h.state.taskStepRow.detectOutput).toEqual({ pass: 1 });
        expect(h.enqueue).toHaveBeenCalledTimes(2);
        expect(h.accepted.size).toBe(1);
      }
    },
  );

  it('fails cleanly when the consumer throws at its injected ceiling', async () => {
    const h = sequence(3);
    await h.advance();
    h.finish();
    const complete = h.def.llm!.completePreForm!;
    h.def.llm!.completePreForm = async (args) => {
      const result = await complete(args);
      if (h.accepted.size >= 1) throw new Error('Consumer pass ceiling reached');
      return result;
    };
    expect((await h.advance()).status).toBe('failed');
    expect(h.state.taskStepRow.errorMessage).toBe('Consumer pass ceiling reached');
    expect(h.enqueue).toHaveBeenCalledOnce();
    expect(h.form).not.toHaveBeenCalled();
  });
});

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
  for (const picker of [
    preRagSourceSelectionStep,
    workflowRagSourceSelectionStep,
    ragSourceSelectionStep,
  ]) {
    it(`${picker.metadata.id}: auto mode parks for the current RAG scope despite saved defaults`, async () => {
      const state = freshState();
      state.taskRow = { id: 'task-1', autoContinue: true, preAnswers: null };
      const apply = vi.fn(async () => ({}));
      const result = await run(state, {
        ...picker,
        shouldRun: async () => true,
        detect: async () => ({
          framework: null,
          tree: [
            { path: 'src', label: 'src', fileCount: 3 },
            { path: 'vendor', label: 'vendor', fileCount: 1000 },
          ],
          defaultExcludeGlobs: ['vendor'],
          extensionSet: ['.ts'],
          totalCodeFiles: 1003,
        }),
        apply,
      });
      expect(result.status).toBe('waiting_form');
      expect(apply).not.toHaveBeenCalled();
      expect((state.taskStepRow.formSchema as FormSchema).fields[0]).toMatchObject({
        type: 'directory-tree',
        defaults: ['src'],
      });
    });
  }

  it('database restoration waits for the user in automatic mode even with a restore pre-answer', async () => {
    const state = freshState();
    state.taskRow = {
      id: 'task-1',
      autoContinue: true,
      preAnswers: { '01c1-restore-database': { action: 'restore:snapshot-A' } },
    };
    const apply = vi.fn(async () => ({ imported: false }));
    const step = {
      ...restoreDatabaseStep,
      shouldRun: async () => true,
      detect: async () => ({
        repoSubpath: 'project',
        workspace: null,
        dbUploadId: null,
        dumpWorkerPath: null,
        dumpRunnerPath: null,
        databaseSnapshotId: 'snapshot-A',
        snapshotEngine: 'postgres',
        checkpoint: {
          id: 'snapshot-A',
          sourceTaskId: 'task-A',
          sourceTaskTitle: 'Installed Drupal',
          createdAt: '2026-10-05T08:30:00Z',
          engine: 'postgres',
          engineVersion: '17',
        },
      }),
      apply,
    };
    expect((await run(state, step)).status).toBe('waiting_form');
    expect(apply).not.toHaveBeenCalled();
    expect((state.taskStepRow.formSchema as FormSchema).title).toBe('Restore project database');
    expect((await run(state, step, { action: 'skip' })).status).toBe('done');
    expect(apply).toHaveBeenCalledOnce();
  });

  it('always-wait steps require an explicit submission despite auto mode, pre-answers and defaults', async () => {
    const state = freshState();
    state.taskRow = {
      id: 'task-1',
      autoContinue: true,
      preAnswers: { 'cfg-step': { action: 'update' } },
    };
    const step = makeStep({
      form: () => ({ ...QUESTION_FORM, autoSubmit: true }),
      autoSubmitDefaults: true,
    });
    step.metadata.alwaysWaitForUser = true;
    const apply = vi.fn(step.apply);
    step.apply = apply;
    expect((await run(state, step)).status).toBe('waiting_form');
    expect(apply).not.toHaveBeenCalled();
    expect((await run(state, step, { action: 'skip', flag: false })).status).toBe('done');
    expect(apply).toHaveBeenCalledOnce();
  });

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

  it('autoSubmitDefaults never auto-submits a form carrying the fix-loop gate field', async () => {
    const state = freshState();
    state.taskRow = { id: 'task-1', autoContinue: true, preAnswers: null };
    const gate: FormSchema = {
      title: 'Gate',
      fields: [
        {
          type: 'radio',
          id: FIX_LOOP_ACTION_FIELD,
          label: 'Proceed?',
          options: [
            { value: 'continue', label: 'Go' },
            { value: 'abort', label: 'Stop' },
          ],
          default: 'continue',
        },
      ],
    };
    const result = await run(state, makeStep({ form: () => gate, autoSubmitDefaults: true }));
    expect(result.status).toBe('waiting_form');
    expect(state.taskStepRow.formValues).toBeNull();
  });

  it('a gate pre-answer is never auto-submitted into a gate form', async () => {
    const state = freshState();
    state.taskRow = {
      id: 'task-1',
      autoContinue: true,
      preAnswers: { 'cfg-step': { [FIX_LOOP_ACTION_FIELD]: 'continue' } },
    };
    const gate: FormSchema = {
      title: 'Gate',
      fields: [
        {
          type: 'radio',
          id: FIX_LOOP_ACTION_FIELD,
          label: 'Proceed?',
          options: [
            { value: 'continue', label: 'Go' },
            { value: 'abort', label: 'Stop' },
          ],
          default: 'continue',
        },
      ],
    };
    const result = await run(state, makeStep({ form: () => gate }));
    expect(result.status).toBe('waiting_form');
    expect(state.taskStepRow.formValues).toBeNull();
  });

  it('a pre-answer to a non-gate form is still auto-submitted', async () => {
    const state = freshState();
    state.taskRow = {
      id: 'task-1',
      autoContinue: true,
      preAnswers: { 'cfg-step': { action: 'update' } },
    };
    const result = await run(state, makeStep({ form: () => QUESTION_FORM }));
    expect(result.status).toBe('done');
    expect((state.taskStepRow.formValues as Record<string, unknown>).action).toBe('update');
  });

  it('a gate form that sets its own autoSubmit still waits for a person', async () => {
    const state = freshState();
    state.taskRow = { id: 'task-1', autoContinue: false, preAnswers: null };
    const gate: FormSchema = {
      title: 'Gate',
      autoSubmit: true,
      fields: [
        {
          type: 'radio',
          id: FIX_LOOP_ACTION_FIELD,
          label: 'Proceed?',
          options: [{ value: 'continue', label: 'Go' }],
          default: 'continue',
        },
      ],
    };
    const result = await run(state, makeStep({ form: () => gate }));
    expect(result.status).toBe('waiting_form');
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
    // Recorded only while the row still reads done, so a Retry that lands first leaves none.
    expect(vi.mocked(recordLedgerEntry).mock.calls[0]![4]).toEqual({ whileStepDone: true });
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

  it('refuses the claim when a Retry landed while shouldRun ran, keeping no flip', async () => {
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
    expect(state.updates.filter((u) => u.patch.status === 'running')).toEqual([]);
  });

  it('refuses the skip shouldRun chose when a Retry landed meanwhile', async () => {
    const state = freshState();
    state.taskRow = atEpoch(5);
    const { def } = guardedStep(() => {
      state.taskRow!.orchestrationEpoch = 6;
    }, false);

    expect((await runAtEpoch(state, def, 5)).status).toBe('superseded');
    expect(state.taskStepRow.status).toBe('pending');
    expect(state.taskStepRow.endedAt).toBeNull();
    expect(state.updates.filter((u) => u.patch.status === 'skipped')).toEqual([]);
  });

  it('refuses the claim on a task a Stop failed at the same epoch', async () => {
    const state = freshState();
    state.taskRow = atEpoch(5);
    // A Stop fails the task without moving the epoch.
    const { def, detected } = guardedStep(() => {
      state.taskRow!.status = 'failed';
    });

    expect((await runAtEpoch(state, def, 5)).status).toBe('superseded');
    expect(detected).toEqual([]);
    expect(state.taskStepRow.status).toBe('pending');
    expect(state.updates.filter((u) => u.patch.status === 'running')).toEqual([]);
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
it.each(['submitted', 'pre_answer'] as const)(
  'normalizes the known push gate URL before %s answer and schema persistence',
  async (source) => {
    const state = freshState();
    state.taskStepRow.stepId = '11a-gate-4-push';
    const values = {
      push: true,
      remoteUrl: 'https://fixture-user:fixture-password@example.test:443/repo',
    };
    state.taskRow = {
      id: 'task-1',
      autoContinue: true,
      preAnswers: source === 'pre_answer' ? { '11a-gate-4-push': values } : null,
    };
    const def = makeStep({
      form: () => ({
        title: 'Push',
        fields: [
          { type: 'checkbox', id: 'push', label: 'Push' },
          { type: 'text', id: 'remoteUrl', label: 'Remote' },
        ],
      }),
    });
    def.metadata.id = '11a-gate-4-push';
    const result = await run(state, def, source === 'submitted' ? values : undefined);
    expect(result.status).toBe('done');
    expect(
      JSON.stringify(
        state.updates.map(({ patch }) => ({
          formValues: patch.formValues,
          formSchema: patch.formSchema,
          output: patch.output,
        })),
      ).includes('fixture-password'),
    ).toBe(false);
    expect(state.taskStepRow.formValues).toMatchObject({
      remoteUrl: 'https://example.test:443/repo',
    });
  },
);
it('refuses an invalid push gate URL without saving it or echoing credentials', async () => {
  const state = freshState();
  state.taskStepRow.stepId = '11a-gate-4-push';
  const def = makeStep({
    form: () => ({ title: 'Push', fields: [{ type: 'text', id: 'remoteUrl', label: 'Remote' }] }),
  });
  def.metadata.id = '11a-gate-4-push';
  const result = await run(state, def, {
    remoteUrl: 'file://fixture-user:fixture-password@example.test/repo',
  });
  expect(result.status).toBe('failed');
  expect(state.taskStepRow.formValues).toBeNull();
  expect(
    JSON.stringify(
      state.updates.map(({ patch }) => ({
        formValues: patch.formValues,
        errorMessage: patch.errorMessage,
      })),
    ).includes('fixture-password'),
  ).toBe(false);
});
const legacyGateSchema: FormSchema = {
  title: 'Push',
  fields: [
    { type: 'checkbox', id: 'push', label: 'Push' },
    {
      type: 'text',
      id: 'remoteUrl',
      label: 'Remote',
      default: 'https://fixture-user:fixture-password@example.test:443/repo',
    },
    { type: 'text', id: 'note', label: 'Note', default: 'keep' },
  ],
};
const copiedForms = (state: MockState) =>
  JSON.stringify(
    state.updates.map(({ patch }) => ({
      formValues: patch.formValues,
      formSchema: patch.formSchema,
      output: patch.output,
    })),
  );
it.each([false, true])(
  'reopened form newAttempt=%s preserves or advances the durable generation before detect',
  async (newAttempt) => {
    const state = freshState();
    state.taskStepRow.rerunGeneration = 4;
    const generations: number[] = [];
    const def = makeStep({ form: () => ZERO_FIELD_FORM });
    def.detect = async (ctx) => {
      generations.push(ctx.rerunGeneration!);
      return { generation: ctx.rerunGeneration };
    };
    def.apply = async () => {
      throw new ReopenStepFormError('Another decision', { newAttempt });
    };
    expect((await run(state, def, {})).status).toBe('waiting_form');
    const expected = newAttempt ? 5 : 4;
    expect(generations).toEqual([4, expected]);
    expect(state.taskStepRow).toMatchObject({
      rerunGeneration: expected,
      detectOutput: { generation: expected },
      formValues: null,
    });
  },
);
it.each(['', null, undefined])(
  'normalizes the final default-expanded submitted gate answer: case %#',
  async (remoteUrl) => {
    const state = freshState();
    Object.assign(state.taskStepRow, {
      stepId: '11a-gate-4-push',
      status: 'running',
      formSchema: legacyGateSchema,
    });
    const def = makeStep({ form: () => legacyGateSchema });
    def.metadata.id = '11a-gate-4-push';
    const result = await run(state, def, {
      push: false,
      ...(remoteUrl === undefined ? {} : { remoteUrl }),
    });
    expect(result.status).toBe('done');
    expect(copiedForms(state).includes('fixture-password')).toBe(false);
    expect(state.taskStepRow.formValues).toMatchObject({
      push: false,
      remoteUrl: 'https://example.test:443/repo',
      note: 'keep',
    });
  },
);
it('normalizes the final default-expanded automatic answer', async () => {
  const state = freshState();
  Object.assign(state.taskStepRow, { stepId: '11a-gate-4-push', formSchema: legacyGateSchema });
  state.taskRow = {
    id: 'task-1',
    autoContinue: true,
    preAnswers: { '11a-gate-4-push': { push: false, remoteUrl: '' } },
  };
  const def = makeStep({ form: () => legacyGateSchema });
  def.metadata.id = '11a-gate-4-push';
  expect((await run(state, def)).status).toBe('done');
  expect(copiedForms(state).includes('fixture-password')).toBe(false);
});
it('normalizes a legacy schema copied at a Retry park without consuming the stale submit', async () => {
  const state = freshState();
  Object.assign(state.taskStepRow, {
    stepId: '11a-gate-4-push',
    status: 'running',
    formSchema: legacyGateSchema,
    pauseFormOnRetry: true,
  });
  const def = makeStep({ form: () => legacyGateSchema });
  def.metadata.id = '11a-gate-4-push';
  const result = await run(state, def, { push: true });
  expect(result.status).toBe('waiting_form');
  expect(
    JSON.stringify(result.status === 'waiting_form' ? result.formSchema : {}).includes(
      'fixture-password',
    ),
  ).toBe(false);
  expect(state.taskStepRow.formValues).toBeNull();
});
it('normalizes a saved legacy answer before continuation creates new output', async () => {
  const state = freshState();
  Object.assign(state.taskStepRow, {
    stepId: '11a-gate-4-push',
    status: 'waiting_cli',
    formSchema: legacyGateSchema,
    formValues: {
      push: false,
      remoteUrl: 'https://fixture-user:fixture-password@example.test:443/repo',
    },
  });
  const def = makeStep({ form: () => legacyGateSchema });
  def.metadata.id = '11a-gate-4-push';
  expect((await run(state, def)).status).toBe('done');
  expect(copiedForms(state).includes('fixture-password')).toBe(false);
});

it('normalizes a newly rendered gate schema before its first park', async () => {
  const state = freshState();
  state.taskStepRow.stepId = '11a-gate-4-push';
  state.taskRow = { id: 'task-1', autoContinue: false };
  const def = makeStep({ form: () => legacyGateSchema });
  def.metadata.id = '11a-gate-4-push';
  expect((await run(state, def)).status).toBe('waiting_form');
  expect(copiedForms(state).includes('fixture-password')).toBe(false);
});
it('normalizes the refreshed gate schema before a reopened form is copied', async () => {
  const state = freshState();
  state.taskStepRow.stepId = '11a-gate-4-push';
  const def = makeStep({ form: () => legacyGateSchema });
  def.metadata.id = '11a-gate-4-push';
  def.apply = async () => {
    throw new ReopenStepFormError();
  };
  expect((await run(state, def, { push: false })).status).toBe('waiting_form');
  expect(copiedForms(state).includes('fixture-password')).toBe(false);
});
it.each(['', null, undefined])(
  'preserves blank/no-default gate answers after validation: case %#',
  async (remoteUrl) => {
    const state = freshState();
    state.taskStepRow.stepId = '11a-gate-4-push';
    const def = makeStep({
      form: () => ({ title: 'Push', fields: [{ type: 'text', id: 'remoteUrl', label: 'Remote' }] }),
    });
    def.metadata.id = '11a-gate-4-push';
    expect(
      (await run(state, def, { ...(remoteUrl === undefined ? {} : { remoteUrl }) })).status,
    ).toBe('done');
    expect(state.taskStepRow.formValues).toMatchObject({ remoteUrl: null });
  },
);
it('preserves an unrelated form default even when its field is called remoteUrl', async () => {
  const state = freshState();
  const def = makeStep({ form: () => legacyGateSchema });
  expect((await run(state, def, { push: false, remoteUrl: '' })).status).toBe('done');
  expect(copiedForms(state).includes('fixture-password')).toBe(true);
});

it.each(['submitted', 'saved', 'pre_answer'] as const)(
  'run configuration keeps omitted downstream presets through %s validation',
  async (source) => {
    const state = freshState();
    state.taskStepRow.stepId = '06-run-config';
    const answers = { verifyRunTest: true };
    state.taskRow = {
      id: 'task-1',
      autoContinue: true,
      preAnswers: {
        '08b-test-management': { action: 'skip', runTests: false },
        '08-phase-5-verify': { runTest: false },
        ...(source === 'pre_answer' ? { '06-run-config': answers } : {}),
      },
    };
    if (source === 'saved') state.taskStepRow.formValues = answers;
    const def = {
      ...runConfigStep,
      llm: undefined,
      detect: async () => ({
        specBody: '',
        ddevMode: true,
        appRunnerMode: false,
        taskAdversarialQaLevel: null,
        taskMaxFixRounds: 10,
        runsBrowserVerify: true,
        runsAdversarialQa: true,
        dbExposeAvailable: false,
        taskExposeDbPort: false,
        reviewDimensionIds: ['security'],
      }),
    } as StepDefinition;
    const result = await run(state, def, source === 'submitted' ? answers : undefined);
    expect(result.status).toBe('done');
    expect(state.taskStepRow.formValues).toEqual(answers);
    const patch = state.updates.find((u) => u.table === 'tasks' && u.patch.preAnswers)?.patch;
    expect(patch?.maxFixRounds).toBe(10);
    expect(patch?.preAnswers).toMatchObject({
      '08b-test-management': { action: 'skip', runTests: false },
      '08-phase-5-verify': { runTest: true, runLint: true, runTypecheck: true },
      '08a-browser-setup': { mode: 'mcp' },
      '08a-browser-verify': { mode: 'mcp' },
    });
  },
);

describe('successful output contract boundary', () => {
  afterEach(() => vi.mocked(validateSuccessfulStepOutput).mockClear());
  function contracted(): StepDefinition {
    return { ...makeStep({}), outputContract: CODE_AUDIT_OUTPUT_CONTRACT };
  }
  it('validates before loop/routing, and persists the original output without stripping extensions', async () => {
    const state = freshState();
    const value = { audited: true, findings: [], coverage: null, extra: { preserved: true } };
    const def = {
      ...contracted(),
      apply: async () => value,
      fixLoop: { evaluate: vi.fn(() => null) },
    };
    const result = await run(state, def);
    expect(result.status).toBe('done');
    expect(validateSuccessfulStepOutput).toHaveBeenCalledOnce();
    expect(vi.mocked(validateSuccessfulStepOutput).mock.invocationCallOrder[0]).toBeLessThan(
      def.fixLoop.evaluate.mock.invocationCallOrder[0]!,
    );
    expect(state.taskStepRow.output).toBe(value);
  });

  it('a takeover during pinned-role lookup wins before output diagnostics', async () => {
    const state = freshState();
    state.taskRow = { id: 'task-1', ...rolePin(2) };
    const db = makeMockDb(state);
    Object.defineProperty(db.query.tasks, 'findFirst', {
      value: async (options: { columns?: Record<string, boolean> }) => {
        if (options.columns?.derivedRunPlan) state.taskStepRow.status = 'pending';
        return state.taskRow ?? undefined;
      },
    });
    const stepDef = {
      ...makeStep({}),
      metadata: { ...makeStep({}).metadata, id: PRODUCER },
      outputContract: CODE_REVIEW_OUTPUT_CONTRACT,
      replaces: [REVIEW] as const,
      apply: async () => ({ invalid: true }),
    };
    const result = await advanceStep({
      db,
      taskId: 'task-1',
      userId: 'user-1',
      repoPath: '/tmp',
      workspacePath: '/tmp',
      cliProviderId: null,
      stepDef,
    });
    expect(result.status).toBe('superseded');
    expect(validateSuccessfulStepOutput).not.toHaveBeenCalled();
  });
  it('fails an actual pinned replacement mismatch before host routing or persistence', async () => {
    const state = freshState();
    state.taskRow = { id: 'task-1', ...rolePin(2) };
    const evaluate = vi.fn(() => null);
    const def = {
      ...makeStep({}),
      metadata: { ...makeStep({}).metadata, id: PRODUCER },
      outputContract: CODE_REVIEW_OUTPUT_CONTRACT,
      replaces: [REVIEW] as const,
      apply: async () => ({ privateValue: 'NEVER LOG' }),
      fixLoop: { evaluate },
    };
    expect((await run(state, def)).status).toBe('failed');
    expect(state.taskStepRow.errorMessage).toContain('step-output-contract-invalid');
    expect(state.taskStepRow.errorMessage).not.toContain('NEVER LOG');
    expect(evaluate).not.toHaveBeenCalled();
    expect(state.updates.some((u) => 'output' in u.patch || 'iterations' in u.patch)).toBe(false);
  });
  it('fails a rejected output before hooks or output writes, without fixLoopOnError routing', async () => {
    const state = freshState();
    const { StepOutputContractInvalidError } =
      await import('../src/step-engine/step-output-contract.js');
    vi.mocked(validateSuccessfulStepOutput).mockImplementationOnce(() => {
      throw new StepOutputContractInvalidError(CODE_AUDIT_OUTPUT_CONTRACT, 'cfg-step', ['audited']);
    });
    const evaluate = vi.fn(() => null);
    const shouldContinue = vi.fn(async () => false);
    const def = {
      ...contracted(),
      fixLoop: { evaluate },
      fixLoopOnError: true,
      loop: { maxIterations: 1, shouldContinue },
    };
    const result = await run(state, def);
    expect(result.status).toBe('failed');
    expect(state.taskStepRow.errorMessage).toContain('step-output-contract-invalid');
    expect(state.updates.some((u) => 'output' in u.patch || 'iterations' in u.patch)).toBe(false);
    expect(evaluate).not.toHaveBeenCalled();
    expect(shouldContinue).not.toHaveBeenCalled();
  });
  it.each(['done', 'skipped'] as const)(
    'does not validate historical %s outputs',
    async (status) => {
      const state = freshState();
      const legacy = { old: true };
      Object.assign(state.taskStepRow, { status, output: legacy });
      expect((await run(state, contracted())).status).toBe(status);
      expect(validateSuccessfulStepOutput).not.toHaveBeenCalled();
      expect(state.taskStepRow.output).toBe(legacy);
    },
  );
  it('does not manufacture or validate an output on shouldRun skip', async () => {
    const state = freshState();
    const apply = vi.fn(async () => ({}));
    const def = { ...contracted(), shouldRun: () => false, apply };
    expect((await run(state, def)).status).toBe('skipped');
    expect(state.taskStepRow.output).toBeNull();
    expect(state.updates.some((u) => 'output' in u.patch)).toBe(false);
    expect(apply).not.toHaveBeenCalled();
    expect(validateSuccessfulStepOutput).not.toHaveBeenCalled();
  });
  it('does not validate a parked form or a reopen continuation throw', async () => {
    const state = freshState();
    state.taskRow = { id: 'task-1', autoContinue: false };
    const def = {
      ...contracted(),
      form: () => QUESTION_FORM,
      apply: async () => {
        throw new ReopenStepFormError();
      },
    };
    expect((await run(state, def)).status).toBe('waiting_form');
    expect((await run(state, def, { action: 'update' })).status).toBe('waiting_form');
    expect(validateSuccessfulStepOutput).not.toHaveBeenCalled();
  });
});

describe('contract checks preserve pass ownership and continuation semantics', () => {
  afterEach(() => {
    vi.mocked(validateSuccessfulStepOutput).mockClear();
    vi.useRealTimers();
  });
  const output = { audited: true, findings: [], coverage: null };
  const def = (): StepDefinition => ({
    ...makeStep({}),
    outputContract: CODE_AUDIT_OUTPUT_CONTRACT,
    apply: async () => output,
  });
  it.each(['pending', 'skipped', 'failed'] as const)(
    'a %s takeover during apply wins before contract diagnostics',
    async (status) => {
      const state = freshState();
      const step = {
        ...def(),
        apply: async () => {
          state.taskStepRow.status = status;
          return { invalid: true };
        },
      };
      expect((await run(state, step)).status).toBe('superseded');
      expect(validateSuccessfulStepOutput).not.toHaveBeenCalled();
      expect(state.updates.some((u) => 'output' in u.patch)).toBe(false);
    },
  );
  it('validates the successful return of a waiting_cli continuation', async () => {
    const state = freshState();
    Object.assign(state.taskStepRow, { status: 'waiting_cli', detectOutput: { ok: true } });
    expect((await run(state, def())).status).toBe('done');
    expect(validateSuccessfulStepOutput).toHaveBeenCalledOnce();
    expect(state.taskStepRow.output).toBe(output);
  });
  it('a Cancel observed during apply wins before contract diagnostics', async () => {
    vi.useFakeTimers();
    const state = freshState();
    state.taskRow = { id: 'task-1', status: 'running' };
    const step = {
      ...def(),
      apply: async () => {
        state.taskRow!.status = 'cancelled';
        await vi.advanceTimersByTimeAsync(2000);
        return { invalid: true };
      },
    };
    expect((await run(state, step)).status).toBe('failed');
    expect(state.taskStepRow.errorMessage).toBe('task cancelled by user');
    expect(validateSuccessfulStepOutput).not.toHaveBeenCalled();
  });
  it('persists a builtin drifted output even with a live contract declaration', async () => {
    const state = freshState();
    const step = def();
    step.metadata.id = '08c2-code-audit';
    const value = { legacyDrift: true };
    step.apply = async () => value;
    expect((await run(state, step)).status).toBe('done');
    expect(validateSuccessfulStepOutput).toHaveBeenCalledOnce();
    expect(state.taskStepRow.output).toBe(value);
  });
});

describe('mining dependency guard', () => {
  afterEach(() => vi.unstubAllEnvs());
  it.each(['0', '1'])('refuses ordinary mining before selection with bypass=%s', async (bypass) => {
    vi.stubEnv('HAIVE_TEST_BYPASS_LLM', bypass);
    const state = freshState();
    const select = vi.fn(async () => []);
    const def = {
      ...makeStep({}),
      agentMining: { requiredCapabilities: [], selectAgents: select },
    };
    const result = await run(state, def);
    expect(result.status).toBe('failed');
    expect(state.taskStepRow.errorMessage).toBe(
      'agent mining requires CLI invocation but no providers or deps supplied',
    );
    expect(select).not.toHaveBeenCalled();
  });
  it.each(['0', '1'])(
    'refuses a selected insight before any journal intent with bypass=%s',
    async (bypass) => {
      vi.stubEnv('HAIVE_TEST_BYPASS_LLM', bypass);
      const state = freshState();
      state.taskStepRow.stepId = '08e-insights-triage';
      const select = vi.fn(insightsTriageStep.agentMining!.selectAgents);
      const def = {
        ...insightsTriageStep,
        shouldRun: undefined,
        detect: async () => ({
          insights: [{ id: 'one', title: 'One', location: 'a.ts', sourceStep: 'review' }],
        }),
        agentMining: { ...insightsTriageStep.agentMining!, selectAgents: select },
      } as StepDefinition;
      const db = makeMockDb(state);
      const insert = vi.spyOn(db, 'insert');
      const result = await advanceStep({
        db,
        taskId: 'task-1',
        userId: 'user-1',
        repoPath: '/tmp',
        workspacePath: '/tmp',
        cliProviderId: null,
        stepDef: def,
        formValues: { selectedInsights: ['one'] },
      });
      expect(result.status).toBe('failed');
      expect(state.taskStepRow.errorMessage).toBe(
        'agent mining requires CLI invocation but no providers or deps supplied',
      );
      expect(select).not.toHaveBeenCalled();
      expect(insert.mock.calls.some(([table]) => tableNameOf(table) === 'task_events')).toBe(false);
    },
  );
});

describe('manual insight choices under auto-continue', () => {
  it.each([undefined, { selectedInsights: [] }])(
    'parks with choices and legacy preset %j, then accepts a deliberate empty submit',
    async (preset) => {
      const state = freshState();
      state.taskStepRow.stepId = '08e-insights-triage';
      state.taskRow = {
        id: 'task-1',
        autoContinue: true,
        preAnswers: preset ? { '08e-insights-triage': preset } : {},
      };
      const select = vi.fn(insightsTriageStep.agentMining!.selectAgents);
      const def = {
        ...insightsTriageStep,
        shouldRun: undefined,
        detect: async () => ({
          worktreePath: '/tmp',
          sandboxWorktreePath: '/workspace',
          spec: '',
          insights: [
            {
              id: 'i1',
              title: 'Improve handling',
              location: 'a.ts:1',
              sourceStep: '08c-code-review',
            },
          ],
        }),
        agentMining: { ...insightsTriageStep.agentMining!, selectAgents: select },
      } as StepDefinition;
      const first = await run(state, def);
      expect(first.status).toBe('waiting_form');
      expect(state.taskStepRow.formValues).toBeNull();
      expect(select).not.toHaveBeenCalled();
      expect(state.invocation).toBeUndefined();
      expect((await run(state, def, { selectedInsights: [] })).status).toBe('done');
      expect(select).toHaveBeenCalled();
      for (const r of select.mock.results) expect(await r.value).toEqual([]);
      expect(state.invocation).toBeUndefined();
    },
  );
});

it('upgrades a persisted 06 schema in a schema-only write while retaining saved answers and recommendation', async () => {
  const state = freshState();
  const old: FormSchema = {
    title: 'Run',
    fields: [{ id: 'simplifyCode', type: 'checkbox', label: 'Simplify', default: true }],
  };
  state.taskStepRow.stepId = '06-run-config';
  state.taskStepRow.formSchema = old;
  state.taskStepRow.formValues = { simplifyCode: false };
  state.taskStepRow.waitingStartedAt = new Date('2026-01-01');
  const def = makeStep({ form: () => old });
  def.metadata.id = '06-run-config';
  expect((await run(state, def)).status).toBe('done');
  const patch = state.updates.find((u) => u.patch.formSchema)?.patch;
  expect(Object.keys(patch!)).toEqual(['formSchema', 'updatedAt']);
  expect(patch!.formSchema).toMatchObject({
    fields: [
      { id: 'simplifyCode', default: true },
      { id: 'autoActOnInsights', default: false },
    ],
  });
  expect(state.taskStepRow.formValues).toEqual({ simplifyCode: false });
  expect(old.fields).toHaveLength(1);
});

it.each(['answer', 'preset'] as const)(
  'accepts the now-visible insight switch from a worker-validated %s',
  async (source) => {
    const state = freshState();
    state.taskStepRow.stepId = '06-run-config';
    state.taskRow = {
      id: 'task-1',
      autoContinue: true,
      preAnswers: source === 'preset' ? { '06-run-config': { autoActOnInsights: true } } : {},
    };
    const def = {
      ...makeStep({}),
      metadata: runConfigStep.metadata,
      preserveOmittedFormFields: runConfigStep.preserveOmittedFormFields,
      form: () =>
        ({
          title: 'Run',
          fields: [
            {
              id: 'autoActOnInsights',
              type: 'checkbox',
              label: 'Auto',
              default: false,
              visibleWhen: { field: 'autoActOnInsights', in: [] },
            },
          ],
        }) as FormSchema,
      apply: runConfigStep.apply,
    } as StepDefinition;
    const result = await run(
      state,
      def,
      source === 'answer' ? { autoActOnInsights: true } : undefined,
    );
    expect(result.status).toBe('done');
    expect(state.taskStepRow.output).toMatchObject({ autoActOnInsights: true });
    expect(
      state.updates.find((u) => u.table === 'tasks' && 'autoActOnInsights' in u.patch)?.patch
        .autoActOnInsights,
    ).toBe(true);
    if (source === 'preset')
      expect(state.taskStepRow.formSchema).toMatchObject({ fields: [{ default: true }] });
  },
);

// Both the pre-dispatch gate and a consumer's own read must fail without spending a fix round.
it.each(['required pre-dispatch', 'module loadRoleOutput'])(
  'keeps a data-edge failure from %s out of fixLoopOnError',
  async (path) => {
    const { buildDataEdgePlan } = await import('@haive/shared/data-edge-plan');
    const { dataPortNodes } = await import('@haive/shared/step-ports');
    const { SPEC_ROLES, STEP_ROLE_REGISTRY } = await import('@haive/shared/step-outputs');
    const role = SPEC_ROLES.checked;
    const consumerId = 'module.ports.consumer';
    const nodes = dataPortNodes(['05-phase-0b5-spec-quality', consumerId]);
    nodes[1]!.inputs = [
      {
        id: 'spec',
        role,
        contract: STEP_ROLE_REGISTRY[role].contract,
        authorship: 'mixed',
        optional: false,
      },
    ];
    const plan = buildDataEdgePlan('static', [{ executionPath: null, nodes }]);
    const state = freshState();
    Object.assign(state.taskStepRow, { stepId: consumerId, round: 0 });
    state.taskRow = { id: 'task-1', userId: 'user-1', currentRound: 0, dataEdgePlan: plan };
    const db = makeMockDb(state);
    let producerStatus = path === 'required pre-dispatch' ? 'pending' : 'done';
    // The newest producer is pending, with an older-looking output that must stay unreadable.
    Object.assign(db.query, { taskSteps: { findFirst: async () => state.taskStepRow } });
    const baseSelect = db.select.bind(db);
    Object.assign(db, {
      select: (...args: unknown[]) => {
        const selected = baseSelect(...(args as []));
        const from = selected.from.bind(selected);
        return {
          ...selected,
          from: (table: unknown) => {
            const result = from(table as never);
            if (tableNameOf(table) !== 'task_steps') return result;
            const where = result.where.bind(result);
            return {
              ...result,
              where: (condition: unknown) => {
                const filtered = where(condition as never);
                if (!conditionValues(condition).includes('05-phase-0b5-spec-quality'))
                  return filtered;
                return {
                  ...filtered,
                  orderBy: () => ({
                    limit: async () => [
                      {
                        id: 'producer',
                        taskId: 'task-1',
                        stepId: '05-phase-0b5-spec-quality',
                        round: 0,
                        status: producerStatus,
                        output: { spec: 'stale' },
                      },
                    ],
                  }),
                };
              },
            };
          },
        };
      },
    });
    const detect = vi.fn(async () => {
      producerStatus = 'pending';
      return {};
    });
    const apply = vi.fn(async (ctx: import('@haive/shared/step').StepContext) =>
      ctx.host!.loadRoleOutput('spec'),
    );
    const result = await advanceStep({
      db,
      taskId: 'task-1',
      userId: 'user-1',
      repoPath: '/tmp',
      workspacePath: '/tmp',
      cliProviderId: null,
      moduleDeactivation: null,
      stepDef: {
        metadata: { ...makeStep({}).metadata, id: consumerId },
        fixLoopOnError: true,
        detect,
        apply,
      },
    });
    expect(result.status).toBe('failed');
    expect(state.taskStepRow.status).toBe('failed');
    expect(state.taskStepRow.errorMessage).toContain('spec: required input not ready');
    expect(state.updates.some((u) => u.patch.status === 'done')).toBe(false);
    expect(state.updates.some((u) => u.patch.status === 'pending')).toBe(false);
    expect(state.taskRow.currentRound).toBe(0);
    expect(detect).toHaveBeenCalledTimes(path === 'required pre-dispatch' ? 0 : 1);
    expect(apply).toHaveBeenCalledTimes(path === 'required pre-dispatch' ? 0 : 1);
  },
);

// Human-only form fields: a key a step lists is never taken from a pre-answer.
describe('advanceStep humanOnlyFormFields pre-answers', () => {
  const SECRET_FORM: FormSchema = {
    ...QUESTION_FORM,
    fields: [...QUESTION_FORM.fields, { type: 'checkbox', id: 'secretTick', label: 'Secret' }],
  };
  const humanOnlyStep = () =>
    ({
      ...makeStep({ form: () => SECRET_FORM }),
      humanOnlyFormFields: ['secretTick'],
    }) as StepDefinition;
  const defaultOf = (state: MockState, id: string) => {
    const field = (state.taskStepRow.formSchema as FormSchema).fields.find((f) => f.id === id);
    return field && 'default' in field ? field.default : undefined;
  };

  it('B7 auto mode does not submit a pre-answered human-only key', async () => {
    const state = freshState();
    state.taskRow = {
      id: 'task-1',
      autoContinue: true,
      preAnswers: { 'cfg-step': { action: 'skip', secretTick: true } },
    };
    expect((await run(state, humanOnlyStep())).status).toBe('done');
    const values = state.taskStepRow.formValues as Record<string, unknown>;
    expect(values.action).toBe('skip');
    expect(values.secretTick).not.toBe(true);
  });

  it('B7 a form that stops does not overlay a pre-answered human-only key', async () => {
    const state = freshState();
    state.taskRow = {
      id: 'task-1',
      autoContinue: false,
      preAnswers: { 'cfg-step': { action: 'skip', secretTick: true } },
    };
    expect((await run(state, humanOnlyStep())).status).toBe('waiting_form');
    expect(defaultOf(state, 'secretTick')).not.toBe(true);
    expect(defaultOf(state, 'action')).toBe('skip');
  });

  it('B7 a pre-answer holding only human-only keys counts as no pre-answer', async () => {
    const state = freshState();
    state.taskRow = {
      id: 'task-1',
      autoContinue: true,
      preAnswers: { 'cfg-step': { secretTick: true } },
    };
    const step = humanOnlyStep();
    const apply = vi.fn(step.apply);
    step.apply = apply;
    expect((await run(state, step)).status).toBe('waiting_form');
    expect(apply).not.toHaveBeenCalled();
    expect(defaultOf(state, 'secretTick')).not.toBe(true);
  });

  it('B7 a values submit by a person still reaches apply with the human-only key (PIN)', async () => {
    const state = freshState();
    state.taskRow = { id: 'task-1', autoContinue: false, preAnswers: null };
    const result = await run(state, humanOnlyStep(), { action: 'skip', secretTick: true });
    expect(result.status).toBe('done');
    expect(state.taskStepRow.formValues).toMatchObject({ action: 'skip', secretTick: true });
    expect(state.taskStepRow.output).toMatchObject({ values: { secretTick: true } });
  });

  it('B7 a step without the property still receives the same pre-answer unchanged (PIN)', async () => {
    const state = freshState();
    state.taskRow = {
      id: 'task-1',
      autoContinue: true,
      preAnswers: { 'cfg-step': { action: 'skip', secretTick: true } },
    };
    expect((await run(state, makeStep({ form: () => SECRET_FORM }))).status).toBe('done');
    expect(state.taskStepRow.formValues).toMatchObject({ action: 'skip', secretTick: true });
  });
});

describe('gates after a gate-3 insight cycle (database faked)', () => {
  const OWNER = 'user-1';
  const GATE3 = '10-gate-3-commit';
  const GATE2 = '09-gate-2-verify-approval';
  type Source =
    | 'task preset'
    | 'form autoSubmit'
    | 'step defaults'
    | 'saved synthetic'
    | 'queue answer'
    | 'persisted schema'
    | 'prior reuse';
  const SOURCES: Source[] = [
    'task preset',
    'form autoSubmit',
    'step defaults',
    'saved synthetic',
    'queue answer',
    'persisted schema',
    'prior reuse',
  ];
  type Qa = { round: number; status: 'done' | 'skipped'; decision?: 'accept' | 'fix' };
  const QA_ACCEPT: Qa[] = [{ round: 2, status: 'done', decision: 'accept' }];

  const gateRow = (stepId: string, id: string, round: number, status: string, generation = 0) => ({
    id,
    stepId,
    round,
    status,
    rerunGeneration: generation,
  });

  /** The latest gate-3 apply request, naming `src` as its source row, or an automatic round's event. */
  const continuation = (
    round: number,
    automatic = false,
    sourceStepRow = 'src',
    generation = 0,
  ) => ({
    id: `ev-${round}`,
    payload: {
      continuation: {
        version: 1,
        kind: 'insight_revise',
        batchId: 'batch',
        sourceStepRow,
        generation,
        round,
        ...(automatic ? {} : { mode: 'gate3', stage: 'apply' }),
      },
      targetStepId: '08e-insights-triage',
    },
  });

  interface GateSeed {
    cycle?: 'cycle' | 'none' | 'automatic';
    round?: number;
    qa?: Qa[];
    rows?: Record<string, unknown>[];
    submission?: Record<string, unknown>;
    savedValues?: Record<string, unknown>;
    status?: string;
    /** The round and generation the cycle's event recorded. */
    cycleRound?: number;
    cycleGeneration?: number;
    /** The generation of the gate row being advanced, and whether a Retry holds its form. */
    rowGeneration?: number;
    pauseForm?: boolean;
    /** The cycle's source row: a separate row by default, the gate row itself, or none at all. */
    source?: {
      self?: boolean;
      absent?: boolean;
      round?: number;
      status?: string;
      rerunGeneration?: number;
    };
  }

  /** One pending gate row at `round` holding the pre-answer `source`, with the cycle `opts` names. */
  function seedGate(gate: 3 | 2, source: string, opts: GateSeed = {}) {
    const { cycle = 'cycle', qa = gate === 2 ? QA_ACCEPT : [], status = 'pending' } = opts;
    const round = opts.round ?? (gate === 3 ? 1 : 2);
    const stepId = gate === 3 ? GATE3 : GATE2;
    const answer = gate === 3 ? { commit: true } : { decision: 'approve' };
    const state = freshState();
    const src = opts.source ?? {};
    const sourceId = src.self ? 'ts-1' : 'src';
    const sourceRound = src.round ?? (src.self ? round : gate === 3 ? round - 1 : 0);
    const sourceRow = gateRow(
      GATE3,
      sourceId,
      sourceRound,
      src.status ?? (src.self ? status : 'done'),
      src.rerunGeneration ?? (src.self ? (opts.rowGeneration ?? 0) : 0),
    );
    state.taskRow = {
      id: 'task-1',
      autoContinue: source !== 'form autoSubmit',
      preAnswers: source === 'task preset' || source === 'preAnswers' ? { [stepId]: answer } : {},
      repositoryId: 'repo-1',
      type: 'workflow',
    };
    state.taskStepRow = {
      ...state.taskStepRow,
      stepId,
      round,
      status,
      rerunGeneration: opts.rowGeneration ?? 0,
      ...(opts.pauseForm ? { pauseFormOnRetry: true } : {}),
      waitingStartedAt: null,
      detectOutput: {},
      formValues: opts.savedValues ?? (source === 'saved synthetic' ? answer : null),
    };
    state.gate = {
      continuations:
        cycle === 'none'
          ? []
          : [
              continuation(
                opts.cycleRound ?? (gate === 3 ? round : 1),
                cycle === 'automatic',
                sourceId,
                opts.cycleGeneration ?? 0,
              ),
            ],
      checks: [],
      rows: [
        ...(src.absent ? [] : [sourceRow]),
        ...qa.map((q, i) => ({
          ...gateRow('08d2-adversarial-qa-review', `qa-${i}`, q.round, q.status),
          output: q.decision ? { decision: q.decision } : {},
        })),
        ...(opts.rows ?? []),
      ],
      ...(opts.submission ? { submission: { payload: opts.submission } } : {}),
      ...(source === 'prior reuse' ? { prior: answer } : {}),
    };
    const reconcile = vi.fn((_ctx, _detected, values) => values);
    const apply = vi.fn(async () => ({ applied: true }));
    const field =
      gate === 3
        ? { id: 'commit', type: 'checkbox' as const, label: 'Commit', default: true }
        : {
            id: 'decision',
            type: 'radio' as const,
            label: 'Decision',
            required: true,
            options: [
              { value: 'approve', label: 'Approve' },
              { value: 'reject', label: 'Reject' },
            ],
            default: 'reject',
          };
    const stepDef: StepDefinition = {
      metadata: {
        id: stepId,
        workflowType: 'workflow',
        index: gate === 3 ? 10 : 9,
        title: 'Gate',
        description: '',
        requiresCli: false,
        autoSubmitDefaults: source === 'step defaults',
        reuseLastCompletedFormValues: source === 'prior reuse',
      },
      reconcileReusedFormValues: reconcile,
      form: () => ({ title: 'Gate', autoSubmit: source === 'form autoSubmit', fields: [field] }),
      apply,
    };
    if (source === 'persisted schema')
      state.taskStepRow.formSchema = {
        title: 'Gate',
        autoSubmit: true,
        fields: [{ ...field, default: gate === 3 ? true : 'approve' }],
      };
    const formValues = source === 'queue answer' || source === 'job answer' ? answer : undefined;
    const advance = (values: Record<string, unknown> | undefined = formValues) => {
      const db = makeMockDb(state);
      return advanceStep({
        db,
        taskId: 'task-1',
        userId: OWNER,
        repoPath: '/tmp',
        workspacePath: '/tmp',
        cliProviderId: null,
        stepDef,
        ...(values ? { formValues: values } : {}),
      });
    };
    return { state, advance, apply, reconcile, answer };
  }

  const expectParked = async (
    run: ReturnType<typeof seedGate>,
    id: 'commit' | 'decision',
    label?: string,
  ) => {
    const result = await run.advance();
    expect(result.status, label).toBe('waiting_form');
    expect(result.row.formValues, label).toBeNull();
    expect(result.row.formSchema, label).toMatchObject({
      autoSubmit: false,
      fields: expect.arrayContaining([expect.objectContaining({ id })]),
    });
    expect(run.apply, label).not.toHaveBeenCalled();
    return result;
  };

  /** The owner-authenticated submit route's event, for the row and generation the gate holds. */
  const ownerSubmission = (gate: 3 | 2, payload: Record<string, unknown> = {}) => ({
    stepId: gate === 3 ? GATE3 : GATE2,
    fieldCount: 1,
    userId: OWNER,
    generation: 0,
    ...(gate === 3 ? { commit: true } : { decision: 'approve' }),
    ...payload,
  });

  describe('gate 3', () => {
    it.each(SOURCES.flatMap((source) => [[source, true] as const, [source, false] as const]))(
      'after a clean cycle: %s (cycle=%s)',
      async (source, cycle) => {
        const run = seedGate(3, source, { cycle: cycle ? 'cycle' : 'none' });
        if (!cycle) {
          expect((await run.advance()).status).toBe('done');
          expect(run.apply).toHaveBeenCalledOnce();
          return;
        }
        await expectParked(run, 'commit');
        expect(run.reconcile).not.toHaveBeenCalled();
      },
    );

    it.each(['task preset', 'queue answer'] as const)(
      'after an automatic round is not a cycle and commits: %s',
      async (source) => {
        const run = seedGate(3, source, { cycle: 'automatic' });
        expect((await run.advance()).status).toBe('done');
        expect(run.apply).toHaveBeenCalledOnce();
      },
    );

    it.each([
      ['queue payload alone', {}],
      ['saved values without an event', { savedValues: { commit: true } }],
      [
        'wrong user',
        { savedValues: { commit: true }, submission: ownerSubmission(3, { userId: 'other' }) },
      ],
      [
        'wrong generation',
        { savedValues: { commit: true }, submission: ownerSubmission(3, { generation: 1 }) },
      ],
      [
        'commit mismatch',
        { savedValues: { commit: true }, submission: ownerSubmission(3, { commit: false }) },
      ],
    ] as [string, GateSeed][])('stays parked with invalid human evidence: %s', async (_n, opts) => {
      const run = seedGate(3, 'queue answer', { ...opts, status: 'waiting_form' });
      await expectParked(run, 'commit');
    });

    it.each(['pending', 'running', 'waiting_form'])(
      'an owner answer on a %s row applies once and a duplicate advance does nothing',
      async (status) => {
        const run = seedGate(3, 'task preset', {
          status,
          savedValues: { commit: true },
          submission: ownerSubmission(3),
        });
        expect((await run.advance()).status).toBe('done');
        expect(run.apply).toHaveBeenCalledOnce();
        expect((await run.advance()).status).toBe('done');
        expect(run.apply).toHaveBeenCalledOnce();
      },
    );

    it.each(['done', 'skipped'])(
      'a cycle settled by a %s gate-3 row does not latch the next gate-3 round',
      async (status) => {
        const run = seedGate(3, 'task preset', {
          round: 2,
          cycle: 'none',
          rows: [gateRow(GATE3, 'settled', 1, status)],
        });
        run.state.gate!.continuations = [{ ...continuation(1), id: 'ev-old' }];
        run.state.gate!.rows[0] = gateRow(GATE3, 'src', 0, 'done');
        expect((await run.advance()).status).toBe('done');
        expect(run.apply).toHaveBeenCalledOnce();
      },
    );

    describe('after a Retry reset the source row or pulled the task below the cycle round', () => {
      const RETRY_ROW: GateSeed = {
        round: 0,
        cycleRound: 1,
        rowGeneration: 1,
        source: { self: true },
      };

      it.each(SOURCES.flatMap((source) => [[source, false] as const, [source, true] as const]))(
        'the gate row is the source row, below the cycle round, generation 1: %s (form held=%s)',
        async (source, pauseForm) => {
          const run = seedGate(3, source, { ...RETRY_ROW, pauseForm });
          await expectParked(run, 'commit');
          expect(run.reconcile).not.toHaveBeenCalled();
        },
      );

      it.each(
        SOURCES.flatMap((source) =>
          ['pending', 'running', 'waiting_form', 'failed'].map((s) => [source, s] as const),
        ),
      )(
        'a later round parks while the reset source row is not completed: %s, source %s',
        async (source, sourceStatus) => {
          const run = seedGate(3, source, {
            round: 2,
            cycleRound: 1,
            source: { round: 0, status: sourceStatus, rerunGeneration: 1 },
          });
          await expectParked(run, 'commit');
        },
      );

      const GRID = [0, 1, 2]
        .flatMap((round) =>
          [0, 1].flatMap((generation) =>
            ['pending', 'done'].map((status) => ({ round, generation, status })),
          ),
        )
        .filter((c) => !(c.status === 'done' && c.generation === 1 && c.round > 0));

      it.each(GRID)(
        'gate round $round, source generation $generation, source $status: not settled, parks',
        async ({ round, generation, status }) => {
          const run = seedGate(3, 'task preset', {
            round,
            cycleRound: 1,
            source: { round: 0, status, rerunGeneration: generation },
          });
          await expectParked(run, 'commit');
        },
      );

      it.each(['pending', 'running', 'waiting_form'])(
        'an owner answer for the re-run on a %s row applies once and a duplicate advance does nothing',
        async (status) => {
          const run = seedGate(3, 'task preset', {
            ...RETRY_ROW,
            status,
            savedValues: { commit: true },
            submission: ownerSubmission(3, { generation: 1 }),
          });
          expect((await run.advance()).status).toBe('done');
          expect(run.apply).toHaveBeenCalledOnce();
          expect((await run.advance()).status).toBe('done');
          expect(run.apply).toHaveBeenCalledOnce();
        },
      );

      it.each([
        ['queue payload alone', {}],
        ['saved values without an event', { savedValues: { commit: true } }],
        [
          'wrong user',
          {
            savedValues: { commit: true },
            submission: ownerSubmission(3, { userId: 'other', generation: 1 }),
          },
        ],
        [
          'wrong generation',
          { savedValues: { commit: true }, submission: ownerSubmission(3, { generation: 0 }) },
        ],
        [
          'commit mismatch',
          {
            savedValues: { commit: true },
            submission: ownerSubmission(3, { commit: false, generation: 1 }),
          },
        ],
      ] as [string, GateSeed][])(
        'stays parked with invalid human evidence for the re-run: %s',
        async (_n, opts) => {
          const run = seedGate(3, 'queue answer', {
            ...RETRY_ROW,
            ...opts,
            status: 'waiting_form',
          });
          await expectParked(run, 'commit');
        },
      );

      it.each(['done', 'skipped'])(
        'a source row completed again at a lower round (%s) settles the cycle for a later round',
        async (status) => {
          const run = seedGate(3, 'task preset', {
            round: 2,
            cycleRound: 1,
            source: { round: 0, status, rerunGeneration: 1 },
          });
          expect((await run.advance()).status).toBe('done');
          expect(run.apply).toHaveBeenCalledOnce();
        },
      );

      it.each([
        ['done at the generation the pick completed with', { round: 0, status: 'done' }],
        ['skipped at the generation the pick completed with', { round: 0, status: 'skipped' }],
        ...['pending', 'running', 'waiting_form', 'failed'].map(
          (status) =>
            [`${status} with a higher generation`, { round: 0, status, rerunGeneration: 1 }] as [
              string,
              GateSeed['source'],
            ],
        ),
        [
          'done with a higher generation at the gate row round',
          { round: 2, status: 'done', rerunGeneration: 1 },
        ],
        [
          'done with a higher generation above the gate row round',
          { round: 3, status: 'done', rerunGeneration: 1 },
        ],
        ['absent', { absent: true }],
      ] as [string, GateSeed['source']][])(
        'a later round still parks when the source row is %s',
        async (_n, source) => {
          const run = seedGate(3, 'task preset', { round: 2, cycleRound: 1, source });
          await expectParked(run, 'commit');
        },
      );

      it.each(['task preset', 'queue answer'] as const)(
        'an automatic round event with the Retry shape is not a cycle and commits: %s',
        async (source) => {
          const run = seedGate(3, source, { ...RETRY_ROW, cycle: 'automatic' });
          expect((await run.advance()).status).toBe('done');
          expect(run.apply).toHaveBeenCalledOnce();
        },
      );

      it('no event with the Retry shape commits', async () => {
        const run = seedGate(3, 'task preset', { ...RETRY_ROW, cycle: 'none' });
        expect((await run.advance()).status).toBe('done');
        expect(run.apply).toHaveBeenCalledOnce();
      });
    });

    it('a failed verification keeps the gate parked until a fresh submission arrives', async () => {
      const run = seedGate(3, 'task preset');
      run.state.gate!.checks = [
        { payload: { version: 1, batchId: 'failed', kind: 'verify_failed', round: 1 } },
        { payload: { version: 1, batchId: 'failed', kind: 'gate2_approved', round: 1 } },
      ];
      await expectParked(run, 'commit');
    });
  });

  describe('gate 3 after a re-approved failed verification', () => {
    const APPROVAL_ROUND = 3;
    const approved = (kind = 'gate2_approved') => [
      { payload: { version: 1, batchId: 'b', kind, round: APPROVAL_ROUND } },
    ];
    /** A gate-3 row at `round` with the failed-path latch isolated (no cycle event). */
    const seedFailedPath = (source: Source, opts: GateSeed = {}) => {
      const run = seedGate(3, source, { cycle: 'none', ...opts });
      run.state.gate!.checks = approved();
      return run;
    };
    const answeredRow = (round: number, status: string, flagged = true) => ({
      ...gateRow(GATE3, 'answered', round, status),
      ...(flagged ? { ownerAnswered: true } : {}),
    });

    it.each(
      SOURCES.flatMap((source) =>
        [0, 1, 2, 3, 4].flatMap((round) =>
          [0, 1].flatMap((generation) =>
            [false, true].map((pauseForm) => [source, round, generation, pauseForm] as const),
          ),
        ),
      ),
    )(
      'parks for a fresh answer: %s at round %i, generation %i, form held %s',
      async (source, round, rowGeneration, pauseForm) => {
        const run = seedFailedPath(source, { round, rowGeneration, pauseForm });
        await expectParked(run, 'commit');
      },
    );

    it.each([
      ['queue payload alone', {}],
      ['saved values without an event', { savedValues: { commit: true } }],
      [
        'wrong user',
        { savedValues: { commit: true }, submission: ownerSubmission(3, { userId: 'other' }) },
      ],
      [
        'wrong generation',
        { savedValues: { commit: true }, submission: ownerSubmission(3, { generation: 1 }) },
      ],
      [
        'commit mismatch',
        { savedValues: { commit: true }, submission: ownerSubmission(3, { commit: false }) },
      ],
    ] as [string, GateSeed][])(
      'below the approval round stays parked with invalid human evidence: %s',
      async (_n, opts) => {
        const run = seedFailedPath('queue answer', { ...opts, round: 2, status: 'waiting_form' });
        await expectParked(run, 'commit');
      },
    );

    it.each(
      [0, 1].flatMap((g) => ['pending', 'running', 'waiting_form'].map((s) => [g, s] as const)),
    )(
      'an owner answer below the approval round (generation %i, %s row) applies once',
      async (generation, status) => {
        const run = seedFailedPath('task preset', {
          round: 2,
          rowGeneration: generation,
          status,
          savedValues: { commit: true },
          submission: ownerSubmission(3, { generation }),
        });
        expect((await run.advance()).status).toBe('done');
        expect(run.apply).toHaveBeenCalledOnce();
        expect((await run.advance()).status).toBe('done');
        expect(run.apply).toHaveBeenCalledOnce();
      },
    );

    it.each(
      ['done', 'skipped'].flatMap((status) => [3, 4].map((round) => [status, round] as const)),
    )(
      'a %s gate-3 row answered by the owner after the approval (round %i) settles the latch',
      async (status, round) => {
        const run = seedFailedPath('task preset', {
          round: 5,
          rows: [answeredRow(round, status)],
        });
        expect((await run.advance()).status).toBe('done');
        expect(run.apply).toHaveBeenCalledOnce();
      },
    );

    it.each(
      ['done', 'skipped'].flatMap((status) => [0, 1, 2].map((round) => [status, round] as const)),
    )(
      'a gate-3 row answered below the approval round never settles a later one (%s, round %i)',
      async (status, round) => {
        const run = seedFailedPath('task preset', {
          round: 5,
          rows: [answeredRow(round, status)],
        });
        await expectParked(run, 'commit');
      },
    );

    it.each(
      ['done', 'skipped'].flatMap((status) =>
        [2, 3].flatMap((current) =>
          [3, 4, 6]
            .filter((answered) => answered >= current)
            .map((answered) => [status, answered, current] as const),
        ),
      ),
    )(
      'a later-round answer never settles an earlier-round gate 3 (%s answered at round %i, current round %i)',
      async (status, answered, current) => {
        const run = seedFailedPath('task preset', {
          round: current,
          rows: [answeredRow(answered, status)],
        });
        await expectParked(run, 'commit');
      },
    );

    it.each(
      ['done', 'skipped'].flatMap((status) => [3, 4].map((round) => [status, round] as const)),
    )(
      'a %s gate-3 row without the owner answer after the approval (round %i) does not settle',
      async (status, round) => {
        const run = seedFailedPath('task preset', {
          round: 5,
          rows: [answeredRow(round, status, false)],
        });
        await expectParked(run, 'commit');
      },
    );

    it.each(['pending', 'running', 'waiting_form', 'failed'])(
      'an answered gate-3 row that is %s again no longer settles the latch',
      async (status) => {
        const run = seedFailedPath('task preset', {
          round: 5,
          rows: [answeredRow(4, status)],
        });
        await expectParked(run, 'commit');
      },
    );

    it('no gate-3 row at all does not settle the latch', async () => {
      const run = seedFailedPath('task preset', { round: 2, source: { absent: true } });
      await expectParked(run, 'commit');
    });

    it.each(['task preset', 'queue answer'] as const)(
      'a latest verify_failed check commits with the preset: %s',
      async (source) => {
        const run = seedFailedPath(source, { round: 2 });
        run.state.gate!.checks = approved('verify_failed');
        expect((await run.advance()).status).toBe('done');
        expect(run.apply).toHaveBeenCalledOnce();
      },
    );

    it('no check event commits with the preset', async () => {
      const run = seedFailedPath('task preset', { round: 2 });
      run.state.gate!.checks = [];
      expect((await run.advance()).status).toBe('done');
      expect(run.apply).toHaveBeenCalledOnce();
    });

    it('an automatic round without an approval check commits with the preset', async () => {
      const run = seedGate(3, 'task preset', { cycle: 'automatic', round: 2 });
      expect((await run.advance()).status).toBe('done');
      expect(run.apply).toHaveBeenCalledOnce();
    });
  });

  describe('gate 2 kept for deferred QA findings', () => {
    type Gate2Source =
      | 'preAnswers'
      | 'prior reuse'
      | 'form autoSubmit'
      | 'step defaults'
      | 'saved synthetic'
      | 'job answer'
      | 'persisted schema';
    const GATE2_SOURCES: Gate2Source[] = [
      'preAnswers',
      'prior reuse',
      'form autoSubmit',
      'step defaults',
      'saved synthetic',
      'job answer',
      'persisted schema',
    ];

    it.each(GATE2_SOURCES)('parks for a fresh owner submission: %s', async (source) => {
      await expectParked(seedGate(2, source), 'decision');
    });

    it.each([
      ['QA accepted at the cycle round', [{ round: 1, status: 'done', decision: 'accept' }]],
      ['QA accepted at the gate round', QA_ACCEPT],
    ] as [string, Qa[]][])('parks when %s', async (_name, qa) => {
      await expectParked(seedGate(2, 'preAnswers', { qa }), 'decision');
    });

    it.each([
      ['no QA row', { qa: [] }],
      ['QA skipped', { qa: [{ round: 2, status: 'skipped' }] }],
      ['QA accepted before the cycle', { qa: [{ round: 0, status: 'done', decision: 'accept' }] }],
      [
        'latest QA row skipped',
        {
          qa: [
            { round: 1, status: 'done', decision: 'accept' },
            { round: 2, status: 'skipped' },
          ],
        },
      ],
      ['QA asked for fixes', { qa: [{ round: 2, status: 'done', decision: 'fix' }] }],
    ] as [string, GateSeed][])('honours the pre-answer in a cycle with %s', async (_n, opts) => {
      const run = seedGate(2, 'preAnswers', opts);
      expect((await run.advance()).status).toBe('done');
      expect(run.apply).toHaveBeenCalledOnce();
    });

    it.each([
      ['no cycle', 'none'],
      ['an automatic round', 'automatic'],
    ] as const)('honours the pre-answer with deferred findings and %s', async (_name, cycle) => {
      const run = seedGate(2, 'preAnswers', { cycle });
      expect((await run.advance()).status).toBe('done');
      expect(run.apply).toHaveBeenCalledOnce();
    });

    it('does not latch a gate 2 after a settled cycle', async () => {
      const run = seedGate(2, 'preAnswers', {
        round: 3,
        qa: [{ round: 1, status: 'done', decision: 'accept' }],
        rows: [gateRow(GATE3, 'settled', 2, 'done')],
      });
      expect((await run.advance()).status).toBe('done');
      expect(run.apply).toHaveBeenCalledOnce();
    });

    it.each([
      ['queue payload alone', {}],
      ['saved values without an event', { savedValues: { decision: 'approve' } }],
      [
        'wrong user',
        {
          savedValues: { decision: 'approve' },
          submission: ownerSubmission(2, { userId: 'other' }),
        },
      ],
      [
        'wrong generation',
        { savedValues: { decision: 'approve' }, submission: ownerSubmission(2, { generation: 1 }) },
      ],
      [
        'decision mismatch',
        {
          savedValues: { decision: 'approve' },
          submission: ownerSubmission(2, { decision: 'reject' }),
        },
      ],
    ] as [string, GateSeed][])('stays parked with invalid human evidence: %s', async (_n, opts) => {
      const run = seedGate(2, 'job answer', { ...opts, status: 'waiting_form' });
      await expectParked(run, 'decision');
    });

    it.each(['pending', 'running', 'waiting_form'])(
      'an owner answer on a %s row applies once and a duplicate advance does nothing',
      async (status) => {
        const run = seedGate(2, 'preAnswers', {
          status,
          savedValues: { decision: 'approve' },
          submission: ownerSubmission(2),
        });
        expect((await run.advance()).status).toBe('done');
        expect(run.apply).toHaveBeenCalledOnce();
        expect((await run.advance()).status).toBe('done');
        expect(run.apply).toHaveBeenCalledOnce();
      },
    );
  });
});

describe('approved apply pre-form continuation', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubEnv('HAIVE_TEST_BYPASS_LLM', '0');
    vi.spyOn(configService, 'getBoolean').mockResolvedValue(false);
    vi.spyOn(configService, 'get').mockResolvedValue(null);
    vi.spyOn(dispatcher, 'resolveTaskDispatch').mockResolvedValue({
      mode: 'cli',
      providerId: 'provider',
      invocation: { kind: 'cli', spec: {} },
    } as unknown as Awaited<ReturnType<typeof dispatcher.resolveTaskDispatch>>);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  function fixture(rerunPreForm = true) {
    const state = freshState();
    Object.assign(state.taskStepRow, {
      status: 'waiting_form',
      round: 0,
      rerunGeneration: 3,
      detectOutput: { revision: 'old' },
      formSchema: ZERO_FIELD_FORM,
      formValues: {},
    });
    state.taskRow = {
      id: 'task-1',
      userId: 'user-1',
      currentStepId: 'cfg-step',
      currentRound: 0,
      status: 'waiting_user',
      orchestrationEpoch: 7,
      autoContinue: true,
      summaryLlmEnabled: false,
    };
    state.invocation = {
      id: 'old-run',
      taskStepId: 'ts-1',
      endedAt: new Date(),
      exitCode: 0,
      rawOutput: 'old-output',
      parsedOutput: null,
      errorMessage: null,
      consumedAt: null,
    };
    state.invocations = [state.invocation];
    let applied = false;
    const def = makeStep({ form: () => ({ ...ZERO_FIELD_FORM, fields: [] }) });
    def.detect = vi.fn(async () => ({ revision: applied ? 'new' : 'old' }));
    def.prepareForm = vi.fn(async () => {});
    def.llm = {
      preForm: true,
      requiredCapabilities: [],
      buildPrompt: () => 'review refreshed work',
      prepare: vi.fn(async ({ formValues }) => {
        expect(formValues).toEqual({});
      }),
    };
    def.apply = vi.fn(async (_ctx, args) => {
      if (!applied) {
        expect(args.llmInvocationId).toBe('old-run');
        expect(args.llmOutput).toBe('old-output');
        applied = true;
        // Cast keeps the new behavior test runnable on the parent SDK.
        throw new ReopenStepFormError('Continue approved work', {
          notice: true,
          rerunPreForm,
        } as never);
      }
      expect(args.formValues).toEqual({});
      expect(args.llmOutput).not.toBe('old-output');
      return { complete: true };
    });
    const enqueue = vi.fn(async () => {});
    const advance = (values?: Record<string, unknown>) =>
      run(state, def, values, {
        providers: [],
        deps: { enqueueCliInvocation: enqueue },
        epoch: 7,
      });
    return { state, def, enqueue, advance };
  }

  it('default notice-only reopen refreshes a form without another dispatch', async () => {
    const h = fixture(false);
    expect((await h.advance({})).status).toBe('waiting_form');
    expect(h.enqueue).not.toHaveBeenCalled();
    expect(h.def.llm!.prepare).not.toHaveBeenCalled();
    expect(h.state.invocation!.consumedAt).toBeNull();
  });

  it('checkpoints waiting_user as running and re-enters detect then the normal reservation path', async () => {
    const h = fixture();
    h.enqueue.mockImplementation(async () => {
      expect(h.state.taskRow).toMatchObject({ status: 'running', orchestrationEpoch: 7 });
      expect(h.state.taskStepRow).toMatchObject({
        pauseFormOnRetry: true,
        formValues: null,
        rerunGeneration: 3,
      });
    });
    expect((await h.advance({ stale: true })).status).toBe('waiting_cli');
    expect(h.enqueue).toHaveBeenCalledOnce();
    expect(h.def.detect).toHaveBeenCalledOnce();
    expect(h.def.llm!.prepare).toHaveBeenCalledOnce();
    expect(h.state.invocations![0]!.consumedAt).toBeInstanceOf(Date);
    expect(h.state.taskStepRow.detectOutput).toEqual({ revision: 'new' });
    expect((await h.advance({ stale: true })).status).toBe('waiting_cli');
    expect(h.enqueue).toHaveBeenCalledOnce();
    Object.assign(h.state.invocation!, {
      endedAt: new Date(),
      exitCode: 0,
      rawOutput: 'new-output',
    });
    expect((await h.advance({ stale: true })).status).toBe('waiting_form');
    expect(h.def.apply).toHaveBeenCalledOnce();
    expect(h.state.taskStepRow).toMatchObject({ formValues: null, pauseFormOnRetry: false });
  });

  it('the new park rejects the old job timestamp after the durable hold has cleared', async () => {
    const h = fixture();
    const oldTimestamp = Date.now();
    await h.advance({ stale: true });
    await vi.advanceTimersByTimeAsync(1);
    Object.assign(h.state.invocation!, {
      endedAt: new Date(),
      exitCode: 0,
      rawOutput: 'new-output',
    });
    const parked = await h.advance({ stale: true });
    expect(parked.status).toBe('waiting_form');
    expect(h.state.taskStepRow.pauseFormOnRetry).toBe(false);
    expect(staleSubmitAction(parked.row, true, oldTimestamp, 'waiting_user')).toBe('drop');
    expect(staleSubmitAction(parked.row, true, oldTimestamp, 'running')).toBe('repark');
    expect(h.def.apply).toHaveBeenCalledOnce();
  });

  it.each(['schema', 'resolved-guard'] as const)(
    'the %s answer guard refuses before approved publication or fresh dispatch',
    async (guard) => {
      const h = fixture();
      const values = { approve: 'invalid' };
      h.state.taskStepRow.formSchema = {
        title: 'Approve',
        fields: [{ type: 'checkbox', id: 'approve', label: 'Approve', required: true }],
      };
      h.state.taskStepRow.formValues = null;
      const result = await advanceStep({
        db: makeMockDb(h.state),
        taskId: 'task-1',
        userId: 'user-1',
        repoPath: '/tmp',
        workspacePath: '/tmp',
        stepDef: h.def,
        cliProviderId: null,
        formValues: guard === 'schema' ? values : { approve: true },
        epoch: 7,
        providers: [],
        deps: { enqueueCliInvocation: h.enqueue },
        ...(guard === 'resolved-guard'
          ? {
              validateResolvedForm() {
                throw new Error('recorded approval missing');
              },
            }
          : {}),
      });
      expect(result.status).toBe('failed');
      expect(h.def.apply).not.toHaveBeenCalled();
      expect(h.enqueue).not.toHaveBeenCalled();
      expect(h.state.invocation!.consumedAt).toBeNull();
    },
  );

  it('module disable after reservation releases this pass without enqueue', async () => {
    const h = fixture();
    h.def.llm!.prepareWorkspace = async () => {
      vi.spyOn(activation, 'moduleDeactivationMessage').mockResolvedValue(
        'Module fixture is deactivated',
      );
    };
    const result = await h.advance({});
    expect(result.status).toBe('failed');
    expect(h.state.invocation!.supersededAt).toBeInstanceOf(Date);
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it('module disable after approved publication refuses the fresh dispatch', async () => {
    const h = fixture();
    const apply = h.def.apply;
    h.def.apply = async (ctx, args) => {
      vi.spyOn(activation, 'moduleDeactivationMessage').mockResolvedValue(
        'Module fixture is deactivated',
      );
      return apply(ctx, args);
    };
    const result = await h.advance({});
    expect(result.status).toBe('failed');
    expect(result.status === 'failed' && result.error).toContain('deactivated');
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it.each([true, false])('prepare false continues normally with a form=%s', async (form) => {
    const h = fixture();
    h.def.llm!.prepare = async () => false;
    h.def.form = () => (form ? ZERO_FIELD_FORM : null);
    expect((await h.advance({})).status).toBe(form ? 'waiting_form' : 'done');
    expect(h.enqueue).not.toHaveBeenCalled();
    expect(h.def.apply).toHaveBeenCalledTimes(form ? 1 : 2);
  });

  it('bounds synchronous re-entry and parks a repeated request on the decision form', async () => {
    const h = fixture();
    h.def.llm!.prepare = async () => false;
    h.def.form = () => null;
    h.def.apply = vi.fn(async () => {
      throw new ReopenStepFormError('boundary', { rerunPreForm: true } as never);
    });
    expect((await h.advance({})).status).toBe('waiting_form');
    expect(h.def.apply).toHaveBeenCalledTimes(2);
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it.each([
    'detect',
    'form',
    'preForm',
    'newAttempt',
    'loop',
    'agentMining',
    'dagExecute',
    'mergeResolve',
  ])('refuses incompatible %s before continuation writes or dispatch', async (bad) => {
    const h = fixture();
    if (bad === 'preForm') h.def.llm!.preForm = false;
    else if (bad === 'newAttempt')
      h.def.apply = async () => {
        throw new ReopenStepFormError('invalid', { rerunPreForm: true, newAttempt: true } as never);
      };
    else
      (h.def as unknown as Record<string, unknown>)[bad] = ['detect', 'form'].includes(bad)
        ? undefined
        : {};
    // Remove fan-out execution itself: request the invalid config from apply after the earlier phases.
    if (['loop', 'agentMining', 'dagExecute', 'mergeResolve'].includes(bad)) {
      delete (h.def as unknown as Record<string, unknown>)[bad];
      const apply = h.def.apply;
      h.def.apply = async (ctx, args) => {
        (h.def as unknown as Record<string, unknown>)[bad] = {};
        return apply(ctx, args);
      };
    }
    const result = await h.advance({});
    expect(result.status).toBe('failed');
    expect(result.status === 'failed' && result.error).toMatch(/rerunPreForm/);
    expect(h.enqueue).not.toHaveBeenCalled();
    expect(h.state.invocation!.consumedAt).toBeNull();
    expect(h.state.updates.some(({ patch }) => patch.pauseFormOnRetry === true)).toBe(false);
  });

  it.each(['task', 'global', 'unreadable'] as const)(
    'pause %s defers before prepare, and Resume dispatches once',
    async (scope) => {
      const h = fixture();
      if (scope === 'task') h.state.taskRow!.pausedAt = new Date();
      else if (scope === 'global') vi.mocked(configService.getBoolean).mockResolvedValue(true);
      else {
        const { ConfigUnavailableError } = await import('@haive/shared');
        vi.mocked(configService.getBoolean).mockRejectedValue(new ConfigUnavailableError('pause'));
      }
      expect((await h.advance({})).status).toBe('deferred');
      expect(h.def.llm!.prepare).not.toHaveBeenCalled();
      expect(h.state.taskStepRow).toMatchObject({
        status: 'waiting_cli',
        pauseFormOnRetry: true,
        formValues: null,
      });
      h.state.taskRow!.pausedAt = null;
      vi.mocked(configService.getBoolean).mockResolvedValue(false);
      expect((await h.advance({ stale: true })).status).toBe('waiting_cli');
      expect(h.enqueue).toHaveBeenCalledOnce();
    },
  );

  it('accepts a completed held pass while paused but defers its completePreForm follow-up', async () => {
    const h = fixture();
    await h.advance({});
    Object.assign(h.state.invocation!, { endedAt: new Date(), exitCode: 0, rawOutput: 'accepted' });
    const accept = vi.fn(async () => ({ llmOutput: 'accepted', continueRequested: true }));
    h.def.llm!.completePreForm = accept;
    h.state.taskRow!.pausedAt = new Date();
    expect((await h.advance({ stale: true })).status).toBe('deferred');
    expect(accept).toHaveBeenCalledOnce();
    expect(h.enqueue).toHaveBeenCalledOnce();
    expect(h.state.invocation!.consumedAt).toBeInstanceOf(Date);
  });

  it.each(['prepare', 'prepareWorkspace'] as const)(
    'deferral signal without a current pause in %s is a configuration failure',
    async (hook) => {
      const h = fixture();
      h.def.llm![hook] = async () => {
        const sdk = await import('@haive/shared/step');
        throw new sdk.StepPrepareDeferredError();
      };
      const result = await h.advance({});
      expect(result.status).toBe('failed');
      expect(result.status === 'failed' && result.error).toMatch(/StepPrepareDeferredError.*pause/);
      expect(h.enqueue).not.toHaveBeenCalled();
    },
  );

  it('an ordinary Retry hold cannot use continuation-only pause deferral', async () => {
    const h = fixture();
    h.state.invocation = undefined;
    Object.assign(h.state.taskStepRow, {
      status: 'waiting_cli',
      pauseFormOnRetry: true,
      formSchema: null,
      formValues: null,
    });
    h.state.taskRow!.status = 'running';
    h.state.taskRow!.pausedAt = new Date();
    h.def.llm!.prepare = async () => {
      const sdk = await import('@haive/shared/step');
      throw new sdk.StepPrepareDeferredError();
    };
    const result = await h.advance();
    expect(result.status).toBe('failed');
    expect(result.status === 'failed' && result.error).toMatch(/StepPrepareDeferredError.*held/);
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it.each(['prepare', 'prepareWorkspace'] as const)(
    'ordinary pre-form %s cannot use the pause signal',
    async (hook) => {
      const h = fixture();
      h.state.invocation = undefined;
      h.state.taskStepRow.formValues = null;
      h.state.taskStepRow.formSchema = null;
      h.state.taskStepRow.status = 'running';
      h.state.taskRow!.pausedAt = new Date();
      h.def.llm![hook] = async () => {
        const sdk = await import('@haive/shared/step');
        throw new sdk.StepPrepareDeferredError();
      };
      const result = await h.advance();
      expect(result.status).toBe('failed');
      expect(result.status === 'failed' && result.error).toMatch(/StepPrepareDeferredError.*held/);
      expect(h.enqueue).not.toHaveBeenCalled();
    },
  );

  it('a late pause after prepareWorkspace releases only the unqueued reservation even without a signal', async () => {
    const h = fixture();
    h.def.llm!.prepareWorkspace = async () => {
      h.state.taskRow!.pausedAt = new Date();
    };
    expect((await h.advance({})).status).toBe('deferred');
    expect(h.enqueue).not.toHaveBeenCalled();
    expect(h.state.invocations![0]!.supersededAt).toBeUndefined();
    expect(h.state.invocation!.supersededAt).toBeInstanceOf(Date);
  });

  it.each(['inserted', 'bound', 'enqueue-ack', 'checkpoint-ack'] as const)(
    'redelivery after lost %s never creates a second live invocation or repeats approved publication',
    async (cut) => {
      const h = fixture();
      let snapshot:
        | {
            row: Record<string, unknown>;
            task: Record<string, unknown>;
            invocation: Record<string, unknown>;
            invocations: Record<string, unknown>[];
          }
        | undefined;
      const capture = () => {
        snapshot = {
          row: persistedRow(h.state),
          task: { ...h.state.taskRow! },
          invocation: { ...h.state.invocation! },
          invocations: h.state.invocations!.map((r) => ({ ...r })),
        };
      };
      if (cut === 'checkpoint-ack')
        h.state.beforeWrite = (table, patch) => {
          if (
            table === 'task_steps' &&
            patch.detectOutput &&
            h.state.taskStepRow.pauseFormOnRetry
          ) {
            capture();
            throw new Error('process death after checkpoint');
          }
        };
      else if (cut === 'inserted' || cut === 'bound')
        h.def.llm!.prepareWorkspace = async () => {
          capture();
          throw new Error('process death before enqueue');
        };
      else
        h.enqueue.mockImplementation(async () => {
          capture();
          throw new Error('lost enqueue acknowledgement');
        });
      await h.advance({});
      expect(snapshot).toBeDefined();
      // Restore the durable cut; the dying process's catch writes did not happen.
      h.state.taskStepRow = snapshot!.row;
      h.state.taskRow = snapshot!.task;
      h.state.invocation = snapshot!.invocation;
      h.state.invocations = snapshot!.invocations;
      delete h.state.beforeWrite;
      delete h.def.llm!.prepareWorkspace;
      h.enqueue.mockImplementation(async () => {});
      expect((await h.advance({ stale: true })).status).toBe('waiting_cli');
      expect(h.def.apply).toHaveBeenCalledOnce();
      expect(
        h.state.invocations!.filter((r) => r.endedAt === null && !r.supersededAt),
      ).toHaveLength(1);
      expect(h.enqueue).toHaveBeenCalledTimes(
        cut === 'enqueue-ack' ? 1 : cut === 'checkpoint-ack' ? 1 : 0,
      );
      expect(h.state.taskStepRow.formValues).toBeNull();
    },
  );

  it.each(['prepare', 'prepareWorkspace'] as const)(
    'canonical pause race from %s yields and releases only its unqueued reservation',
    async (hook) => {
      const h = fixture();
      h.def.llm![hook] = async () => {
        h.state.taskRow!.pausedAt = new Date();
        const sdk = await import('@haive/shared/step');
        throw new (
          sdk as unknown as { StepPrepareDeferredError: new () => Error }
        ).StepPrepareDeferredError();
      };
      expect((await h.advance({})).status).toBe('deferred');
      expect(h.enqueue).not.toHaveBeenCalled();
      if (hook === 'prepareWorkspace')
        expect(h.state.invocation!.supersededAt).toBeInstanceOf(Date);
      expect(h.state.taskStepRow).toMatchObject({ status: 'waiting_cli', pauseFormOnRetry: true });
      delete h.def.llm![hook];
      h.state.taskRow!.pausedAt = null;
      expect((await h.advance()).status).toBe('waiting_cli');
      expect(h.enqueue).toHaveBeenCalledOnce();
    },
  );
});
