import { describe, expect, it } from 'vitest';
import { resolveRunList } from '../src/queues/run-list.js';
import { StepRegistry, UnresolvedStepError } from '../src/step-engine/registry.js';
import type { StepDefinition } from '../src/step-engine/step-definition.js';

function step(id: string, index: number, workflowType = 'workflow'): StepDefinition {
  return {
    metadata: { id, workflowType, index, title: id, description: id, requiresCli: false },
    detect: async () => ({}),
    form: () => ({ title: id, fields: [] }),
    apply: async () => ({}),
  } as unknown as StepDefinition;
}

function registry(): StepRegistry {
  const r = new StepRegistry();
  r.register(step('a', 1));
  r.register(step('b', 2));
  return r;
}

describe('resolveRunList', () => {
  it('splits a snapshot into the steps that resolve and the ids that do not', () => {
    const { steps, unresolved } = resolveRunList(
      { workflowType: 'workflow', runListSnapshot: ['a', 'gone', 'b'] },
      registry(),
    );
    expect(steps.map((s) => s.metadata.id)).toEqual(['a', 'b']);
    expect(unresolved).toEqual(['gone']);
  });

  it('keeps the live list for a task with no snapshot', () => {
    const { steps, unresolved } = resolveRunList(
      { workflowType: 'workflow', runListSnapshot: null },
      registry(),
    );
    expect(steps.map((s) => s.metadata.id)).toEqual(['a', 'b']);
    expect(unresolved).toEqual([]);
  });
});

describe('StepRegistry.require', () => {
  it('throws the typed error naming the id', () => {
    let thrown: unknown;
    try {
      registry().require('gone');
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(UnresolvedStepError);
    expect((thrown as UnresolvedStepError).ids).toEqual(['gone']);
    expect((thrown as Error).message).toBe('Step gone not registered');
  });
});
