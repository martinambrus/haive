import { describe, expect, it } from 'vitest';
import type {
  TaskCustomToolCall,
  TaskIntegrationCall,
  TaskToolUsage,
  TaskToolUsageStep,
} from './api-client';
import {
  customToolsCell,
  hasNothingToShow,
  integrationsCell,
  showsToolUsage,
  toolUsageRows,
} from './call-log-cells';

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

const integration = (
  providerId: string,
  tool: string,
  access: 'read' | 'write',
  over: Partial<TaskIntegrationCall> = {},
): TaskIntegrationCall => ({
  providerId,
  tool,
  access,
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
  integrations: [],
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

  it('adds the action to a name two entries share, as two steps may in the total', () => {
    expect(
      customToolsCell([
        custom('fetch', { action: 'http-get', ok: 1 }),
        custom('fetch', { action: 'rag-query', ok: 2 }),
        custom('other', { action: 'http-get', ok: 1 }),
      ]),
    ).toBe('fetch (http-get) 1 ok, fetch (rag-query) 2 ok, other 1 ok');
  });
});

describe('integrationsCell', () => {
  it('is a dash for no entry', () => {
    expect(integrationsCell([])).toBe('—');
  });

  it('names the provider, the tool, the access and each outcome, in a fixed order', () => {
    expect(
      integrationsCell([
        integration('github', 'open_pull_request', 'write', {
          ok: 3,
          refused: 1,
          error: 2,
          running: 4,
        }),
      ]),
    ).toBe('github/open_pull_request (write) 3 ok · 1 refused · 2 failed · 4 running');
  });

  it('leaves out an outcome it never had', () => {
    expect(
      integrationsCell([integration('github', 'get_pull_request_state', 'read', { ok: 2 })]),
    ).toBe('github/get_pull_request_state (read) 2 ok');
    expect(integrationsCell([integration('gitlab', 'x', 'read', { running: 1, error: 1 })])).toBe(
      'gitlab/x (read) 1 failed · 1 running',
    );
  });

  it('joins the entries with a comma, in the order given', () => {
    expect(
      integrationsCell([
        integration('gitlab', 'b', 'write', { refused: 2 }),
        integration('github', 'a', 'read', { ok: 1 }),
      ]),
    ).toBe('gitlab/b (write) 2 refused, github/a (read) 1 ok');
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

  it('keeps a step whose only calls are integration calls', () => {
    const steps = [
      step('integrated', { integrations: [integration('github', 'x', 'read', { error: 1 })] }),
      step('neither'),
    ];
    expect(toolUsageRows(steps).map((s) => s.stepRowId)).toEqual(['integrated']);
  });

  it('keeps the order it was given', () => {
    const steps = [step('b', { usage: USAGE }), step('a', { usage: USAGE })];
    expect(toolUsageRows(steps).map((s) => s.stepRowId)).toEqual(['b', 'a']);
  });
});

describe('hasNothingToShow', () => {
  it('is true with no attributed run and no call', () => {
    expect(
      hasNothingToShow({
        coverage: coverage(0),
        callTotals: { customTools: [], integrations: [] },
      }),
    ).toBe(true);
  });

  it('is false once a run is attributed', () => {
    expect(
      hasNothingToShow({
        coverage: coverage(2),
        callTotals: { customTools: [], integrations: [] },
      }),
    ).toBe(false);
  });

  it('is false with custom tool calls but no attributed run', () => {
    expect(
      hasNothingToShow({
        coverage: coverage(0),
        callTotals: { customTools: [custom('lookup', { refused: 1 })], integrations: [] },
      }),
    ).toBe(false);
  });

  it('is false with integration calls but no attributed run', () => {
    expect(
      hasNothingToShow({
        coverage: coverage(0),
        callTotals: {
          customTools: [],
          integrations: [integration('github', 'x', 'write', { refused: 1 })],
        },
      }),
    ).toBe(false);
  });
});

describe('showsToolUsage', () => {
  const counters = (cliInvocationCount: number, loggedCallCount: number) => ({
    cliInvocationCount,
    loggedCallCount,
  });

  it('is true once a step ran a CLI', () => {
    expect(showsToolUsage([counters(0, 0), counters(2, 0)])).toBe(true);
  });

  it('is true for a step with logged calls but no live run', () => {
    expect(showsToolUsage([counters(0, 0), counters(0, 3)])).toBe(true);
  });

  it('is false when no step has a run or a call', () => {
    expect(showsToolUsage([counters(0, 0), counters(0, 0)])).toBe(false);
  });

  it('is false for a task with no step', () => {
    expect(showsToolUsage([])).toBe(false);
  });
});
