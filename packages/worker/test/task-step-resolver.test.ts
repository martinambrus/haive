import { describe, expect, it } from 'vitest';
import {
  parseCustomSteps,
  requireTaskStep,
  resolveRunList,
  resolveTaskStep,
} from '../src/queues/run-list.js';
import { StepRegistry, UnresolvedStepError } from '../src/step-engine/registry.js';
import type { StepDefinition } from '../src/step-engine/step-definition.js';
import { promptStepTools } from '../src/step-engine/steps/custom/prompt-step.js';

function step(id: string, index: number): StepDefinition {
  return {
    metadata: {
      id,
      workflowType: 'workflow',
      index,
      title: id,
      description: id,
      requiresCli: false,
    },
    apply: async () => ({}),
  } as unknown as StepDefinition;
}

const registry = (): StepRegistry => {
  const r = new StepRegistry();
  r.register(step('a', 1));
  return r;
};

const ID = 'custom.demo.summarise';
const entry = {
  slug: 'summarise',
  title: 'Summarise',
  template: 'Summarise {{task.title}}',
  capabilities: [],
  timeoutMs: 120_000,
};

describe('parseCustomSteps', () => {
  it('keeps a valid entry and drops one that does not parse or whose slug differs from its key', () => {
    const parsed = parseCustomSteps({
      [ID]: entry,
      'custom.demo.broken': { slug: 'broken', title: 'x' },
      'custom.demo.other': { ...entry, slug: 'summarise' },
      'not-a-custom-id': entry,
    });
    expect(Object.keys(parsed)).toEqual([ID]);
  });

  it('reads null and non-objects as no entries', () => {
    expect(parseCustomSteps(null)).toEqual({});
    expect(parseCustomSteps('x')).toEqual({});
  });
});

describe('resolveTaskStep', () => {
  it('resolves a core id from the registry', () => {
    expect(resolveTaskStep({ taskId: 't1' }, 'a', registry())?.metadata.id).toBe('a');
    expect(resolveTaskStep({ taskId: 't1' }, 'gone', registry())).toBeUndefined();
  });

  it('synthesises a custom id from the task entry and never consults the registry for it', () => {
    const def = resolveTaskStep(
      { taskId: 't2', customSteps: parseCustomSteps({ [ID]: entry }), runListSnapshot: ['a', ID] },
      ID,
      registry(),
    );
    expect(def?.metadata.id).toBe(ID);
    expect(def?.metadata.workflowType).toBe('custom');
    expect(def?.metadata.index).toBe(1);
  });

  it('resolves a custom id with no pinned entry to nothing', () => {
    expect(resolveTaskStep({ taskId: 't3', customSteps: {} }, ID, registry())).toBeUndefined();
    expect(resolveTaskStep({ taskId: 't3' }, ID, registry())).toBeUndefined();
  });

  it('gives one task the same definition on every call and another task its own', () => {
    const customSteps = parseCustomSteps({ [ID]: entry });
    const first = resolveTaskStep({ taskId: 't4', customSteps }, ID, registry());
    expect(resolveTaskStep({ taskId: 't4', customSteps }, ID, registry())).toBe(first);
    expect(resolveTaskStep({ taskId: 't5', customSteps }, ID, registry())).not.toBe(first);
  });

  it('requireTaskStep throws the typed error for an id that does not resolve', () => {
    expect(() => requireTaskStep({ taskId: 't6' }, ID, registry())).toThrow(UnresolvedStepError);
  });
});

describe('resolveRunList with pinned steps', () => {
  it('resolves a custom id the task pinned and leaves one it did not as unresolved', () => {
    const { steps, unresolved } = resolveRunList(
      {
        taskId: 't7',
        workflowType: 'demo',
        runListSnapshot: ['a', ID, 'custom.demo.missing'],
        customSteps: parseCustomSteps({ [ID]: entry }),
      },
      registry(),
    );
    expect(steps.map((s) => s.metadata.id)).toEqual(['a', ID]);
    expect(unresolved).toEqual(['custom.demo.missing']);
  });
});

describe('promptStepTools', () => {
  it('lists no tools for a pinned step that defines none, and nothing for any other step', () => {
    const def = resolveTaskStep(
      { taskId: 't11', customSteps: parseCustomSteps({ [ID]: entry }) },
      ID,
      registry(),
    );
    expect(promptStepTools(def!)).toEqual({ names: [], invalid: [] });
    expect(promptStepTools(registry().get('a')!)).toBeUndefined();
  });
});

describe('a pinned step with a tool that no longer parses', () => {
  const tool = (name: string, over: object = {}) => ({
    name,
    description: 'Fetches the status.',
    action: 'http-get',
    url: 'https://api.example.com/v1/status',
    ...over,
  });
  const pinned = () =>
    parseCustomSteps({
      [ID]: {
        ...entry,
        tools: [tool('good'), tool('too_long', { description: 'd'.repeat(1025) })],
      },
    });

  it('stays in the pinned entries, with its valid tool and the invalid one named', () => {
    const parsed = pinned()[ID];
    expect(parsed?.tools.map((t) => t.name)).toEqual(['good']);
    expect(parsed?.invalidTools).toEqual(['too_long']);
  });

  it('tells the runner its valid tools by name and the invalid ones apart', () => {
    const def = resolveTaskStep({ taskId: 't8a', customSteps: pinned() }, ID, registry());
    expect(promptStepTools(def!)).toEqual({ names: ['good'], invalid: ['too_long'] });
  });

  it('resolves as the current step instead of a missing one', () => {
    const scope = { taskId: 't8', customSteps: pinned(), runListSnapshot: ['a', ID] };
    expect(resolveTaskStep(scope, ID, registry())?.metadata.id).toBe(ID);
    expect(requireTaskStep(scope, ID, registry()).metadata.id).toBe(ID);
  });

  it('keeps the step in the run list', () => {
    const { steps, unresolved } = resolveRunList(
      { taskId: 't9', workflowType: 'demo', runListSnapshot: ['a', ID], customSteps: pinned() },
      registry(),
    );
    expect(steps.map((s) => s.metadata.id)).toEqual(['a', ID]);
    expect(unresolved).toEqual([]);
  });
});
