import {
  computeTaskTiming,
  computeWorkByCategory,
  TIME_CATEGORIES,
  timeCategoryOf,
  type TaskTimingStep,
  type TimeCategory,
} from '../step-engine/timing.js';
import { summarizeTestChecks, type TimeCostCheckRun } from './check-runs.js';

export interface FormWaitEvent {
  id: string;
  taskId: string;
  taskStepId: string | null;
  eventType: string;
  createdAt: Date | string;
}

// Resets cascade downstream. With no attempt identity on historical events, invalidate every
// open wait in the task rather than join a surviving marker across a reset of another step.
const RESET_EVENTS = new Set([
  'step.retry',
  'step.retry_ai',
  'step.revise',
  'step.loop_back',
  'task.retried',
  'task.auto_resumed',
]);
const TASK_END_EVENTS = new Set([
  'task.stopped',
  'task.cancelled',
  'task.cancel_finished',
  'task.dead',
  'task.completed',
]);
const STEP_END_EVENTS = new Set([
  'step.skip',
  'step.skipped',
  'step.abort',
  'step.failed',
  'step.done',
  'step.waiting_cli',
  'step.resume',
]);

/** The query projection and reducer share this list so irrelevant events never cross the wire. */
export const FORM_WAIT_EVENT_TYPES: readonly string[] = Object.freeze([
  'step.waiting_form',
  'step.form_submitted',
  // A merge clarification answer closes its wait through /clarify, not the submit route.
  'step.clarified',
  ...RESET_EVENTS,
  ...TASK_END_EVENTS,
  ...STEP_END_EVENTS,
]);

/** Keep PostgreSQL's sub-millisecond order: Date alone truncates auto-submit events
 * into the same millisecond, at which point a uuid tie-break can reverse the lifecycle. */
function eventMicros(value: Date | string): bigint | null {
  const ms = new Date(value).getTime();
  if (!Number.isFinite(ms)) return null;
  const fraction = typeof value === 'string' ? (value.match(/\.(\d+)/)?.[1] ?? '') : '';
  return BigInt(ms) * 1000n + BigInt(fraction.padEnd(6, '0').slice(3, 6));
}

/** Full lifecycle stream, ordered within task by (created_at, id). No attribution guesses. */
export function sumFormWaits(events: FormWaitEvent[]) {
  const open = new Map<string, Map<string, bigint>>();
  let waitMicros = 0n;
  let pairedWaits = 0;
  let unmeasuredWaits = 0;
  const ordered = events
    .map((e) => ({ e, at: eventMicros(e.createdAt) }))
    .sort(
      (a, b) =>
        a.e.taskId.localeCompare(b.e.taskId) ||
        (a.at === b.at
          ? a.e.id.localeCompare(b.e.id)
          : a.at === null
            ? 1
            : b.at === null
              ? -1
              : a.at < b.at
                ? -1
                : 1),
    );
  for (const { e, at } of ordered) {
    const waits = open.get(e.taskId) ?? new Map<string, bigint>();
    open.set(e.taskId, waits);
    if (
      RESET_EVENTS.has(e.eventType) ||
      TASK_END_EVENTS.has(e.eventType) ||
      (STEP_END_EVENTS.has(e.eventType) && !e.taskStepId)
    ) {
      unmeasuredWaits += waits.size;
      waits.clear();
    } else if (STEP_END_EVENTS.has(e.eventType)) {
      if (waits.delete(e.taskStepId!)) unmeasuredWaits++;
    } else if (
      e.eventType === 'step.waiting_form' ||
      e.eventType === 'step.form_submitted' ||
      e.eventType === 'step.clarified'
    ) {
      if (!e.taskStepId || at === null) {
        unmeasuredWaits++;
        continue;
      }
      const since = waits.get(e.taskStepId);
      if (e.eventType === 'step.waiting_form') {
        if (since !== undefined) unmeasuredWaits++;
        waits.set(e.taskStepId, at);
      } else {
        waits.delete(e.taskStepId);
        if (since === undefined || at < since) unmeasuredWaits++;
        else {
          waitMicros += at - since;
          pairedWaits++;
        }
      }
    }
  }
  for (const waits of open.values()) unmeasuredWaits += waits.size;
  return {
    waitMs: pairedWaits > 0 ? Number(waitMicros) / 1000 : null,
    pairedWaits,
    unmeasuredWaits,
  };
}

