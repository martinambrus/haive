import { describe, expect, it } from 'vitest';
import type { Database } from '@haive/database';
import type { CliExecJobPayload } from '@haive/shared';
import { advanceStep } from '../src/step-engine/step-runner.js';
import type {
  StepDefinition,
  StepLoopShouldContinueArgs,
} from '../src/step-engine/step-definition.js';
import type { CliProviderRecord } from '../src/cli-adapters/types.js';
import { OUTPUT_TRUNCATION_HEADLINE } from '../src/queues/cli-exec/failure-class.js';
import { skillGenerationStep } from '../src/step-engine/steps/onboarding/09_5-skill-generation.js';
import { testManagementStep } from '../src/step-engine/steps/workflow/08b-test-management.js';

interface CliInvocationMockRow {
  id: string;
  taskId: string;
  taskStepId: string;
  cliProviderId: string | null;
  mode: string;
  prompt: string;
  rawOutput: string | null;
  parsedOutput: unknown;
  exitCode: number | null;
  errorMessage: string | null;
  createdAt: Date;
  endedAt: Date | null;
  supersededAt: Date | null;
  consumedAt: Date | null;
}

interface MockState {
  taskStepRow: Record<string, unknown>;
  cliInvocationRows: CliInvocationMockRow[];
  taskRow: { id: string; stepLoopLimits: Record<string, number> | null } | null;
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
        // Every row of the table, for the un-limited/un-ordered form of the query.
        const allRows = async () => {
          if (tableName === 'cli_invocations') {
            return state.cliInvocationRows.filter(
              (r) => r.supersededAt === null && r.mode !== 'agent_mining',
            );
          }
          return tableName === 'task_steps' && state.taskStepRow.id ? [state.taskStepRow] : [];
        };
        return {
          where: (_cond: unknown) => ({
            // Drizzle's query builder is a thenable: awaiting .where() directly, with no
            // .limit()/.orderBy(), runs the query. learnedTimeoutMs does exactly that.
            then: (onOk: (r: unknown) => unknown, onErr?: (e: unknown) => unknown) =>
              allRows().then(onOk, onErr),
            limit: async (_n: number) => {
              if (tableName === 'task_steps') {
                return state.taskStepRow.id ? [state.taskStepRow] : [];
              }
              return [];
            },
            orderBy: (_o: unknown) => ({
              limit: async (_n: number) => {
                if (tableName === 'cli_invocations') {
                  // Mirror runner's filter: latest non-superseded,
                  // non-consumed, non-agent_mining row by createdAt desc.
                  const filtered = state.cliInvocationRows
                    .filter(
                      (r) =>
                        r.supersededAt === null &&
                        r.consumedAt === null &&
                        r.mode !== 'agent_mining',
                    )
                    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
                  if (_n > 1) {
                    return state.cliInvocationRows
                      .filter((r) => r.supersededAt === null && r.mode !== 'agent_mining')
                      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
                      .slice(0, _n);
                  }
                  if (cols && filtered[0]) {
                    return [{ id: filtered[0].id }];
                  }
                  return filtered.slice(0, 1);
                }
                return [];
              },
            }),
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
              return [row];
            }
            if (tableName === 'cli_invocations') {
              const inv: CliInvocationMockRow = {
                id,
                taskId: String(v.taskId ?? ''),
                taskStepId: String(v.taskStepId ?? ''),
                cliProviderId: (v.cliProviderId as string | null) ?? null,
                mode: String(v.mode ?? 'cli'),
                prompt: String(v.prompt ?? ''),
                rawOutput: null,
                parsedOutput: null,
                exitCode: null,
                errorMessage: null,
                createdAt: new Date(),
                endedAt: null,
                supersededAt: null,
                consumedAt: null,
              };
              state.cliInvocationRows.push(inv);
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
          where: (_: unknown) => {
            if (tableName === 'cli_invocations') {
              // markLatestInvocationConsumed update path. No .returning().
              // The runner only awaits the chain so we resolve a Promise here.
              state.updates.push({ table: tableName, patch: v });
              if (v.consumedAt) {
                const target = state.cliInvocationRows
                  .filter((r) => r.consumedAt === null && r.supersededAt === null)
                  .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
                if (target) target.consumedAt = v.consumedAt as Date;
              }
              return Promise.resolve(undefined);
            }
            return {
              returning: async () => {
                state.updates.push({ table: tableName, patch: v });
                if (tableName === 'task_steps') {
                  state.taskStepRow = { ...state.taskStepRow, ...v };
                  return [state.taskStepRow];
                }
                return [];
              },
            };
          },
        }),
      };
    },
    query: {
      userStepCliPreferences: { findFirst: async () => undefined },
      taskStepCliChoices: { findFirst: async () => undefined },
      tasks: {
        findFirst: async () => state.taskRow ?? undefined,
      },
      taskSteps: { findFirst: async () => undefined },
      // resolveTaskDispatch resolves the invocation's MCP surface so the prompt can
      // state it; that reads the env template and the repo onboarding mirror.
      envTemplates: { findFirst: async () => undefined },
      repositories: { findFirst: async () => undefined },
    },
  } as unknown as Database;
  return db;
}

