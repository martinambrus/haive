import { describe, expect, it } from 'vitest';
import { registerModuleSteps } from '../src/modules/loader.js';
import { StepRegistry } from '../src/step-engine/registry.js';
import type { StepDefinition } from '../src/step-engine/step-definition.js';

function step(id: string, extra: Partial<StepDefinition> = {}): StepDefinition {
  return { metadata: { id, workflowType: 'x', title: id }, ...extra } as unknown as StepDefinition;
}

function entryFor(stepId: string, loopTargetStepId?: string) {
  return {
    stepId,
    label: stepId,
    group: 'g',
    dispatchesCli: false,
    requires: [],
    provides: [],
    ...(loopTargetStepId ? { loopTargetStepId } : {}),
  };
}

function load(composable: ReturnType<typeof entryFor>[]) {
  return registerModuleSteps(new StepRegistry(), [
    {
      packageName: '@haive/module-loopy',
      manifest: {
        id: 'loopy',
        name: 'Loopy',
        version: '0.0.0',
        schemaVersion: 1,
        composableSteps: composable,
      },
      steps: [
        step('fix'),
        step('check', { fixLoop: { maxRounds: 2 } } as unknown as Partial<StepDefinition>),
      ],
    },
  ]);
}

describe('module composable entries for looping steps', () => {
  it('refuses a looping step whose entry declares no loop target', () => {
    expect(() => load([entryFor('fix'), entryFor('check')])).toThrow(
      /composable step "check" loops back to 07-phase-2-implement/,
    );
  });

  it('refuses a local target, since the runner always loops back to the core implement step', () => {
    expect(() => load([entryFor('fix'), entryFor('check', 'fix')])).toThrow(
      /loops back to 07-phase-2-implement/,
    );
  });

  it('accepts the core implement step as the target, unprefixed', () => {
    const [loaded] = load([entryFor('fix'), entryFor('check', '07-phase-2-implement')]);
    expect(loaded!.composable[1]!.loopTargetStepId).toBe('07-phase-2-implement');
  });

  it('refuses a target on a step that does not loop', () => {
    expect(() =>
      load([entryFor('fix', '07-phase-2-implement'), entryFor('check', '07-phase-2-implement')]),
    ).toThrow(/"fix" declares a loop target but does not loop/);
  });
});
