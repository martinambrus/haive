import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Database } from '@haive/database';
import type { StepDefinition } from '../src/step-engine/step-definition.js';
import type { CliProviderRecord } from '../src/cli-adapters/types.js';

// The park marker (`waiting_started_at`) records the gap between a CLI invocation ending and the
// step being re-driven, so that gap bills as idle. advanceStep used to fold it only on the
// pending -> running flip, so a step resuming from `waiting_cli` — the normal CLI continuation —
// carried a LIVE marker all the way to its `ended_at` stamp. computeStepContribution counts an
// open wait only while `ended_at` is null, so stamping it silently reclassified the whole
// dispatch gap from idle back into WORK (observed: 23min of a wedged advance queue billed as
// work on 11-final-review). These tests pin the fold to the resume for both entry statuses.
//
// The module is mocked rather than asserted through the DB on purpose: foldCliParkOnResume awaits
// `update().set().where()` directly, with no `.returning()`, so the mock-DB shape used by the
// other step-runner tests would swallow the call and let a broken implementation pass.
vi.mock('../src/queues/cli-park-timing.js', () => ({
  foldCliParkOnResume: vi.fn(async () => {}),
  markCliParkBegin: vi.fn(async () => {}),
  foldAbandonedPark: vi.fn(async () => {}),
  foldOtherTaskParks: vi.fn(async () => {}),
  foldOrphanedCliParkOnBoot: vi.fn(async () => {}),
}));

const { foldCliParkOnResume } = await import('../src/queues/cli-park-timing.js');
const { advanceStep } = await import('../src/step-engine/step-runner.js');

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
  const db = {
    // `where()` is both awaitable and chainable: callers here end in `.limit()`, `.orderBy()`
    // or a bare await (writeStepContextUsage), and a shape that only answers one of those makes
    // the others throw into a best-effort catch, which reads as a passing test with a stack
    // trace in the output.
    select: () => ({
      from: (table: unknown) => {
        const rows = tableNameOf(table) === 'task_steps' ? [state.taskStepRow] : [];
        return {
          where: () => {
            const chain = Promise.resolve(rows) as Promise<unknown[]> & Record<string, unknown>;
            chain.limit = async () => rows;
            chain.orderBy = () => ({ limit: async () => rows });
            return chain;
          },
        };
      },
    }),
    update: (table: unknown) => ({
      set: (v: Record<string, unknown>) => ({
        where: () => ({
          returning: async () => {
            state.updates.push({ table: tableNameOf(table), patch: v });
            state.taskStepRow = { ...state.taskStepRow, ...v };
            return [state.taskStepRow];
          },
        }),
      }),
    }),
    // One object satisfies both callers: the cancel poller reads `status`, the form phase reads
    // autoContinue/preAnswers/repositoryId/type. The mock ignores the `columns` projection.
    query: {
      tasks: {
        findFirst: async () => ({
          id: 'task-1',
          status: 'running',
          autoContinue: true,
          preAnswers: {},
          repositoryId: null,
          type: 'env_replicate',
        }),
      },
      cliInvocations: { findFirst: async () => undefined },
    },
  } as unknown as Database;
  return db;
}

function makeProvider(): CliProviderRecord {
  return {
    id: 'prov-1',
    userId: 'user-1',
    name: 'claude-code',
    label: 'Claude Code',
    executablePath: '/usr/bin/claude',
    authMode: 'subscription',
    enabled: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as CliProviderRecord;
}

/** Formless, LLM-less step: reaches apply() without needing a form submit or an invocation. */
function applyingStep(): StepDefinition {
  return {
    metadata: {
      id: 'park-step',
      workflowType: 'env_replicate',
      index: 0,
      title: 'park step',
      description: 'park step',
      requiresCli: false,
    },
    async apply() {
      return { ok: true };
    },
  } as unknown as StepDefinition;
}

function runParams(state: MockState) {
  return {
    db: makeMockDb(state),
    taskId: 'task-1',
    userId: 'user-1',
    repoPath: '/tmp',
    workspacePath: '/tmp',
    cliProviderId: null,
    stepDef: applyingStep(),
    providers: [makeProvider()],
    runSeq: 0, // non-null so upsertRow returns the row as-is (no self-heal update)
    deps: {
      async enqueueCliInvocation() {
        throw new Error('no CLI invocation expected');
      },
    },
  };
}

function stepRow(status: string, parked: boolean): Record<string, unknown> {
  return {
    id: 'ts-1',
    taskId: 'task-1',
    stepId: 'park-step',
    stepIndex: 0,
    round: 0,
    runSeq: 0,
    status,
    output: null,
    formSchema: null,
    formValues: null,
    detectOutput: { ready: true },
    iterations: [],
    iterationCount: 0,
    idleMs: 0,
    userActiveMs: 0,
    carriedWorkMs: 0,
    carriedIdleMs: 0,
    carriedUserActiveMs: 0,
    pauseFormOnRetry: false,
    startedAt: status === 'pending' ? null : new Date('2026-08-17T07:42:23Z'),
    endedAt: null,
    // The post-invocation park markCliParkBegin stamped when the CLI exited.
    waitingStartedAt: parked ? new Date('2026-08-17T08:03:14Z') : null,
  };
}

describe('advanceStep park fold on resume', () => {
  beforeEach(() => {
    vi.mocked(foldCliParkOnResume).mockClear();
  });

  it('folds the park when the CLI continuation resumes a waiting_cli row', async () => {
    const state: MockState = { taskStepRow: stepRow('waiting_cli', true), updates: [] };

    const result = await advanceStep(runParams(state));

    // The regression this test exists for: without the fold the marker rides to `ended_at`.
    expect(foldCliParkOnResume).toHaveBeenCalledTimes(1);
    expect(foldCliParkOnResume).toHaveBeenCalledWith(expect.anything(), 'ts-1');
    expect(result.status).toBe('done');
  });

  it('still folds on the pending -> running flip (runtime-slot park unchanged)', async () => {
    const state: MockState = { taskStepRow: stepRow('pending', true), updates: [] };

    await advanceStep(runParams(state));

    expect(foldCliParkOnResume).toHaveBeenCalledTimes(1);
    expect(foldCliParkOnResume).toHaveBeenCalledWith(expect.anything(), 'ts-1');
  });

  it('does not fold a terminal row (short-circuit runs before the resume block)', async () => {
    for (const status of ['done', 'skipped'] as const) {
      vi.mocked(foldCliParkOnResume).mockClear();
      const state: MockState = { taskStepRow: stepRow(status, true), updates: [] };
      await advanceStep(runParams(state));
      expect(foldCliParkOnResume).not.toHaveBeenCalled();
    }
  });
});
