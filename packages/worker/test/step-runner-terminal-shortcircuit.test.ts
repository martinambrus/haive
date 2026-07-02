import { describe, expect, it } from 'vitest';
import type { Database } from '@haive/database';
import { advanceStep } from '../src/step-engine/step-runner.js';
import type { StepDefinition } from '../src/step-engine/step-definition.js';
import type { CliProviderRecord } from '../src/cli-adapters/types.js';

// Slice 1 coverage: an advance job that lands on an already-terminal (done/skipped) row must
// short-circuit — return the stored row without re-running detect/apply or re-stamping
// endedAt. This is what stops a resume walk from inflating a completed step's span (the
// 373h env-replicate bug). The mock DB does not evaluate WHERE clauses; upsertRow's select is
// stubbed to return the configured row, and any update is recorded so we can assert no
// endedAt write happens.

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
    select: () => ({
      from: (table: unknown) => {
        const tableName = tableNameOf(table);
        return {
          where: () => ({
            limit: async () => (tableName === 'task_steps' ? [state.taskStepRow] : []),
          }),
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
    query: { tasks: { findFirst: async () => ({ id: 'task-1', status: 'running' }) } },
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

/** A step whose phases throw if reached — so a passing test proves they were skipped. */
function explodingStep(): StepDefinition {
  return {
    metadata: {
      id: 'term-step',
      workflowType: 'env_replicate',
      index: 0,
      title: 'terminal step',
      description: 'terminal step',
      requiresCli: false,
    },
    async detect() {
      throw new Error('detect must not run for a terminal row');
    },
    async apply() {
      throw new Error('apply must not run for a terminal row');
    },
  };
}

function runParams(state: MockState) {
  return {
    db: makeMockDb(state),
    taskId: 'task-1',
    userId: 'user-1',
    repoPath: '/tmp',
    workspacePath: '/tmp',
    cliProviderId: null,
    stepDef: explodingStep(),
    providers: [makeProvider()],
    runSeq: 0, // non-null so upsertRow returns the row as-is (no self-heal update)
    deps: {
      async enqueueCliInvocation() {
        throw new Error('no CLI invocation expected');
      },
    },
  };
}

function terminalRow(status: 'done' | 'skipped'): Record<string, unknown> {
  return {
    id: 'ts-1',
    taskId: 'task-1',
    stepId: 'term-step',
    stepIndex: 0,
    round: 0,
    runSeq: 0,
    status,
    output: status === 'done' ? { generated: ['a', 'b'] } : null,
    formSchema: null,
    formValues: null,
    detectOutput: { ready: true },
    startedAt: new Date('2026-06-28T07:49:43Z'),
    endedAt: new Date('2026-06-28T07:49:45Z'),
  };
}

describe('advanceStep terminal short-circuit', () => {
  it('returns a done row without re-running phases or re-stamping endedAt', async () => {
    const state: MockState = { taskStepRow: terminalRow('done'), updates: [] };
    const originalEndedAt = state.taskStepRow.endedAt;

    const result = await advanceStep(runParams(state));

    expect(result.status).toBe('done');
    expect((result as { output: unknown }).output).toEqual({ generated: ['a', 'b'] });
    // The critical assertion: no update wrote a new endedAt (which would inflate the span).
    expect(state.updates).toHaveLength(0);
    expect(state.taskStepRow.endedAt).toBe(originalEndedAt);
  });

  it('returns a skipped row untouched', async () => {
    const state: MockState = { taskStepRow: terminalRow('skipped'), updates: [] };
    const result = await advanceStep(runParams(state));
    expect(result.status).toBe('skipped');
    expect(state.updates).toHaveLength(0);
  });
});