function freshState(): MockState {
  return {
    taskStepRow: {
      id: 'ts-1',
      taskId: 'task-1',
      stepId: 'loop-step',
      stepIndex: 0,
      title: 'loop step',
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
    cliInvocationRows: [],
    taskRow: null,
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

interface LoopStepOpts {
  maxIterations: number;
  shouldContinue: (args: StepLoopShouldContinueArgs) => boolean | Promise<boolean>;
  applyReturns?: (iter: number) => unknown;
  buildIterationPrompt?: boolean;
  iterationPromptCoversFirstPass?: boolean;
  passLabel?: (iteration: number) => string | null;
}

function loopStep(opts: LoopStepOpts): StepDefinition {
  return {
    metadata: {
      id: 'loop-step',
      workflowType: 'workflow',
      index: 0,
      title: 'loop step',
      description: 'loop step',
      requiresCli: true,
    },
    async detect() {
      return { ready: true };
    },
    form() {
      return null;
    },
    llm: {
      requiredCapabilities: [],
      buildPrompt: (a) => `base prompt ${JSON.stringify(a.detected)}`,
    },
    loop: {
      maxIterations: opts.maxIterations,
      shouldContinue: opts.shouldContinue,
      ...(opts.buildIterationPrompt
        ? {
            buildIterationPrompt: (a) =>
              `iter=${a.iteration} prev=${a.previousIterations.length} trunc=${a.truncationRetries}`,
          }
        : {}),
      ...(opts.iterationPromptCoversFirstPass ? { iterationPromptCoversFirstPass: true } : {}),
      ...(opts.passLabel ? { passLabel: opts.passLabel } : {}),
    },
    async apply(_ctx, args) {
      return opts.applyReturns
        ? opts.applyReturns(args.iteration)
        : { iter: args.iteration, llm: args.llmOutput };
    },
  };
}

/** Simulate the worker completing a CLI invocation: set parsedOutput +
 *  endedAt + exitCode=0 on the latest open invocation. */
function completeLatestInvocation(state: MockState, parsedOutput: unknown): void {
  const open = state.cliInvocationRows
    .filter((r) => r.endedAt === null && r.consumedAt === null)
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
  if (!open) throw new Error('no open invocation to complete');
  open.endedAt = new Date();
  open.exitCode = 0;
  open.parsedOutput = parsedOutput;
  open.rawOutput = JSON.stringify(parsedOutput);
}

const TRUNCATION_NOTICE =
  'Your previous attempt was cut off at the output-token limit. Keep each reply and each tool call smaller (write a large file in several edits, keep prose brief), but include every required item and field.';

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

function retryingStep(): StepDefinition {
  const step = loopStep({ maxIterations: 1, shouldContinue: () => false });
  const { loop: _loop, ...rest } = step;
  return { ...rest, llm: { ...step.llm!, retry: { maxAttempts: 3 } } };
}

async function dispatchNonLoop(errorMessage: string | null): Promise<string> {
  const state = freshState();
  state.taskStepRow = {
    ...state.taskStepRow,
    status: errorMessage === null ? 'pending' : 'waiting_cli',
    detectOutput: { ready: true },
    formValues: {},
  };
  state.cliInvocationRows =
    errorMessage === null
      ? []
      : [
          {
            id: 'inv-0',
            taskId: 'task-1',
            taskStepId: 'ts-1',
            cliProviderId: 'prov-1',
            mode: 'cli',
            prompt: 'p',
            rawOutput: null,
            parsedOutput: null,
            exitCode: 1,
            errorMessage,
            createdAt: new Date(Date.now() - 1000),
            endedAt: new Date(),
            supersededAt: null,
            consumedAt: null,
          },
        ];
  const result = await advanceStep({
    db: makeMockDb(state),
    taskId: 'task-1',
    userId: 'user-1',
    repoPath: '/tmp',
    workspacePath: '/tmp',
    cliProviderId: 'prov-1',
    stepDef: retryingStep(),
    providers: [makeProvider()],
    deps: { async enqueueCliInvocation() {} },
  });
  expect(result.status).toBe('waiting_cli');
  const inserted = state.inserts.filter((i) => i.table === 'cli_invocations');
  expect(inserted).toHaveLength(1);
  return String(inserted[0]!.row.prompt);
}

function plainStep(): StepDefinition {
  const { loop: _loop, ...rest } = loopStep({ maxIterations: 1, shouldContinue: () => false });
  return rest;
}

/** The step has just been told its newest call was cut off, with `earlier` truncated calls
 *  before it (oldest first); returns what the runner did. */
async function advanceAfterTruncations(stepDef: StepDefinition, earlier: number) {
  const state = freshState();
  state.taskStepRow = {
    ...state.taskStepRow,
    status: 'waiting_cli',
    detectOutput: { ready: true },
    formValues: {},
  };
  state.cliInvocationRows = Array.from({ length: earlier + 1 }, (_, i) => ({
    id: `inv-${i}`,
    taskId: 'task-1',
    taskStepId: 'ts-1',
    cliProviderId: 'prov-1',
    mode: 'cli',
    prompt: 'p',
    rawOutput: null,
    parsedOutput: null,
    exitCode: 1,
    errorMessage: `${OUTPUT_TRUNCATION_HEADLINE} — cut off`,
    createdAt: new Date(Date.now() - (earlier + 1 - i) * 1000),
    endedAt: new Date(),
    supersededAt: null,
    consumedAt: i < earlier ? new Date() : null,
  }));
  const result = await advanceStep({
    db: makeMockDb(state),
    taskId: 'task-1',
    userId: 'user-1',
    repoPath: '/tmp',
    workspacePath: '/tmp',
    cliProviderId: 'prov-1',
    stepDef,
    providers: [makeProvider()],
    deps: { async enqueueCliInvocation() {} },
  });
  return { result, inserts: state.inserts.filter((i) => i.table === 'cli_invocations') };
}

describe('advanceStep loop hook', () => {
  describe('a truncation of a step that is neither a loop nor declares llm.retry', () => {
    it('is retried once, with the cut-off notice on the new prompt', async () => {
      const { result, inserts } = await advanceAfterTruncations(plainStep(), 0);
      expect(result.status).toBe('waiting_cli');
      expect(inserts).toHaveLength(1);
      const prompt = String(inserts[0]!.row.prompt);
      expect(prompt).toContain('base prompt');
      expect(prompt.endsWith(TRUNCATION_NOTICE)).toBe(true);
    });

    it('fails the step when the retry is cut off as well', async () => {
      const { result, inserts } = await advanceAfterTruncations(plainStep(), 1);
      expect(result.status).toBe('failed');
      expect(inserts).toHaveLength(0);
    });
  });

  describe('a truncation of a step that declares llm.retry', () => {
    it('keeps its own attempts bound, whatever the one-retry stance of the others', async () => {
      const retried = await advanceAfterTruncations(retryingStep(), 1);
      expect(retried.result.status).toBe('waiting_cli');
      expect(retried.inserts).toHaveLength(1);
      const spent = await advanceAfterTruncations(retryingStep(), 2);
      expect(spent.result.status).toBe('failed');
      expect(spent.inserts).toHaveLength(0);
    });
  });

  describe('a truncation of a loop step', () => {
    const looping = () => loopStep({ maxIterations: 3, shouldContinue: () => true });

    it('is re-dispatched a third time, so the third shrink is reached', async () => {
      const { result, inserts } = await advanceAfterTruncations(looping(), 2);
      expect(result.status).toBe('waiting_cli');
      expect(inserts).toHaveLength(1);
    });

    it('fails the step once the third re-dispatch is cut off too', async () => {
      const { result, inserts } = await advanceAfterTruncations(looping(), 3);
      expect(result.status).toBe('failed');
      expect(inserts).toHaveLength(0);
    });
  });

  describe('a truncation retry of a loop step', () => {
    async function retryTruncated(opts: {
      coversFirstPass: boolean;
      priorPasses: number;
    }): Promise<string> {
      const state = freshState();
      state.taskStepRow = {
        ...state.taskStepRow,
        status: 'waiting_cli',
        detectOutput: { ready: true },
        formValues: {},
        iterations: Array.from({ length: opts.priorPasses }, (_, i) => ({
          iteration: i,
          continueRequested: true,
        })),
      };
      state.cliInvocationRows = [
        {
          id: 'inv-0',
          taskId: 'task-1',
          taskStepId: 'ts-1',
          cliProviderId: 'prov-1',
          mode: 'cli',
          prompt: 'p',
          rawOutput: null,
          parsedOutput: null,
          exitCode: 1,
          errorMessage: `${OUTPUT_TRUNCATION_HEADLINE} — cut off`,
          createdAt: new Date(Date.now() - 1000),
          endedAt: new Date(),
          supersededAt: null,
          consumedAt: null,
        },
      ];
      const result = await advanceStep({
        db: makeMockDb(state),
        taskId: 'task-1',
        userId: 'user-1',
        repoPath: '/tmp',
        workspacePath: '/tmp',
        cliProviderId: 'prov-1',
        stepDef: loopStep({
          maxIterations: 3,
          shouldContinue: () => false,
          buildIterationPrompt: true,
          iterationPromptCoversFirstPass: opts.coversFirstPass,
        }),
        providers: [makeProvider()],
        deps: { async enqueueCliInvocation() {} },
      });
      expect(result.status).toBe('waiting_cli');
      const inserted = state.inserts.filter((i) => i.table === 'cli_invocations');
      expect(inserted).toHaveLength(1);
      return String(inserted[0]!.row.prompt);
    }

    it('gives the first pass of a step whose iteration builder assumes an earlier pass its own prompt', async () => {
      const prompt = await retryTruncated({ coversFirstPass: false, priorPasses: 0 });
      expect(prompt).toContain('base prompt');
      expect(prompt).not.toContain('iter=');
    });

    it('gives the first pass of a step whose iteration builder covers it the iteration prompt with the retry count', async () => {
      const prompt = await retryTruncated({ coversFirstPass: true, priorPasses: 0 });
      expect(prompt).toContain('iter=0 prev=0 trunc=1');
    });

    it.each([false, true])(
      'routes a later pass through the iteration builder whatever the flag (%s)',
      async (coversFirstPass) => {
        const prompt = await retryTruncated({ coversFirstPass, priorPasses: 1 });
        expect(prompt).toContain('iter=1 prev=1 trunc=1');
      },
    );

    it('tells the agent its last reply was cut off, and still hands the builder the retry count', async () => {
      const prompt = await retryTruncated({ coversFirstPass: true, priorPasses: 0 });
      expect(prompt).toContain('iter=0 prev=0 trunc=1');
      expect(countOccurrences(prompt, TRUNCATION_NOTICE)).toBe(1);
    });

    it('is declared by 09_5 and not by 08b', () => {
      expect(skillGenerationStep.loop?.iterationPromptCoversFirstPass).toBe(true);
      expect(testManagementStep.loop?.buildIterationPrompt).toBeDefined();
      expect(testManagementStep.loop?.iterationPromptCoversFirstPass).toBeUndefined();
    });
  });

  describe('a truncation retry of a step that is not a loop', () => {
    it('resends the prompt with the cut-off notice once', async () => {
      const prompt = await dispatchNonLoop(`${OUTPUT_TRUNCATION_HEADLINE} — cut off`);
      expect(prompt).toContain('base prompt');
      expect(countOccurrences(prompt, TRUNCATION_NOTICE)).toBe(1);
    });

    it('leaves the prompt without the notice when no call was cut off', async () => {
      const prompt = await dispatchNonLoop(null);
      expect(prompt).toContain('base prompt');
      expect(prompt).not.toContain('cut off at the output-token limit');
    });
  });

  it('finishes after one pass when shouldContinue returns false', async () => {
    const state = freshState();
    state.taskStepRow = {
      ...state.taskStepRow,
      status: 'waiting_cli',
      detectOutput: { ready: true },
      formValues: {},
    };
    state.cliInvocationRows = [
      {
        id: 'inv-0',
        taskId: 'task-1',
        taskStepId: 'ts-1',
        cliProviderId: 'prov-1',
        mode: 'cli',
        prompt: 'p',
        rawOutput: 'r',
        parsedOutput: { score: 10 },
        exitCode: 0,
        errorMessage: null,
        createdAt: new Date(),
        endedAt: new Date(),
        supersededAt: null,
        consumedAt: null,
      },
    ];
    const db = makeMockDb(state);
    const result = await advanceStep({
      db,
      taskId: 'task-1',
      userId: 'user-1',
      repoPath: '/tmp',
      workspacePath: '/tmp',
      cliProviderId: 'prov-1',
      stepDef: loopStep({ maxIterations: 5, shouldContinue: () => false }),
      providers: [makeProvider()],
      deps: {
        async enqueueCliInvocation() {
          throw new Error('should not enqueue when shouldContinue=false');
        },
      },
    });
    expect(result.status).toBe('done');
    // Iteration 0 recorded; consumed; only 1 entry in iterations.
    const iterations = state.taskStepRow.iterations as Array<{
      iteration: number;
      continueRequested: boolean;
      exhaustedBudget?: boolean;
    }> | null;
    expect(iterations).toHaveLength(1);
    expect(iterations![0]!.iteration).toBe(0);
    expect(iterations![0]!.continueRequested).toBe(false);
    expect(iterations![0]!.exhaustedBudget).toBeUndefined();
    expect(state.cliInvocationRows[0]!.consumedAt).not.toBeNull();
  });

  it('enqueues a fresh invocation and re-enters waiting_cli when shouldContinue=true with budget left', async () => {
    const state = freshState();
    state.taskStepRow = {
      ...state.taskStepRow,
      status: 'waiting_cli',
      detectOutput: { ready: true },
      formValues: {},
    };
    state.cliInvocationRows = [
      {
        id: 'inv-0',
        taskId: 'task-1',
        taskStepId: 'ts-1',
        cliProviderId: 'prov-1',
        mode: 'cli',
        prompt: 'p',
        rawOutput: 'r',
        parsedOutput: { findings: ['err'] },
        exitCode: 0,
        errorMessage: null,
        createdAt: new Date(Date.now() - 1000),
        endedAt: new Date(),
        supersededAt: null,
        consumedAt: null,
      },
    ];
    const db = makeMockDb(state);
    const enqueued: CliExecJobPayload[] = [];
    const result = await advanceStep({
      db,
      taskId: 'task-1',
      userId: 'user-1',
      repoPath: '/tmp',
      workspacePath: '/tmp',
      cliProviderId: 'prov-1',
      stepDef: loopStep({
        maxIterations: 3,
        shouldContinue: (a) => a.iteration === 0,
        buildIterationPrompt: true,
      }),
      providers: [makeProvider()],
      deps: {
        async enqueueCliInvocation(p) {
          enqueued.push(p);
        },
      },
    });
    expect(result.status).toBe('waiting_cli');
    expect(enqueued).toHaveLength(1);
    // Original invocation now consumed, new one inserted, total = 2 rows.
    expect(state.cliInvocationRows).toHaveLength(2);
    expect(state.cliInvocationRows[0]!.consumedAt).not.toBeNull();
    expect(state.cliInvocationRows[1]!.consumedAt).toBeNull();
    // Iteration 0 already recorded with continueRequested=true, no exhausted flag.
    const iterations = state.taskStepRow.iterations as Array<{
      iteration: number;
      continueRequested: boolean;
      exhaustedBudget?: boolean;
    }>;
    expect(iterations).toHaveLength(1);
    expect(iterations[0]!.continueRequested).toBe(true);
    expect(iterations[0]!.exhaustedBudget).toBeUndefined();
    // The new invocation's prompt comes from buildIterationPrompt.
    const inserted = state.inserts.find((i) => i.table === 'cli_invocations');
    expect(inserted!.row.prompt).toContain('iter=1 prev=1');
  });

  it('titles each pass from loop.passLabel so one loop step does not render N identical terminals', async () => {
    // Pass 0: nothing run yet, so the FIRST dispatch has to carry the label too — a
    // loop whose passes share one provider has no cliRoles entry to fall back on.
    const first = freshState();
    first.taskStepRow = { ...first.taskStepRow, status: 'pending' };
    await advanceStep({
      db: makeMockDb(first),
      taskId: 'task-1',
      userId: 'user-1',
      repoPath: '/tmp',
      workspacePath: '/tmp',
      cliProviderId: 'prov-1',
      stepDef: loopStep({
        maxIterations: 3,
        shouldContinue: () => false,
        passLabel: (i) => (i === 0 ? 'Test writer' : `Test fixer ${i}`),
      }),
      providers: [makeProvider()],
      deps: {
        async enqueueCliInvocation() {},
      },
    });
    const firstInsert = first.inserts.find((i) => i.table === 'cli_invocations');
    expect(firstInsert!.row.agentTitle).toBe('Test writer');

    // Pass 1: the re-dispatch after a completed iteration 0 gets the fix label.
    const state = freshState();
    state.taskStepRow = {
      ...state.taskStepRow,
      status: 'waiting_cli',
      detectOutput: { ready: true },
      formValues: {},
    };
    state.cliInvocationRows = [
      {
        id: 'inv-0',
        taskId: 'task-1',
        taskStepId: 'ts-1',
        cliProviderId: 'prov-1',
        mode: 'cli',
        prompt: 'p',
        rawOutput: 'r',
        parsedOutput: { findings: ['err'] },
        exitCode: 0,
        errorMessage: null,
        createdAt: new Date(Date.now() - 1000),
        endedAt: new Date(),
        supersededAt: null,
        consumedAt: null,
      },
    ];
    await advanceStep({
      db: makeMockDb(state),
      taskId: 'task-1',
      userId: 'user-1',
      repoPath: '/tmp',
      workspacePath: '/tmp',
      cliProviderId: 'prov-1',
      stepDef: loopStep({
        maxIterations: 3,
        shouldContinue: (a) => a.iteration === 0,
        passLabel: (i) => (i === 0 ? 'Test writer' : `Test fixer ${i}`),
      }),
      providers: [makeProvider()],
      deps: {
        async enqueueCliInvocation() {},
      },
    });
    const inserted = state.inserts.find((i) => i.table === 'cli_invocations');
    expect(inserted!.row.agentTitle).toBe('Test fixer 1');
  });

  it('leaves agentTitle null for a loop step that declares no passLabel', async () => {
    const state = freshState();
    state.taskStepRow = { ...state.taskStepRow, status: 'pending' };
    await advanceStep({
      db: makeMockDb(state),
      taskId: 'task-1',
      userId: 'user-1',
      repoPath: '/tmp',
      workspacePath: '/tmp',
      cliProviderId: 'prov-1',
      stepDef: loopStep({ maxIterations: 3, shouldContinue: () => false }),
      providers: [makeProvider()],
      deps: {
        async enqueueCliInvocation() {},
      },
    });
    const inserted = state.inserts.find((i) => i.table === 'cli_invocations');
    expect(inserted!.row.agentTitle).toBeNull();
  });

  it('marks last entry exhaustedBudget=true and finishes when budget caps the loop', async () => {
    // maxIterations=1 + shouldContinue=true means iteration 0 wants to
    // continue but the next iteration (1) >= budget (1), so the runner
    // must set exhaustedBudget and finish without enqueuing.
    const state = freshState();
    state.taskStepRow = {
      ...state.taskStepRow,
      status: 'waiting_cli',
      detectOutput: { ready: true },
      formValues: {},
    };
    state.cliInvocationRows = [
      {
        id: 'inv-0',
        taskId: 'task-1',
        taskStepId: 'ts-1',
        cliProviderId: 'prov-1',
        mode: 'cli',
        prompt: 'p',
        rawOutput: 'r',
        parsedOutput: { findings: ['still bad'] },
        exitCode: 0,
        errorMessage: null,
        createdAt: new Date(),
        endedAt: new Date(),
        supersededAt: null,
        consumedAt: null,
      },
    ];
    const db = makeMockDb(state);
    const result = await advanceStep({
      db,
      taskId: 'task-1',
      userId: 'user-1',
      repoPath: '/tmp',
      workspacePath: '/tmp',
      cliProviderId: 'prov-1',
      stepDef: loopStep({ maxIterations: 1, shouldContinue: () => true }),
      providers: [makeProvider()],
      deps: {
        async enqueueCliInvocation() {
          throw new Error('should not enqueue when budget exhausted');
        },
      },
    });
    expect(result.status).toBe('done');
    const iterations = state.taskStepRow.iterations as Array<{
      iteration: number;
      continueRequested: boolean;
      exhaustedBudget?: boolean;
    }>;
    expect(iterations).toHaveLength(1);
    expect(iterations[0]!.continueRequested).toBe(true);
    expect(iterations[0]!.exhaustedBudget).toBe(true);
    expect(state.cliInvocationRows).toHaveLength(1); // no new row enqueued
  });

  it('honors task.stepLoopLimits override over the loopSpec default', async () => {
    // Spec default is 5 but task says 1 → exhaust on first pass.
    const state = freshState();
    state.taskRow = { id: 'task-1', stepLoopLimits: { 'loop-step': 1 } };
    state.taskStepRow = {
      ...state.taskStepRow,
      status: 'waiting_cli',
      detectOutput: { ready: true },
      formValues: {},
    };
    state.cliInvocationRows = [
      {
        id: 'inv-0',
        taskId: 'task-1',
        taskStepId: 'ts-1',
        cliProviderId: 'prov-1',
        mode: 'cli',
        prompt: 'p',
        rawOutput: 'r',
        parsedOutput: { findings: ['bad'] },
        exitCode: 0,
        errorMessage: null,
        createdAt: new Date(),
        endedAt: new Date(),
        supersededAt: null,
        consumedAt: null,
      },
    ];
    const db = makeMockDb(state);
    const result = await advanceStep({
      db,
      taskId: 'task-1',
      userId: 'user-1',
      repoPath: '/tmp',
      workspacePath: '/tmp',
      cliProviderId: 'prov-1',
      stepDef: loopStep({ maxIterations: 5, shouldContinue: () => true }),
      providers: [makeProvider()],
      deps: {
        async enqueueCliInvocation() {
          throw new Error('should not enqueue when task.stepLoopLimits caps to 1');
        },
      },
    });
    expect(result.status).toBe('done');
    const iterations = state.taskStepRow.iterations as Array<{
      exhaustedBudget?: boolean;
    }>;
    expect(iterations[0]!.exhaustedBudget).toBe(true);
  });

  it('honors formValues.maxIterations over both task limits and spec default', async () => {
    // Spec default 5, task limit 4, formValues 1 → form override wins.
    const state = freshState();
    state.taskRow = { id: 'task-1', stepLoopLimits: { 'loop-step': 4 } };
    state.taskStepRow = {
      ...state.taskStepRow,
      status: 'waiting_cli',
      detectOutput: { ready: true },
      formValues: { maxIterations: 1 },
    };
    state.cliInvocationRows = [
      {
        id: 'inv-0',
        taskId: 'task-1',
        taskStepId: 'ts-1',
        cliProviderId: 'prov-1',
        mode: 'cli',
        prompt: 'p',
        rawOutput: 'r',
        parsedOutput: { findings: ['bad'] },
        exitCode: 0,
        errorMessage: null,
        createdAt: new Date(),
        endedAt: new Date(),
        supersededAt: null,
        consumedAt: null,
      },
    ];
    const db = makeMockDb(state);
    const result = await advanceStep({
      db,
      taskId: 'task-1',
      userId: 'user-1',
      repoPath: '/tmp',
      workspacePath: '/tmp',
      cliProviderId: 'prov-1',
      stepDef: loopStep({ maxIterations: 5, shouldContinue: () => true }),
      providers: [makeProvider()],
      deps: {
        async enqueueCliInvocation() {
          throw new Error('should not enqueue when formValues.maxIterations=1');
        },
      },
    });
    expect(result.status).toBe('done');
    const iterations = state.taskStepRow.iterations as Array<{
      exhaustedBudget?: boolean;
    }>;
    expect(iterations[0]!.exhaustedBudget).toBe(true);
  });

  it('parses formValues.maxIterations supplied as a string (HTML <select> emits strings)', async () => {
    const state = freshState();
    state.taskStepRow = {
      ...state.taskStepRow,
      status: 'waiting_cli',
      detectOutput: { ready: true },
      formValues: { maxIterations: '1' },
    };
    state.cliInvocationRows = [
      {
        id: 'inv-0',
        taskId: 'task-1',
        taskStepId: 'ts-1',
        cliProviderId: 'prov-1',
        mode: 'cli',
        prompt: 'p',
        rawOutput: 'r',
        parsedOutput: {},
        exitCode: 0,
        errorMessage: null,
        createdAt: new Date(),
        endedAt: new Date(),
        supersededAt: null,
        consumedAt: null,
      },
    ];
    const db = makeMockDb(state);
    const result = await advanceStep({
      db,
      taskId: 'task-1',
      userId: 'user-1',
      repoPath: '/tmp',
      workspacePath: '/tmp',
      cliProviderId: 'prov-1',
      stepDef: loopStep({ maxIterations: 10, shouldContinue: () => true }),
      providers: [makeProvider()],
      deps: {
        async enqueueCliInvocation() {
          throw new Error('should not enqueue: form override "1" should cap');
        },
      },
    });
    expect(result.status).toBe('done');
    const iterations = state.taskStepRow.iterations as Array<{ exhaustedBudget?: boolean }>;
    expect(iterations[0]!.exhaustedBudget).toBe(true);
  });

  it('completes a 2-iteration loop end-to-end (resume after each CLI completion)', async () => {
    // Pass 1: shouldContinue=true → enqueue iter 1.
    // Pass 2: shouldContinue=false → done.
    const state = freshState();
    state.taskStepRow = {
      ...state.taskStepRow,
      status: 'waiting_cli',
      detectOutput: { ready: true },
      formValues: {},
    };
    state.cliInvocationRows = [
      {
        id: 'inv-0',
        taskId: 'task-1',
        taskStepId: 'ts-1',
        cliProviderId: 'prov-1',
        mode: 'cli',
        prompt: 'p',
        rawOutput: 'r',
        parsedOutput: { v: 0 },
        exitCode: 0,
        errorMessage: null,
        createdAt: new Date(Date.now() - 5000),
        endedAt: new Date(),
        supersededAt: null,
        consumedAt: null,
      },
    ];
    const db = makeMockDb(state);
    const enqueued: CliExecJobPayload[] = [];
    const stepDef = loopStep({
      maxIterations: 3,
      shouldContinue: (a) => a.iteration === 0,
    });
    const params = {
      db,
      taskId: 'task-1',
      userId: 'user-1',
      repoPath: '/tmp',
      workspacePath: '/tmp',
      cliProviderId: 'prov-1',
      stepDef,
      providers: [makeProvider()],
      deps: {
        async enqueueCliInvocation(p: CliExecJobPayload) {
          enqueued.push(p);
        },
      },
    };
    const r1 = await advanceStep(params);
    expect(r1.status).toBe('waiting_cli');
    expect(state.cliInvocationRows).toHaveLength(2);

    // Worker completes iter 1's invocation off-band.
    completeLatestInvocation(state, { v: 1 });

    const r2 = await advanceStep(params);
    expect(r2.status).toBe('done');
    const iterations = state.taskStepRow.iterations as Array<{
      iteration: number;
      continueRequested: boolean;
    }>;
    expect(iterations).toHaveLength(2);
    expect(iterations.map((i) => i.iteration)).toEqual([0, 1]);
    expect(iterations[0]!.continueRequested).toBe(true);
    expect(iterations[1]!.continueRequested).toBe(false);
    // Both invocations now consumed — first by pass 1 prep, second by pass 2.
    expect(state.cliInvocationRows.every((r) => r.consumedAt !== null)).toBe(true);
  });
});
