import { describe, expect, it } from 'vitest';
import { schema, type Database } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { PgDialect } from 'drizzle-orm/pg-core';
import { STEP_ROLES } from '@haive/shared/step-outputs';
import { rolePin, REVIEW, PRODUCER } from './step-role-fixtures.js';
import { loadPreviousStepOutput } from '../src/step-engine/steps/onboarding/_helpers.js';
import { renderTaskHistoryDigest } from '../src/step-engine/steps/workflow/_task-history-digest.js';
import { parsePromptDefects } from '../src/step-engine/steps/workflow/_prompt-defect.js';
import { filterCandidates } from '../src/step-engine/steps/workflow/11e-prompt-guidance.js';
import { loadHonoredConstraints } from '../src/step-engine/steps/workflow/_fix-loop.js';
import type { StepContext } from '../src/step-engine/step-definition.js';
const raw = '## PROMPT-DEFECT\n- DEFECT: missing_context | state the runtime | a.ts:1';
const pin = rolePin();
const output = {
  peer: { findings: [{ severity: 'high', issue: 'retained real defect', path: 'a.ts' }] },
};
describe('pinned role consumers', () => {
  it('mines every review round, excludes the old producer, and preserves physical event provenance', () => {
    const digest = renderTaskHistoryDigest(
      [
        { stepId: PRODUCER, round: 0, output },
        { stepId: PRODUCER, round: 1, output },
        { stepId: REVIEW, round: 1, output },
      ],
      [
        {
          eventType: 'fix_loop.requested',
          payload: { sourceStepId: PRODUCER, round: 1, diagnosis: 'actual source' },
        },
      ],
      pin,
    );
    expect(digest.findingCount).toBe(2);
    expect(digest.text).toContain(PRODUCER);
    expect(digest.text).toContain('08c-peer');
  });
  it('resolves both prompt guidance paths and keeps the physical source', () => {
    const defects = parsePromptDefects(
      [
        { stepId: PRODUCER, raw },
        { stepId: REVIEW, raw },
      ],
      pin,
    );
    expect(defects).toHaveLength(1);
    expect(defects[0]!.sourceStep).toBe(PRODUCER);
    expect(filterCandidates(defects, [], pin)[0]!.targetStep).toBe('07-phase-2-implement');
    expect(filterCandidates(defects, [], { ...pin, executionPath: null })).toEqual([]);
  });
  it('honors the mapped review source without promoting it to a human directive', async () => {
    const events = [
      {
        payload: {
          sourceStepId: PRODUCER,
          round: 1,
          diagnosis: 'replacement diagnosis',
          machineFenced: true,
        },
      },
      { payload: { sourceStepId: REVIEW, round: 1, diagnosis: 'obsolete diagnosis' } },
    ];
    const db = {
      query: { tasks: { findFirst: async () => pin } },
      select: () => ({ from: () => ({ where: () => ({ orderBy: async () => events }) }) }),
    } as unknown as Database;
    const text = await loadHonoredConstraints({ db, taskId: 't', round: 2 } as StepContext);
    expect(text).toContain(PRODUCER);
    expect(text).toContain('replacement diagnosis');
    expect(text).not.toContain('obsolete diagnosis');
    expect(text.indexOf('BEGIN')).toBeLessThan(text.indexOf('replacement diagnosis'));
  });
  it('selects the newest physical round, including resets, and honors historical round ceilings', async () => {
    const fake = createFakeDb({ tasks: schema.tasks, taskSteps: schema.taskSteps });
    const taskId = 'aaaaaaaa-0000-4000-8000-000000000001';
    fake.insert(schema.tasks, { id: taskId, ...pin });
    fake.insert(schema.taskSteps, {
      taskId,
      stepId: PRODUCER,
      status: 'done',
      round: 0,
      output: { earlier: true },
    });
    fake.insert(schema.taskSteps, {
      taskId,
      stepId: PRODUCER,
      status: 'pending',
      round: 2,
      output: null,
    });
    const db = fake.db as unknown as Database;
    expect(await loadPreviousStepOutput(db, taskId, { role: STEP_ROLES.codeReview })).toMatchObject(
      { stepId: PRODUCER, status: 'pending', round: 2, output: null },
    );
    expect(
      await loadPreviousStepOutput(db, taskId, { role: STEP_ROLES.codeReview }, 1),
    ).toMatchObject({ stepId: PRODUCER, status: 'done', round: 0, output: { earlier: true } });
    expect(
      await loadPreviousStepOutput(db, taskId, { role: STEP_ROLES.codeReview }),
    ).not.toHaveProperty('outputCompatible');
    expect(
      await loadPreviousStepOutput(db, taskId, { role: STEP_ROLES.codeReview }, 1),
    ).toHaveProperty('outputCompatible', false);
    // An explicitly physical read never aliases the old canonical producer.
    expect(await loadPreviousStepOutput(db, taskId, REVIEW)).toBeNull();
  });
  it('makes missing replacement output unavailable and never reads an unselected candidate', async () => {
    const fake = createFakeDb({ tasks: schema.tasks, taskSteps: schema.taskSteps });
    const taskId = 'aaaaaaaa-0000-4000-8000-000000000001';
    fake.insert(schema.tasks, { id: taskId, ...pin });
    const db = fake.db as unknown as Database;
    expect(await loadPreviousStepOutput(db, taskId, { role: STEP_ROLES.codeReview })).toBeNull();
    fake.patch(schema.tasks, taskId, { executionPath: null });
    expect(await loadPreviousStepOutput(db, taskId, { role: STEP_ROLES.codeReview })).toBeNull();
  });

  it('loads the physical latest row even when reset, with a round ceiling and actual identity', async () => {
    let params: unknown[] = [];
    let order = '';
    const latest = {
      id: 'uuid',
      stepId: PRODUCER,
      status: 'pending',
      round: 2,
      detectOutput: {},
      output: null,
      iterations: [],
    };
    const db = {
      query: { tasks: { findFirst: async () => pin } },
      select: () => ({
        from: () => ({
          where: (predicate: any) => {
            params = new PgDialect().sqlToQuery(predicate).params;
            return {
              orderBy: (expr: any) => {
                order = new PgDialect().sqlToQuery(expr).sql;
                return { limit: async () => [latest] };
              },
            };
          },
        }),
      }),
    } as unknown as Database;
    const result = await loadPreviousStepOutput(db, 't', { role: STEP_ROLES.codeReview }, 2);
    expect(params).toContain(PRODUCER);
    expect(params).not.toContain(REVIEW);
    expect(params).toContain(2);
    expect(order).toContain('"round" desc');
    expect(result).toMatchObject({
      id: 'uuid',
      stepId: PRODUCER,
      status: 'pending',
      round: 2,
      output: null,
    });
  });
});