export interface TimeCostStep extends TaskTimingStep {
  id: string;
  taskId: string;
  stepId: string;
  output?: unknown;
}
export interface TimeCostInvocation {
  taskId: string;
  stepId: string | null;
  agentMs: number;
  realUsd: number;
  notionalUsd: number;
  invocations: number;
  pricedInvocations: number;
  unpricedInvocations: number;
  unsnapshottedInvocations: number;
}
export type TestExecution = 'ran' | 'not_run' | 'unrecorded';
export interface TimeCostRow extends ReturnType<typeof summarizeTestChecks> {
  taskId: string;
  workMs: number | null;
  testsMs: number | null;
  userActiveMs: number | null;
  waitMs: number | null;
  pairedWaits: number;
  unmeasuredWaits: number;
  agentMs: number;
  realUsd: number | null;
  notionalUsd: number | null;
  invocations: number;
  pricedInvocations: number;
  unpricedInvocations: number;
  unsnapshottedInvocations: number;
  unattributedInvocations: number;
  lowerBound: boolean;
  testExecution: TestExecution;
}
export const TIME_COST_ROW_LIMIT = 200;

function groupByTask<T extends { taskId: string }>(rows: T[]) {
  const out = new Map<string, T[]>();
  for (const row of rows) {
    const list = out.get(row.taskId);
    if (list) list.push(row);
    else out.set(row.taskId, [row]);
  }
  return out;
}

/** Before check-run recording, only the deterministic verify output proves command execution.
 * Other test-phase agents' elapsed spans say nothing about whether a command ran. */
function testExecution(steps: TimeCostStep[], checks: TimeCostCheckRun[]): TestExecution {
  const tests = checks.filter((r) => r.slot === 'test');
  if (tests.length > 0) {
    if (tests.some((r) => r.outcome === 'passed' || r.outcome === 'failed')) return 'ran';
    if (tests.every((r) => r.outcome === 'not_run')) return 'not_run';
    return 'unrecorded';
  }
  const results = steps
    .filter((s) => s.stepId === '08-phase-5-verify')
    .map((s) => {
      const output = s.output as { test?: { ran?: unknown } } | null;
      return output?.test?.ran;
    });
  if (results.includes(true)) return 'ran';
  if (results.length > 0 && results.every((r) => r === false)) return 'not_run';
  return 'unrecorded';
}

