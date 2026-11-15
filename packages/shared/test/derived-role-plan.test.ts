import { describe, expect, it } from 'vitest';
import {
  type DerivedRunPlanV2,
  parseDerivedRunPlan,
} from '../src/modularity/derived-task-types.js';
import { rolePlan, REVIEW, PRODUCER } from './step-role-fixtures.js';

describe('dual pinned-plan decode, without admission', () => {
  it('retains v1 and decodes a future v2 pin without mutating either', () => {
    for (const version of [1, 2] as const) {
      const plan = rolePlan(version);
      const before = JSON.stringify(plan);
      expect(parseDerivedRunPlan(plan)).toEqual(plan);
      expect(JSON.stringify(plan)).toBe(before);
    }
  });
});

function effectivePin() {
  const plan = rolePlan(2) as DerivedRunPlanV2;
  const producer = plan.composableEntries[0]!;
  const host = {
    ...producer,
    stepId: REVIEW,
    replaces: undefined,
    requires: [{ needs: 'repository', reason: 'host input' }],
    loopTargetStepId: '07-phase-2-implement',
    entailsWhen: [{ provided: 'review', entails: ['consumer'] }],
  };
  plan.composableEntries.push(host);
  for (const c of plan.candidates) {
    c.effectiveEntries = c.stepIds.map((id) =>
      id === PRODUCER
        ? {
            ...producer,
            requires: host.requires,
            loopTargetStepId: host.loopTargetStepId,
            entailsWhen: [...host.entailsWhen],
          }
        : {
            stepId: id,
            label: id,
            group: 'test',
            dispatchesCli: false,
            requires: [],
            provides: [],
          },
    );
  }
  return plan;
}
it('accepts a structurally valid pinned entry independent of today’s merge result', () => {
  const plan = effectivePin();
  const entry = plan.candidates[0]!.effectiveEntries!.find((e) => e.stepId === PRODUCER)!;
  entry.entailsWhen!.push(...entry.entailsWhen!);
  expect(() => parseDerivedRunPlan(plan)).not.toThrow();
});
it.each(['provides', 'requires', 'loopTargetStepId', 'closes'] as const)(
  'rejects a pinned effective entry violating host %s',
  (field) => {
    const plan = effectivePin();
    const entry = plan.candidates[0]!.effectiveEntries!.find((e) => e.stepId === PRODUCER)!;
    Object.assign(entry, {
      [field]: field === 'closes' ? true : field === 'loopTargetStepId' ? 'other' : [],
    });
    expect(() => parseDerivedRunPlan(plan)).toThrow('missing or malformed');
  },
);
