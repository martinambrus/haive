import { describe, expect, it } from 'vitest';
import type { Database } from '@haive/database';
import type { CliExecJobPayload } from '@haive/shared';
import { advanceStep } from '../src/step-engine/step-runner.js';
import type { StepDefinition } from '../src/step-engine/step-definition.js';
import type { CliProviderRecord } from '../src/cli-adapters/types.js';

// Coverage for the best-effort per-step summarizer's provider choice
// (maybeEnqueueStepSummary). Nothing asserted on this path before: the LLM-phase suites
// let the summary enqueue throw into its own try/catch, and the DB-backed smokes set
// HAIVE_TEST_BYPASS_LLM=1, which stops any cli_invocations row being written at all — so
// the summarizer returns early there and can never be exercised.
//
// The mock DB does not evaluate WHERE clauses; `taskRow` stands in for whatever the
// tasks.findFirst lookup returns, which is exactly the fact under test.

interface MockState {
  taskStepRow: Record<string, unknown>;
  cliInvocationRow: Record<string, unknown> | null;
  /** What db.query.tasks.findFirst returns. undefined = no row, which must read as
   *  inherit/enabled — the shape every pre-existing step-runner suite relies on. */
  taskRow: Record<string, unknown> | undefined;
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
            }),
            then: (onOk: (r: unknown) => unknown, onErr?: (e: unknown) => unknown) =>
              allRows().then(onOk, onErr),
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
            if (tableName === 'task_steps') state.taskStepRow = { ...state.taskStepRow, ...row };
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
        set: (v: Record<string, unknown>) => {
          if (tableName === 'task_steps') state.taskStepRow = { ...state.taskStepRow, ...v };
          return {
            where: (_: unknown) => ({
              returning: async () => (tableName === 'task_steps' ? [state.taskStepRow] : []),
            }),
          };
        },
      };
    },
    query: {
      userStepCliPreferences: { findFirst: async () => undefined },
      userStepCliRolePreferences: { findFirst: async () => undefined },
      taskStepCliTouched: { findFirst: async () => undefined },
      tasks: { findFirst: async () => state.taskRow },
      taskSteps: { findFirst: async () => undefined },
      envTemplates: { findFirst: async () => undefined },
      repositories: { findFirst: async () => undefined },
    },
  } as unknown as Database;
  return db;
}

/** A step whose apply output carries none of the curated summary keys, so the runner
 *  falls through to the LLM summarizer rather than mirroring a summary field. */
function baseStep(): StepDefinition {
  return {
    metadata: {
      id: 'test-summary-step',
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
      requiredCapabilities: [],
      buildPrompt: () => 'prompt',
    },
    async apply(_ctx, args) {
      return { llmOutput: args.llmOutput };
    },
  };
}

/** A step row parked on a COMPLETED invocation, so the next advance runs apply and
 *  finalizes — which is the only moment the summarizer is reached. */
function freshState(taskRow: Record<string, unknown> | undefined): MockState {
  return {
    taskStepRow: {
      id: 'ts-1',
      taskId: 'task-1',
      stepId: 'test-summary-step',
      stepIndex: 0,
      title: 'test',
      status: 'waiting_cli',
      formSchema: null,
      formValues: {},
      detectOutput: { foo: 'bar' },
      output: null,
      errorMessage: null,
      startedAt: null,
      endedAt: null,
    },
    cliInvocationRow: {
      id: 'inv-1',
      exitCode: 0,
      rawOutput: 'the agent did a thing',
      parsedOutput: { result: 42 },
      endedAt: new Date(),
      errorMessage: null,
      createdAt: new Date(),
    },
    taskRow,
    inserts: [],
  };
}

function makeProvider(over: Partial<CliProviderRecord> = {}): CliProviderRecord {
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
    ...over,
  } as CliProviderRecord;
}

async function runToDone(
  taskRow: Record<string, unknown> | undefined,
  providers: CliProviderRecord[],
): Promise<{ enqueued: CliExecJobPayload[]; state: MockState }> {
  const state = freshState(taskRow);
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
    providers,
    deps: {
      async enqueueCliInvocation(payload) {
        enqueued.push(payload);
      },
    },
  });
  expect(result.status).toBe('done');
  return { enqueued, state };
}

const summaries = (enqueued: CliExecJobPayload[]) =>
  enqueued.filter((p) => p.purpose === 'step_summary');

describe('per-step summarizer provider choice', () => {
  it('inherits the step CLI when the task names no summary provider', async () => {
    const { enqueued } = await runToDone({ summaryCliProviderId: null, summaryLlmEnabled: true }, [
      makeProvider(),
    ]);
    const summary = summaries(enqueued);
    expect(summary).toHaveLength(1);
    expect(summary[0]!.cliProviderId).toBe('prov-1');
  });

  it('reads a missing task row as inherit/enabled', async () => {
    // The pre-existing suites' mock returns undefined here. If that ever stopped meaning
    // "behave as before", every one of them would change behaviour silently.
    const { enqueued } = await runToDone(undefined, [makeProvider()]);
    expect(summaries(enqueued)).toHaveLength(1);
    expect(summaries(enqueued)[0]!.cliProviderId).toBe('prov-1');
  });

  it('uses the task summary CLI when one is set and enabled', async () => {
    const { enqueued, state } = await runToDone(
      { summaryCliProviderId: 'prov-summary', summaryLlmEnabled: true },
      [makeProvider(), makeProvider({ id: 'prov-summary', label: 'Cheap', name: 'codex' })],
    );
    const summary = summaries(enqueued);
    expect(summary).toHaveLength(1);
    expect(summary[0]!.cliProviderId).toBe('prov-summary');

    // Attribution, not linkage: the spend must reach the step's totals without the row
    // entering the step terminal, the retry blocker or the invocation count.
    const invRows = state.inserts.filter((i) => i.table === 'cli_invocations');
    const summaryRow = invRows.find((i) => i.row.agentTitle === 'Step summary');
    expect(summaryRow).toBeDefined();
    expect(summaryRow!.row.taskStepId).toBeNull();
    expect(summaryRow!.row.summaryForStepId).toBe('ts-1');
    expect(summaryRow!.row.cliProviderId).toBe('prov-summary');
  });

  it('falls back to the step CLI when the summary provider is disabled', async () => {
    // The failure this guards: a disabled id does not fail the dispatch, it simply matches
    // nothing, and resolveDispatch then hands the run to whichever provider is ordered
    // first. Here that would be the OTHER enabled provider, not the task's own CLI.
    const { enqueued } = await runToDone(
      { summaryCliProviderId: 'prov-summary', summaryLlmEnabled: true },
      [
        makeProvider(),
        makeProvider({ id: 'prov-summary', label: 'Cheap', name: 'codex', enabled: false }),
      ],
    );
    const summary = summaries(enqueued);
    expect(summary).toHaveLength(1);
    expect(summary[0]!.cliProviderId).toBe('prov-1');
  });

  it('enqueues nothing when the task turned the LLM summary off', async () => {
    const { enqueued, state } = await runToDone(
      { summaryCliProviderId: null, summaryLlmEnabled: false },
      [makeProvider()],
    );
    expect(summaries(enqueued)).toHaveLength(0);
    expect(state.inserts.filter((i) => i.row.agentTitle === 'Step summary')).toHaveLength(0);
  });
});
