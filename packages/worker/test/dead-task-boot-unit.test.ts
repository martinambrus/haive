import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { deadTaskResolution } from '../src/queues/dead-task-boot.js';
import { StepRegistry } from '../src/step-engine/registry.js';
import type { StepDefinition } from '../src/step-engine/step-definition.js';

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
    detect: async () => ({}),
    form: () => ({ title: id, fields: [] }),
    apply: async () => ({}),
  } as unknown as StepDefinition;
}

const registry = (): StepRegistry => {
  const r = new StepRegistry();
  r.register(step('a', 1));
  r.register(step('b', 2));
  return r;
};

const CUSTOM = 'custom.demo.summarise';
const entry = {
  slug: 'summarise',
  title: 'Summarise',
  template: 'Summarise {{task.title}}',
  capabilities: [],
  timeoutMs: 120_000,
};

const task = (over: Partial<Parameters<typeof deadTaskResolution>[0]> = {}) => ({
  id: 't1',
  type: 'workflow',
  currentStepId: 'a' as string | null,
  runListSnapshot: ['a', 'b'],
  customSteps: null,
  ...over,
});

describe('deadTaskResolution', () => {
  it('finds nothing wrong with a task whose list and current step resolve', () => {
    expect(deadTaskResolution(task(), 'static', registry())).toEqual({
      unresolved: [],
      outsideList: null,
    });
  });

  it('names the snapshot ids the registry does not hold', () => {
    const found = deadTaskResolution(
      task({ runListSnapshot: ['a', 'module.x.gone', 'b', 'module.y.gone'] }),
      'static',
      registry(),
    );
    expect(found.unresolved).toEqual(['module.x.gone', 'module.y.gone']);
    expect(found.outsideList).toBeNull();
  });

  it('names an unregistered current step once, whether or not the list holds it', () => {
    expect(
      deadTaskResolution(
        task({ currentStepId: 'gone', runListSnapshot: ['a', 'gone'] }),
        'static',
        registry(),
      ).unresolved,
    ).toEqual(['gone']);
    expect(
      deadTaskResolution(
        task({ currentStepId: 'gone', runListSnapshot: ['a'] }),
        'static',
        registry(),
      ),
    ).toEqual({ unresolved: ['gone'], outsideList: null });
  });

  it('reports a registered current step that a static list does not hold', () => {
    expect(
      deadTaskResolution(
        task({ currentStepId: 'a', runListSnapshot: ['b'] }),
        'static',
        registry(),
      ),
    ).toEqual({ unresolved: [], outsideList: 'a' });
  });

  it('has no current step to judge before the task starts', () => {
    expect(deadTaskResolution(task({ currentStepId: null }), 'static', registry())).toEqual({
      unresolved: [],
      outsideList: null,
    });
  });

  it('ignores the snapshot of a type whose run list is not static, and still judges the current step', () => {
    expect(
      deadTaskResolution(
        task({ runListSnapshot: ['module.x.gone'], currentStepId: 'a' }),
        'workflow_paths',
        registry(),
      ),
    ).toEqual({ unresolved: [], outsideList: null });
    expect(
      deadTaskResolution(
        task({ runListSnapshot: ['b'], currentStepId: 'gone' }),
        'run_app_modes',
        registry(),
      ),
    ).toEqual({ unresolved: ['gone'], outsideList: null });
  });

  it.each(['static', 'workflow_paths', 'run_app_modes'] as const)(
    'judges a %s task without a snapshot by its current step alone',
    (strategy) => {
      expect(deadTaskResolution(task({ runListSnapshot: null }), strategy, registry())).toEqual({
        unresolved: [],
        outsideList: null,
      });
      expect(
        deadTaskResolution(
          task({ runListSnapshot: null, currentStepId: 'gone' }),
          strategy,
          registry(),
        ),
      ).toEqual({ unresolved: ['gone'], outsideList: null });
    },
  );

  it('resolves a custom step only from the entry the task pinned', () => {
    const snapshot = ['a', CUSTOM];
    expect(
      deadTaskResolution(
        task({ runListSnapshot: snapshot, customSteps: { [CUSTOM]: entry } }),
        'static',
        registry(),
      ).unresolved,
    ).toEqual([]);
    expect(
      deadTaskResolution(
        task({ runListSnapshot: snapshot, customSteps: null }),
        'static',
        registry(),
      ).unresolved,
    ).toEqual([CUSTOM]);
  });

  it('does not call a task dead for a pinned tool that no longer parses', () => {
    const badTool = {
      name: 'too_long',
      description: 'd'.repeat(1025),
      action: 'http-get',
      url: 'https://api.example.com/v1/status',
    };
    expect(
      deadTaskResolution(
        task({
          currentStepId: CUSTOM,
          runListSnapshot: ['a', CUSTOM],
          customSteps: { [CUSTOM]: { ...entry, tools: [badTool] } },
        }),
        'static',
        registry(),
      ),
    ).toEqual({ unresolved: [], outsideList: null });
  });
});

describe('worker boot order', () => {
  const boot = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
  const at = (needle: string): number => {
    const index = boot.indexOf(needle);
    expect(index, needle).toBeGreaterThan(-1);
    return index;
  };

  it('judges dead tasks after the step engine and the job requeue, and before the orphaned-step reconcile', () => {
    const judged = at('reconcileDeadTasks(');
    expect(at('bootStepEngine(')).toBeLessThan(judged);
    expect(at('requeueOrphanedActiveJobs(getCliExecQueue()')).toBeLessThan(judged);
    expect(judged).toBeLessThan(at('reconcileOrphanedSteps('));
  });

  it('starts the retry of revivals when the boot pass held one back, failed one or could not run, and stops it when the worker shuts down', () => {
    expect(at('retryHeldRevivals(')).toBeGreaterThan(at('reconcileDeadTasks('));
    expect(boot).toMatch(
      /!deadTasks \|\| deadTasks\.held > 0 \|\| deadTasks\.failed > 0\s*\?\s*retryHeldRevivals\(/,
    );
    expect(boot.slice(at('const runShutdown = async'))).toContain('stopDeadTaskRevival()');
  });
});
