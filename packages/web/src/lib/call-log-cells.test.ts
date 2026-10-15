import { describe, expect, it } from 'vitest';
import type { TaskCustomToolCall, TaskToolUsage, TaskToolUsageStep } from './api-client';
import { customToolsCell, hasNothingToShow, toolUsageRows } from './call-log-cells';

type Step = TaskToolUsage['steps'][number];

const custom = (tool: string, over: Partial<TaskCustomToolCall> = {}): TaskCustomToolCall => ({
  tool,
  action: 'http-get',
  ok: 0,
  refused: 0,
  error: 0,
  running: 0,
  ...over,
});

const USAGE: TaskToolUsageStep = {
  runs: 1,
  observable: 1,
  partial: 0,
  unobservable: 0,
  unrecorded: 0,
  personasAssigned: [],
  personasRead: [],
  skillsInvoked: [],
  skillsRead: [],
  mcp: [],
  subagents: [],
  toolCalls: 0,
};

const step = (id: string, over: Partial<Step> = {}): Step => ({
  stepRowId: id,
  stepId: id,
  round: 0,
  title: id,
  usage: null,
  customTools: [],
  ...over,
});

const coverage = (total: number): TaskToolUsage['coverage'] => ({
  total,
  observable: total,
  partial: 0,
  unobservable: 0,
  unrecorded: 0,
});

describe('customToolsCell', () => {
  it('is a dash for no entry', () => {
    expect(customToolsCell([])).toBe('—');
  });

  it('names the tool and each outcome it had, in a fixed order', () => {
    expect(customToolsCell([custom('lookup', { ok: 3, refused: 1, error: 2, running: 4 })])).toBe(
      'lookup 3 ok · 1 refused · 2 failed · 4 running',
    );
  });

  it('leaves out an outcome it never had', () => {
    expect(customToolsCell([custom('lookup', { ok: 2, running: 1 })])).toBe(
      'lookup 2 ok · 1 running',
    );
    expect(customToolsCell([custom('lookup', { error: 1 })])).toBe('lookup 1 failed');
  });

  it('joins the entries with a comma, in the order given', () => {
    expect(customToolsCell([custom('zeta', { ok: 1 }), custom('alpha', { refused: 2 })])).toBe(
      'zeta 1 ok, alpha 2 refused',
    );
  });

  it('names a refused call to a tool the step never declared', () => {
    expect(customToolsCell([custom('', { action: '', refused: 1 })])).toBe(
      '(undeclared) 1 refused',
    );
  });
});

describe('toolUsageRows', () => {
  it('keeps a step with a run, a step with only calls, and drops one with neither', () => {
    const steps = [
      step('ran', { usage: USAGE }),
      step('called', { customTools: [custom('lookup', { ok: 1 })] }),
      step('neither'),
      step('both', { usage: USAGE, customTools: [custom('lookup', { ok: 1 })] }),
    ];
    expect(toolUsageRows(steps).map((s) => s.stepRowId)).toEqual(['ran', 'called', 'both']);
  });

  it('keeps the order it was given', () => {
    const steps = [step('b', { usage: USAGE }), step('a', { usage: USAGE })];
    expect(toolUsageRows(steps).map((s) => s.stepRowId)).toEqual(['b', 'a']);
  });
});

describe('hasNothingToShow', () => {
  it('is true with no attributed run and no call', () => {
    expect(hasNothingToShow({ coverage: coverage(0), callTotals: { customTools: [] } })).toBe(true);
  });

  it('is false once a run is attributed', () => {
    expect(hasNothingToShow({ coverage: coverage(2), callTotals: { customTools: [] } })).toBe(
      false,
    );
  });

  it('is false with calls but no attributed run', () => {
    expect(
      hasNothingToShow({
        coverage: coverage(0),
        callTotals: { customTools: [custom('lookup', { refused: 1 })] },
      }),
    ).toBe(false);
  });
});
