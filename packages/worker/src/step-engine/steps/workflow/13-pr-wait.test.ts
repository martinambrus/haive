import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { eq } from 'drizzle-orm';
import type { StepContext } from '../../step-definition.js';
import { prWaitStep } from './13-pr-wait.js';

describe('finalization RAG review', () => {
  function setup() {
    const taskId = randomUUID();
    const queryId = randomUUID();
    const fake = createFakeDb({
      tasks: schema.tasks,
      ragQueryLog: schema.ragQueryLog,
      taskSteps: schema.taskSteps,
      cliInvocations: schema.cliInvocations,
    });
    fake.insert(schema.tasks, {
      id: taskId,
      userId: randomUUID(),
      type: 'workflow',
      title: 'Fixture',
    });
    fake.insert(schema.ragQueryLog, {
      id: queryId,
      taskId,
      query: 'cookies',
      hitCount: 0,
      resultHits: [],
    });
    const taskStepId = randomUUID();
    fake.insert(schema.taskSteps, {
      id: taskStepId,
      taskId,
      stepId: '13-pr-wait',
      stepIndex: 15,
      title: 'Pull request',
      status: 'running',
    });
    const ctx = {
      taskId,
      taskStepId,
      db: fake.db,
      throwIfCancelled: vi.fn(),
      logger: { warn: vi.fn() },
    } as unknown as StepContext;
    const detected = {
      pending: false,
      prUrl: null,
      prProvider: null,
      finalizeMode: null,
      worktreePath: null,
      branchName: null,
      ragUsage: {
        queries: [
          {
            id: queryId,
            query: 'cookies',
            hitCount: 0,
            createdAt: new Date().toISOString(),
            hits: [],
          },
        ],
        runs: [],
      },
    };
    return { fake, ctx, detected };
  }
  it('assesses zero-hit queries on the path without a PR or a model call', async () => {
    const { fake, ctx, detected } = setup();
    expect(prWaitStep.llm!.skipIf!({ detected, formValues: {} })).toBe(true);
    await prWaitStep.apply!(ctx, {
      detected,
      formValues: {},
      llmOutput: null,
      iteration: 0,
      previousIterations: [],
    });
    expect(fake.rows(schema.ragQueryLog)[0]!.usageAssessment).toMatchObject({
      status: 'unused',
      reason: 'No results were returned.',
    });
  });
  it('continues finalization if saving the review fails', async () => {
    const { ctx, detected } = setup();
    ctx.db = {
      update: () => {
        throw new Error('store unavailable');
      },
    } as unknown as StepContext['db'];
    await expect(
      prWaitStep.apply!(ctx, {
        detected,
        formValues: {},
        llmOutput: null,
        iteration: 0,
        previousIterations: [],
      }),
    ).resolves.toMatchObject({ finalized: false, removed: false });
    expect(ctx.logger.warn).toHaveBeenCalled();
    expect(prWaitStep.llm!.optional).toBe(true);
  });
  it('marks omitted queries neutral and zero-hit queries unused without touching another task', async () => {
    const { fake, ctx, detected } = setup();
    const omitted = fake.insert(schema.ragQueryLog, {
      id: randomUUID(),
      taskId: ctx.taskId,
      query: 'omitted from the evidence budget',
      hitCount: 8,
    });
    const foreignTask = randomUUID();
    fake.insert(schema.tasks, {
      id: foreignTask,
      userId: randomUUID(),
      type: 'workflow',
      title: 'Other task',
    });
    const foreign = fake.insert(schema.ragQueryLog, {
      id: randomUUID(),
      taskId: foreignTask,
      query: 'other user query',
      hitCount: 1,
    });
    await prWaitStep.apply!(ctx, {
      detected: { ...detected, ragUsage: { queries: [], runs: [] } },
      formValues: {},
      llmOutput: null,
      iteration: 0,
      previousIterations: [],
    });
    const rows = fake.rows(schema.ragQueryLog);
    expect(rows.find((row) => row.id === omitted.id)!.usageAssessment).toMatchObject({
      status: 'unknown',
    });
    expect(rows.find((row) => row.id === foreign.id)!.usageAssessment).toBeNull();
    expect(rows[0]!.usageAssessment).toMatchObject({ status: 'unused' });
  });
  it('does not skip a reopened PR’s fresh evidence or legacy detect payloads', () => {
    const { detected } = setup();
    expect(
      prWaitStep.llm!.skipIf!({ detected: { ...detected, pending: true }, formValues: {} }),
    ).toBe(false);
    expect(
      prWaitStep.llm!.skipIf!({ detected: { ...detected, ragUsage: undefined }, formValues: {} }),
    ).toBe(false);
  });
  it.each(['no queries', 'zero hits', 'uncaptured results'])(
    'skips dispatch after refreshing a PR with %s',
    async (scenario) => {
      const { fake, ctx, detected } = setup();
      if (scenario === 'no queries') {
        await fake.db.delete(schema.ragQueryLog).where(eq(schema.ragQueryLog.taskId, ctx.taskId));
      } else if (scenario === 'uncaptured results') {
        await fake.db
          .update(schema.ragQueryLog)
          .set({ hitCount: 2, resultHits: null })
          .where(eq(schema.ragQueryLog.taskId, ctx.taskId));
      }
      detected.pending = true;
      expect(prWaitStep.llm!.skipIf!({ detected, formValues: {} })).toBe(false);
      expect(await prWaitStep.llm!.prepare!({ ctx, detected, formValues: {} })).toBe(false);
      expect(detected.ragUsage.queries).toEqual([]);
    },
  );
  it('allows dispatch when reopening added captured hits and timestamped agent prose', async () => {
    const { fake, ctx, detected } = setup();
    const at = new Date();
    await fake.db
      .update(schema.ragQueryLog)
      .set({
        hitCount: 1,
        createdAt: at,
        resultHits: [{ sourcePath: 'src/session.ts', content: 'Cookie implementation' }],
      })
      .where(eq(schema.ragQueryLog.taskId, ctx.taskId));
    const originalStep = randomUUID();
    fake.insert(schema.taskSteps, {
      id: originalStep,
      taskId: ctx.taskId,
      stepId: '07-phase-2-implement',
      stepIndex: 7,
      title: 'Implement',
      status: 'done',
    });
    fake.insert(schema.cliInvocations, {
      id: randomUUID(),
      taskId: ctx.taskId,
      taskStepId: originalStep,
      mode: 'cli',
      prompt: 'Fixture',
      startedAt: new Date(at.getTime() - 1000),
      endedAt: new Date(at.getTime() + 1000),
      cleanTranscript: {
        segments: [
          {
            kind: 'model',
            at: at.getTime() + 500,
            text: 'I used src/session.ts to implement secure cookies.',
          },
        ],
      },
    });
    detected.pending = true;
    expect(await prWaitStep.llm!.prepare!({ ctx, detected, formValues: {} })).toBeUndefined();
    expect(detected.ragUsage.queries).toHaveLength(1);
    expect(detected.ragUsage.runs).toHaveLength(1);
  });
});
