import { describe, expect, it } from 'vitest';
import type { Database } from '@haive/database';
import type { StepDefinition } from '../src/step-engine/step-definition.js';
import {
  routesErrorToFixLoop,
  finishedRoutingVerdict,
  finishedStepResult,
  type TaskStepRow,
} from '../src/step-engine/step-runner.js';

/** isFixLoopSuppressed's whole query shape: select({id}).from(taskEvents).where(...).limit(1). */
function fakeDb(suppressed: boolean): Database {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => (suppressed ? [{ id: 'evt-accepted' }] : []),
        }),
      }),
    }),
  } as unknown as Database;
}

function step(overrides: Record<string, unknown> = {}): StepDefinition {
  const { id = 'test-step', ...rest } = overrides;
  return {
    metadata: {
      id,
      workflowType: 'workflow',
      index: 99,
      title: 't',
      description: 'd',
      requiresCli: false,
    },
    async apply() {
      return {};
    },
    ...rest,
  } as unknown as StepDefinition;
}

function row(overrides: Record<string, unknown> = {}): TaskStepRow {
  return {
    id: 'row-1',
    taskId: 'task-1',
    stepId: 'test-step',
    round: 0,
    status: 'done',
    output: {},
    errorMessage: null,
    ...overrides,
  } as unknown as TaskStepRow;
}

describe('routesErrorToFixLoop', () => {
  it('routes when fixLoopOnError is true', () => {
    expect(routesErrorToFixLoop(step({ fixLoopOnError: true }), 'boom')).toBe(true);
  });

  it('does not route when fixLoopOnError is absent', () => {
    expect(routesErrorToFixLoop(step(), 'boom')).toBe(false);
  });

  it('routes per-error when the fixLoopOnError predicate returns true', () => {
    const s = step({ fixLoopOnError: (msg: string) => msg.includes('ddev') });
    expect(routesErrorToFixLoop(s, 'ddev restart failed: bad webserver')).toBe(true);
  });

  it('does not route when the fixLoopOnError predicate returns false', () => {
    const s = step({ fixLoopOnError: (msg: string) => msg.includes('ddev') });
    expect(routesErrorToFixLoop(s, 'some unrelated failure')).toBe(false);
  });
});

describe('finishedRoutingVerdict', () => {
  it('returns null for a step with no loop hooks', async () => {
    expect(await finishedRoutingVerdict(fakeDb(false), 't', step(), {})).toBeNull();
  });

  it('returns loop_back when fixLoop.evaluate reports blocking', async () => {
    const s = step({ fixLoop: { evaluate: () => ({ blocking: true, diagnosis: 'bad config' }) } });
    expect(await finishedRoutingVerdict(fakeDb(false), 't', s, {})).toEqual({
      kind: 'loop_back',
      diagnosis: 'bad config',
    });
  });

  it('returns null when fixLoop.evaluate is non-blocking', async () => {
    const s = step({ fixLoop: { evaluate: () => null } });
    expect(await finishedRoutingVerdict(fakeDb(false), 't', s, {})).toBeNull();
  });

  it('returns null when fixLoop is blocking but the loop is suppressed', async () => {
    const s = step({ fixLoop: { evaluate: () => ({ blocking: true, diagnosis: 'bad config' }) } });
    expect(await finishedRoutingVerdict(fakeDb(true), 't', s, {})).toBeNull();
  });

  it('returns an uncapped loop_back when restartLoop requests a restart', async () => {
    const s = step({ restartLoop: { evaluate: () => ({ diagnosis: 'button does nothing' }) } });
    expect(await finishedRoutingVerdict(fakeDb(false), 't', s, {})).toEqual({
      kind: 'loop_back',
      diagnosis: 'button does nothing',
      uncapped: true,
    });
  });

  it('returns revise with the target step id', async () => {
    const s = step({
      reviseLoop: { evaluate: () => ({ targetStepId: '03b-business-requirements' }) },
    });
    expect(await finishedRoutingVerdict(fakeDb(false), 't', s, {})).toEqual({
      kind: 'revise',
      targetStepId: '03b-business-requirements',
    });
  });

  it('precedence: fixLoop blocking wins over reviseLoop also firing', async () => {
    const s = step({
      fixLoop: { evaluate: () => ({ blocking: true, diagnosis: 'fix first' }) },
      reviseLoop: { evaluate: () => ({ targetStepId: 'earlier-step' }) },
    });
    expect(await finishedRoutingVerdict(fakeDb(false), 't', s, {})).toEqual({
      kind: 'loop_back',
      diagnosis: 'fix first',
    });
  });

  it('precedence: a suppressed fixLoop falls through to restartLoop (uncapped)', async () => {
    const s = step({
      fixLoop: { evaluate: () => ({ blocking: true, diagnosis: 'suppressed fix' }) },
      restartLoop: { evaluate: () => ({ diagnosis: 'restart wins' }) },
    });
    expect(await finishedRoutingVerdict(fakeDb(true), 't', s, {})).toEqual({
      kind: 'loop_back',
      diagnosis: 'restart wins',
      uncapped: true,
    });
  });
});

describe('finishedStepResult', () => {
  it('rebuilds a plain done result when nothing fires', async () => {
    const s = step();
    const r = row({ output: { ok: true } });
    expect(await finishedStepResult(fakeDb(false), 't', s, r)).toEqual({
      status: 'done',
      row: r,
      output: { ok: true },
    });
  });

  it('rebuilds loop_back from a blocking fixLoop output', async () => {
    const s = step({ fixLoop: { evaluate: () => ({ blocking: true, diagnosis: 'bad config' }) } });
    const r = row();
    expect(await finishedStepResult(fakeDb(false), 't', s, r)).toEqual({
      status: 'loop_back',
      row: r,
      diagnosis: 'bad config',
      sourceStepId: 'test-step',
    });
  });

  it('rebuilds revise from a reviseLoop output', async () => {
    const s = step({
      id: '03c-business-requirements-review',
      reviseLoop: { evaluate: () => ({ targetStepId: '03b-business-requirements' }) },
    });
    const r = row({ stepId: '03c-business-requirements-review' });
    expect(await finishedStepResult(fakeDb(false), 't', s, r)).toEqual({
      status: 'revise',
      row: r,
      targetStepId: '03b-business-requirements',
      sourceStepId: '03c-business-requirements-review',
    });
  });

  it('rebuilds loop_back from a recorded fixLoopOnError diagnosis', async () => {
    const s = step({ fixLoopOnError: true });
    const r = row({ errorMessage: 'ddev restart failed: bad webserver', output: null });
    expect(await finishedStepResult(fakeDb(false), 't', s, r)).toEqual({
      status: 'loop_back',
      row: r,
      diagnosis: 'ddev restart failed: bad webserver',
      sourceStepId: 'test-step',
    });
  });

  it('finishes done when the fixLoopOnError predicate declines the recorded error', async () => {
    const s = step({ fixLoopOnError: (msg: string) => msg.includes('ddev') });
    const r = row({ errorMessage: 'unrelated failure', output: { x: 1 } });
    expect(await finishedStepResult(fakeDb(false), 't', s, r)).toEqual({
      status: 'done',
      row: r,
      output: { x: 1 },
    });
  });

  it('finishes done when errorMessage is set but the step has no fixLoopOnError', async () => {
    const s = step();
    const r = row({ errorMessage: 'some stale error', output: { x: 1 } });
    expect(await finishedStepResult(fakeDb(false), 't', s, r)).toEqual({
      status: 'done',
      row: r,
      output: { x: 1 },
    });
  });
});