export function buildTimeCostReport(input: {
  tasks: { taskId: string; completedAt: Date | string }[];
  steps: TimeCostStep[];
  events: FormWaitEvent[];
  invocations: TimeCostInvocation[];
  checkRuns?: TimeCostCheckRun[];
  recordingStartedAt?: string | null;
  limit?: number;
}) {
  const stepsByTask = groupByTask(input.steps);
  const eventsByTask = groupByTask(input.events);
  const runsByTask = groupByTask(input.invocations);
  const checksByTask = groupByTask(input.checkRuns ?? []);
  const byCategory = Object.fromEntries(
    TIME_CATEGORIES.map((c) => [c, { workMs: 0, agentMs: 0, realUsd: 0, notionalUsd: 0 }]),
  ) as Record<
    TimeCategory,
    { workMs: number; agentMs: number; realUsd: number; notionalUsd: number }
  >;
  const rows: TimeCostRow[] = input.tasks.map((t) => {
    const steps = stepsByTask.get(t.taskId) ?? [];
    const checks = checksByTask.get(t.taskId) ?? [];
    const at = new Date(t.completedAt).getTime();
    const timing = computeTaskTiming(steps, at);
    const work = computeWorkByCategory(steps, at);
    for (const c of TIME_CATEGORIES) byCategory[c].workMs += work[c];
    const waits = sumFormWaits(eventsByTask.get(t.taskId) ?? []);
    const row: TimeCostRow = {
      taskId: t.taskId,
      workMs: steps.length ? timing.workMs : null,
      testsMs: steps.some(
        (s) =>
          timeCategoryOf(s.stepId) === 'tests' &&
          (s.startedAt !== null || (s.carriedWorkMs ?? 0) > 0),
      )
        ? work.tests
        : null,
      userActiveMs: steps.length ? timing.userActiveMs : null,
      ...waits,
      agentMs: 0,
      // No invocations means no recorded cost; a priced zero is assigned below.
      realUsd: null,
      notionalUsd: null,
      invocations: 0,
      pricedInvocations: 0,
      unpricedInvocations: 0,
      unsnapshottedInvocations: 0,
      unattributedInvocations: 0,
      lowerBound: false,
      testExecution: testExecution(steps, checks),
      ...summarizeTestChecks(checks),
    };
    for (const run of runsByTask.get(t.taskId) ?? []) {
      const c = byCategory[timeCategoryOf(run.stepId ?? '')];
      c.agentMs += run.agentMs;
      c.realUsd += run.realUsd;
      c.notionalUsd += run.notionalUsd;
      row.agentMs += run.agentMs;
      row.invocations += run.invocations;
      row.pricedInvocations += run.pricedInvocations;
      row.unpricedInvocations += run.unpricedInvocations;
      row.unsnapshottedInvocations += run.unsnapshottedInvocations;
      if (run.stepId === null) row.unattributedInvocations += run.invocations;
      if (run.pricedInvocations > 0) {
        row.realUsd = (row.realUsd ?? 0) + run.realUsd;
        row.notionalUsd = (row.notionalUsd ?? 0) + run.notionalUsd;
      }
    }
    // A missing snapshot alone is not a missing price: legacy reported prices still count.
    row.lowerBound = row.unpricedInvocations > 0;
    return row;
  });
  const total = (
    key:
      | 'workMs'
      | 'userActiveMs'
      | 'agentMs'
      | 'invocations'
      | 'unpricedInvocations'
      | 'unsnapshottedInvocations'
      | 'unattributedInvocations'
      | 'pairedWaits'
      | 'unmeasuredWaits',
  ) => rows.reduce((n, r) => n + (r[key] ?? 0), 0);
  const measured = (key: 'testsMs' | 'waitMs' | 'realUsd' | 'notionalUsd') =>
    rows.some((r) => r[key] !== null) ? rows.reduce((n, r) => n + (r[key] ?? 0), 0) : null;
  const totals = {
    ...summarizeTestChecks(input.tasks.flatMap((t) => checksByTask.get(t.taskId) ?? [])),
    timedTaskCount: rows.filter((r) => r.workMs !== null).length,
    workMs: total('workMs'),
    userActiveMs: total('userActiveMs'),
    agentMs: total('agentMs'),
    testsMs: measured('testsMs'),
    waitMs: measured('waitMs'),
    realUsd: measured('realUsd'),
    notionalUsd: measured('notionalUsd'),
    invocations: total('invocations'),
    unpricedInvocations: total('unpricedInvocations'),
    unsnapshottedInvocations: total('unsnapshottedInvocations'),
    unattributedInvocations: total('unattributedInvocations'),
    pairedWaits: total('pairedWaits'),
    unmeasuredWaits: total('unmeasuredWaits'),
    lowerBound: rows.some((r) => r.lowerBound),
    testExecutionCounts: {
      ran: rows.filter((r) => r.testExecution === 'ran').length,
      not_run: rows.filter((r) => r.testExecution === 'not_run').length,
      unrecorded: rows.filter((r) => r.testExecution === 'unrecorded').length,
    },
  };
  rows.sort((a, b) => (b.workMs ?? 0) - (a.workMs ?? 0) || a.taskId.localeCompare(b.taskId));
  const limit = input.limit !== undefined && input.limit > 0 ? input.limit : TIME_COST_ROW_LIMIT;
  return {
    recordingStartedAt: input.recordingStartedAt ?? null,
    totals,
    byCategory,
    rows: rows.slice(0, limit),
    taskCount: rows.length,
    truncated: rows.length > limit,
  };
}
