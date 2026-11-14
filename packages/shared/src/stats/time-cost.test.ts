import { describe, expect, it } from 'vitest';
import { computeTaskTiming, computeWorkByCategory, timeCategoryOf } from '../step-engine/timing.js';
import { buildTimeCostReport, sumFormWaits, TIME_COST_ROW_LIMIT } from './time-cost.js';

const step = (over = {}) => ({
  id: 's',
  taskId: 't',
  stepId: '08-phase-5-verify',
  status: 'done',
  startedAt: new Date(100),
  endedAt: new Date(200),
  idleMs: 10,
  userActiveMs: 0,
  waitingStartedAt: null,
  carriedWorkMs: 30,
  carriedUserActiveMs: 5,
  ...over,
});
const event = (id: number, eventType: string, taskStepId: string | null = 's', taskId = 't') => ({
  id: String(id).padStart(3, '0'),
  taskId,
  taskStepId,
  eventType,
  createdAt: new Date(id * 100),
});

describe('category work', () => {
  it.each(['pending', 'waiting_form', 'running'])(
    'reconciles parks, retries and carried work (%s)',
    (status) => {
      const steps = [
        step(),
        step({
          id: 'b',
          stepId: 'custom',
          startedAt: null,
          endedAt: null,
          status: 'pending',
          waitingStartedAt: new Date(300),
        }),
        step({
          id: 'c',
          stepId: '07-phase-2-implement',
          startedAt: null,
          endedAt: null,
          status: 'pending',
          waitingStartedAt: new Date(400),
        }),
        step({
          id: 'd',
          stepId: '06-gate-1-spec-approval',
          status,
          startedAt: new Date(500),
          endedAt: null,
          waitingStartedAt: new Date(600),
        }),
      ];
      const categories = computeWorkByCategory(steps, 1000);
      expect(Object.values(categories).reduce((a, b) => a + b, 0)).toBe(
        computeTaskTiming(steps, 1000).workMs,
      );
      expect(categories.tests).toBe(120);
      expect(timeCategoryOf('custom')).toBe('other');
    },
  );
});

describe('form lifecycle pairing', () => {
  it('preserves event order within a millisecond instead of reordering auto-submit by uuid', () => {
    expect(
      sumFormWaits([
        { ...event(2, 'step.waiting_form'), createdAt: '2026-11-10T00:00:00.000001Z' },
        { ...event(1, 'step.form_submitted'), createdAt: '2026-11-10T00:00:00.000002Z' },
      ]),
    ).toMatchObject({ pairedWaits: 1, unmeasuredWaits: 0 });
  });
  it('pairs auto-submit and two rounds, sorting by timestamp and id within task and step', () => {
    const events = [
      event(1, 'step.waiting_form'),
      event(2, 'step.form_submitted'),
      event(3, 'step.waiting_form', 's2'),
      event(4, 'step.form_submitted', 's2'),
    ];
    expect(sumFormWaits(events.reverse())).toEqual({
      waitMs: 200,
      pairedWaits: 2,
      unmeasuredWaits: 0,
    });
  });
  it.each([
    'step.retry',
    'step.retry_ai',
    'step.skip',
    'step.abort',
    'step.revise',
    'step.loop_back',
    'task.retried',
    'task.auto_resumed',
    'task.stopped',
    'task.cancelled',
    'task.dead',
  ])('does not bridge %s', (type) => {
    expect(
      sumFormWaits([
        event(1, 'step.waiting_form'),
        event(2, type, null),
        event(3, 'step.form_submitted'),
      ]),
    ).toMatchObject({ waitMs: null, pairedWaits: 0 });
  });
  it('closes a merge clarification wait answered through /clarify', () => {
    expect(sumFormWaits([event(1, 'step.waiting_form'), event(2, 'step.clarified')])).toEqual({
      waitMs: 100,
      pairedWaits: 1,
      unmeasuredWaits: 0,
    });
  });
  it('replaces a park, ignores orphan submits and leaves open waits unmeasured', () => {
    expect(
      sumFormWaits([
        event(1, 'step.form_submitted'),
        event(2, 'step.waiting_form'),
        event(3, 'step.waiting_form'),
        event(4, 'step.form_submitted'),
        event(5, 'step.waiting_form'),
      ]),
    ).toEqual({ waitMs: 100, pairedWaits: 1, unmeasuredWaits: 3 });
  });
  it('does not pair missing attribution or another task, and retains a measured zero', () => {
    const open = event(1, 'step.waiting_form');
    expect(
      sumFormWaits([open, { ...event(2, 'step.form_submitted'), createdAt: open.createdAt }])
        .waitMs,
    ).toBe(0);
    expect(
      sumFormWaits([
        open,
        event(3, 'step.form_submitted', 's', 'other'),
        event(4, 'step.form_submitted', null),
      ]).waitMs,
    ).toBeNull();
  });
});

