import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import type { StepContext } from '../../step-definition.js';
import { prWaitStep } from './13-pr-wait.js';

describe('finalization RAG review', () => {
  function setup() {
    const taskId = randomUUID();
    const queryId = randomUUID();
    const fake = createFakeDb({ tasks: schema.tasks, ragQueryLog: schema.ragQueryLog });
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
    const ctx = {
      taskId,
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
  it('does not skip a reopened PR’s fresh evidence or legacy detect payloads', () => {
    const { detected } = setup();
    expect(
      prWaitStep.llm!.skipIf!({ detected: { ...detected, pending: true }, formValues: {} }),
    ).toBe(false);
    expect(
      prWaitStep.llm!.skipIf!({ detected: { ...detected, ragUsage: undefined }, formValues: {} }),
    ).toBe(false);
  });
});
