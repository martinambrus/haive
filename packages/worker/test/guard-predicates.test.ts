import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { StepDefinition } from '@haive/shared/step';
import { registeredGuardPredicates } from '../src/step-engine/guard-predicates.js';
import { registerModuleSteps } from '../src/modules/loader.js';
import { StepRegistry } from '../src/step-engine/registry.js';

const argsSchema = z.strictObject({});
const evaluate = async () => true;
const predicate = { argsSchema, evaluate };

function step(id: string, workflowType: string, guardPredicates?: Record<string, unknown>) {
  return {
    metadata: {
      id,
      workflowType,
      index: 0,
      title: id,
      description: 'predicate accessor test stub',
      requiresCli: false,
    },
    detect: async () => ({}),
    apply: async () => ({}),
    ...(guardPredicates ? { guardPredicates } : {}),
  } as StepDefinition;
}
function registryOf(...steps: StepDefinition[]): StepRegistry {
  const registry = new StepRegistry();
  for (const def of steps) registry.register(def);
  return registry;
}

describe('registeredGuardPredicates', () => {
  it('maps a module step predicate to its namespaced id and the same object', () => {
    const planned = { argsSchema, evaluate };
    const map = registeredGuardPredicates(registryOf(step('s1', 'module.fx', { planned })));
    expect([...map.keys()]).toEqual(['module.fx.planned']);
    expect(map.get('module.fx.planned')).toBe(planned);
  });

  it('collects several predicates and several steps of one module', () => {
    const map = registeredGuardPredicates(
      registryOf(
        step('s1', 'module.fx', { planned: predicate, other: predicate }),
        step('s2', 'module.fx', { third: predicate }),
        step('s3', 'module.gx', { planned: predicate }),
      ),
    );
    expect([...map.keys()].sort()).toEqual([
      'module.fx.other',
      'module.fx.planned',
      'module.fx.third',
      'module.gx.planned',
    ]);
  });

  it('yields nothing for a step outside a module workflow type', () => {
    expect(
      registeredGuardPredicates(registryOf(step('s1', 'workflow', { planned: predicate }))).size,
    ).toBe(0);
  });

  it('yields nothing for steps without predicates and for an empty registry', () => {
    expect(
      registeredGuardPredicates(registryOf(step('s1', 'module.fx'), step('s2', 'workflow'))).size,
    ).toBe(0);
    expect(registeredGuardPredicates(new StepRegistry()).size).toBe(0);
  });

  it('matches what the module loader returns for the same entry', () => {
    const registry = new StepRegistry();
    const [loaded] = registerModuleSteps(registry, [
      {
        packageName: '@haive/module-fx',
        manifest: { id: 'fx', name: 'Fx', version: '1.0.0', schemaVersion: 1 },
        executionPredicates: [
          { id: 'planned', argsSchema },
          { id: 'later', argsSchema },
        ],
        steps: [
          step('one', 'unused', { planned: { argsSchema, evaluate } }),
          step('two', 'unused', { later: { argsSchema, evaluate } }),
          step('three', 'unused'),
        ],
      },
    ]);
    const accessor = registeredGuardPredicates(registry);
    expect([...accessor.keys()].sort()).toEqual([...loaded!.predicates!.keys()].sort());
    expect(accessor.size).toBe(2);
    for (const [id, expected] of loaded!.predicates!) expect(accessor.get(id)).toBe(expected);
  });
});