describe('time and cost report', () => {
  it('sums only completed test checks and excludes incomplete/environment stops from pass share before the row cap', () => {
    const check = (
      outcome: 'passed' | 'failed' | 'not_run' | 'running' | 'interrupted',
      slot = 'test',
      taskId = 't',
    ) => ({
      taskId,
      slot,
      outcome,
      startedAt: new Date(0),
      endedAt: outcome === 'running' ? null : new Date(20),
    });
    const report = buildTimeCostReport({
      tasks: ['t', 'old', 'zero', 'not_run', 'incomplete'].map((taskId) => ({
        taskId,
        completedAt: new Date(1000),
      })),
      steps: [
        step({ taskId: 't', carriedWorkMs: 1000, output: { test: { ran: false } } }),
        step({ taskId: 'old', output: { test: { ran: true } } }),
        step({ taskId: 'not_run', output: { test: { ran: true } } }),
      ],
      events: [],
      invocations: [],
      limit: 1,
      checkRuns: [
        check('passed'),
        check('failed'),
        check('not_run'),
        check('running'),
        check('interrupted'),
        check('passed', 'lint'),
        { ...check('passed', 'test', 'zero'), endedAt: new Date(0) },
        check('not_run', 'test', 'not_run'),
        check('running', 'test', 'incomplete'),
      ],
      recordingStartedAt: '2026-11-14T00:00:00.000Z',
    });
    expect(report.recordingStartedAt).toBe('2026-11-14T00:00:00.000Z');
    expect(report.rows[0]).toMatchObject({
      taskId: 't',
      testExecution: 'ran',
      testSuiteMs: 40,
      testSuiteRuns: 2,
    });
    expect(report.totals).toMatchObject({
      testSuiteMs: 40,
      testSuiteRuns: 3,
      testPassShare: { ratio: 2 / 3, n: 3, sufficient: false },
      testCheckCounts: { passed: 2, failed: 1, not_run: 2, running: 2, interrupted: 1 },
      testExecutionCounts: { ran: 3, not_run: 1, unrecorded: 1 },
    });
    const empty = buildTimeCostReport({
      tasks: [{ taskId: 't', completedAt: new Date(1000) }],
      steps: [],
      events: [],
      invocations: [],
    });
    expect(empty.rows[0]?.testSuiteMs).toBeNull();
    expect(empty.totals.testPassShare).toEqual({ ratio: null, n: 0, sufficient: false });
  });
  it('counts every execution state across the population before limiting rows', () => {
    const report = buildTimeCostReport({
      tasks: ['ran', 'not_run', 'unrecorded'].map((taskId) => ({
        taskId,
        completedAt: new Date(1000),
      })),
      steps: [
        step({ taskId: 'ran', output: { test: { ran: true } } }),
        step({ taskId: 'not_run', output: { test: { ran: false } } }),
        step({ taskId: 'unrecorded' }),
      ],
      events: [],
      invocations: [],
      limit: 1,
    });
    expect(report.rows).toHaveLength(1);
    expect(report.totals.testExecutionCounts).toEqual({ ran: 1, not_run: 1, unrecorded: 1 });
    expect(
      buildTimeCostReport({ tasks: [], steps: [], events: [], invocations: [] }).totals
        .testExecutionCounts,
    ).toEqual({ ran: 0, not_run: 0, unrecorded: 0 });
  });

  it('caps rows after totals, preserves coverage and measures at completion', () => {
    expect(TIME_COST_ROW_LIMIT).toBe(200);
    const report = buildTimeCostReport({
      tasks: [
        { taskId: 't', completedAt: new Date(1000) },
        { taskId: 'u', completedAt: new Date(1000) },
      ],
      steps: [
        step({ endedAt: null, status: 'running', output: { test: { ran: false } } }),
        step({ taskId: 'u', id: 'u', output: { test: { ran: true } } }),
      ],
      events: [],
      invocations: [
        {
          taskId: 't',
          stepId: '08-phase-5-verify',
          agentMs: 50,
          realUsd: 0,
          notionalUsd: 2,
          invocations: 2,
          pricedInvocations: 1,
          unpricedInvocations: 1,
          unsnapshottedInvocations: 1,
        },
      ],
      limit: 1,
    });
    expect(report.taskCount).toBe(2);
    expect(report.truncated).toBe(true);
    expect(report.rows).toHaveLength(1);
    expect(report.totals.workMs).toBe(1040);
    expect(report.totals.userActiveMs).toBe(10);
    expect(report.rows[0]).toMatchObject({
      taskId: 't',
      testExecution: 'not_run',
      lowerBound: true,
      realUsd: 0,
      notionalUsd: 2,
      waitMs: null,
    });
    expect(report.byCategory.tests).toMatchObject({
      workMs: 1040,
      agentMs: 50,
      realUsd: 0,
      notionalUsd: 2,
    });
  });
  it('uses dashes for absent measurements and zero for recorded zeros', () => {
    const report = buildTimeCostReport({
      tasks: [{ taskId: 't', completedAt: new Date(1000) }],
      steps: [],
      events: [],
      invocations: [],
    });
    expect(report.rows[0]).toMatchObject({
      workMs: null,
      testsMs: null,
      userActiveMs: null,
      realUsd: null,
      testExecution: 'unrecorded',
    });
    expect(report.totals.workMs).toBe(0);
    expect(report.totals.realUsd).toBeNull();
    expect(report.rows[0]?.invocations).toBe(0);
    const measuredZero = buildTimeCostReport({
      tasks: [{ taskId: 't', completedAt: new Date(1000) }],
      steps: [],
      events: [],
      invocations: [
        {
          taskId: 't',
          stepId: '08-phase-5-verify',
          agentMs: 0,
          realUsd: 0,
          notionalUsd: 0,
          invocations: 1,
          pricedInvocations: 1,
          unpricedInvocations: 0,
          unsnapshottedInvocations: 0,
        },
      ],
    });
    expect(measuredZero.rows[0]?.realUsd).toBe(0);
    expect(measuredZero.totals.realUsd).toBe(0);
  });
});
