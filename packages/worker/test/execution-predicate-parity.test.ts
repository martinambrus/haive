import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import { registerModuleSteps, type WorkerModuleEntry } from '../src/modules/loader.js';
import { StepRegistry } from '../src/step-engine/registry.js';
import type { StepDefinition } from '@haive/shared/step';

const argsSchema = z.strictObject({ producer: z.string() });
const evaluate = vi.fn(async () => true);
const declaration = { id: 'planned', argsSchema };
const step = (guardPredicates: unknown = { planned: { argsSchema, evaluate } }) =>
  ({
    metadata: { id: 'probe', title: 'Probe', workflowType: 'test', index: 1 },
    guardPredicates,
  }) as StepDefinition;
const entry = (executionPredicates: unknown = [declaration], steps = [step()]) =>
  ({
    packageName: '@haive/module-fx',
    manifest: { id: 'fx', name: 'Fx', version: '1', schemaVersion: 1 },
    executionPredicates,
    steps,
  }) as WorkerModuleEntry;
const load = (value = entry()) => registerModuleSteps(new StepRegistry(), [value]);

it('binds the shared schema object to its evaluator without evaluating it', () => {
  const [loaded] = load();
  expect(loaded!.predicates!.get('module.fx.planned')).toEqual({ argsSchema, evaluate });
  expect(evaluate).not.toHaveBeenCalled();
});
it.each([
  ['declaration without evaluator', () => entry([declaration], [step({})]), 'no evaluator'],
  ['evaluator without declaration', () => entry(undefined), 'no declaration'],
  ['duplicate declaration', () => entry([declaration, declaration]), 'duplicate'],
  [
    'duplicate evaluator',
    () =>
      entry([declaration], [step(), { ...step(), metadata: { ...step().metadata, id: 'second' } }]),
    'duplicate',
  ],
  [
    'foreign declaration prefix',
    () => entry([{ ...declaration, id: 'module.other.planned' }]),
    'local predicate id',
  ],
  [
    'own prefix instead of local id',
    () => entry([{ ...declaration, id: 'module.fx.planned' }]),
    'local predicate id',
  ],
  [
    'foreign evaluator prefix',
    () => entry([declaration], [step({ 'module.other.planned': { argsSchema, evaluate } })]),
    'executable predicate',
  ],
  ['missing schema', () => entry([{ id: 'planned' }]), 'schema-only'],
  ['non-schema export', () => entry({ planned: declaration }), 'array'],
  ['evaluate in declaration', () => entry([{ ...declaration, evaluate }]), 'schema-only'],
  [
    'missing callback',
    () => entry([declaration], [step({ planned: { argsSchema } })]),
    'executable predicate',
  ],
  [
    'schema with a different refinement',
    () =>
      entry(
        [declaration],
        [
          step({
            planned: { argsSchema: z.strictObject({ producer: z.string().min(2) }), evaluate },
          }),
        ],
      ),
    'schema mismatch',
  ],
  [
    'separately constructed lookalike schema',
    () =>
      entry(
        [declaration],
        [step({ planned: { argsSchema: z.strictObject({ producer: z.string() }), evaluate } })],
      ),
    'schema mismatch',
  ],
] as const)('refuses %s at boot', (_label, make, message) => {
  const value = make();
  // Explicit undefined represents an absent optional export (the helper has a default).
  if (_label === 'evaluator without declaration') delete value.executionPredicates;
  expect(() => load(value)).toThrow(message);
});
it('keeps modules with neither declarations nor evaluators valid', () => {
  const value = entry([], [step({})]);
  delete value.executionPredicates;
  expect(load(value)[0]!.predicates!.size).toBe(0);
});
