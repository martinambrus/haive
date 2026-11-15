import { describe, expect, it } from 'vitest';
import {
  readStepRole,
  projectStepOutputRoles,
  STEP_ROLES,
} from '../src/step-engine/step-role-reader.js';
import { DerivedRunPlanError, parseDerivedRunPlan } from '../src/modularity/derived-task-types.js';
import { CODE_REVIEW_OUTPUT_CONTRACT } from '../src/step-engine/output-contracts.js';
import { REVIEW, AUDIT, PRODUCER, rolePlan, rolePin } from './step-role-fixtures.js';

const resolve = (
  pin: Parameters<typeof readStepRole>[0],
  role: import('../src/step-engine/output-contracts.js').StepRoleId = STEP_ROLES.codeReview,
) => readStepRole(pin, role, (b) => b);
describe('one pinned role reader', () => {
  it.each([
    {},
    { executionPath: null },
    { executionPath: 'quick_bugfix' },
    { executionPath: 'plan_tasklist' },
    { executionPath: 'full_workflow' },
    { runListSnapshot: ['module.example.review'] },
  ])('keeps builtin/static/no-plan identity %j', (pin) => {
    expect(resolve(pin)).toEqual({
      role: REVIEW,
      stepId: REVIEW,
      outputContract: null,
      state: 'active',
    });
  });
  it('leaves builtin non-role rows unchanged', () => {
    const ordinary = { stepId: '07-phase-2-implement', title: 'Implement' };
    expect(projectStepOutputRoles({}, [ordinary])).toEqual([ordinary]);
  });
  it('keeps strict v1 identity on selected paths and does not rewrite pins', () => {
    const pin = rolePin(1);
    const before = JSON.stringify(pin);
    expect(resolve(pin).stepId).toBe(REVIEW);
    expect(JSON.stringify(pin)).toBe(before);
    expect(parseDerivedRunPlan(pin.derivedRunPlan).version).toBe(1);
  });
  it('returns absent for a removed role and unselected before triage', () => {
    const pin = rolePin(1);
    const plan = pin.derivedRunPlan;
    for (const c of plan.candidates) (c.stepIds as string[]).splice(c.stepIds.indexOf(REVIEW), 1);
    expect(resolve({ ...pin, runListSnapshot: plan.candidates[3]!.stepIds })).toMatchObject({
      state: 'absent',
      stepId: null,
    });
    expect(resolve({ ...rolePin(1), executionPath: null })).toMatchObject({
      state: 'unselected',
      stepId: null,
    });
  });
  it('resolves v2 by the selected immutable binding and projects only actual producers', () => {
    const pin = rolePin();
    expect(resolve(pin)).toEqual({
      role: REVIEW,
      stepId: PRODUCER,
      outputContract: CODE_REVIEW_OUTPUT_CONTRACT,
      state: 'active',
    });
    expect(resolve(pin, STEP_ROLES.codeAudit).stepId).toBe(AUDIT);
    expect(
      projectStepOutputRoles(pin, [
        { stepId: PRODUCER },
        { stepId: REVIEW },
        { stepId: 'module.other.review' },
      ]),
    ).toEqual([
      { stepId: PRODUCER, outputRoles: [REVIEW] },
      { stepId: REVIEW },
      { stepId: 'module.other.review' },
    ]);
  });
  it.each([
    (p: any) => {
      p.version = 3;
    },
    (p: any) => {
      p.candidates[3].roleBindings[REVIEW].stepId = 'missing';
    },
    (p: any) => {
      p.candidates[3].roleBindings[REVIEW].outputContract.version = 2;
    },
    (p: any) => {
      p.candidates[3].roleBindings[REVIEW].outputContract.id = 'haive.code-audit';
    },
    (p: any) => {
      p.candidates[3].roleBindings[AUDIT] = p.candidates[3].roleBindings[REVIEW];
    },
    (p: any) => {
      p.candidates[3].stepIds.push(REVIEW);
    },
    (p: any) => {
      p.candidates[3].outcomes[0].outcome = 'path-absent';
    },
    (p: any) => {
      delete p.candidates[3].roleBindings[REVIEW];
    },
    (p: any) => {
      p.composableEntries[0].replaces = [];
    },
    (p: any) => {
      p.candidates[3].roleBindings.extra = {};
    },
    (p: any) => {
      p.candidates[3].stepIds.reverse();
    },
  ])('refuses malformed v2 pins without fallback %#', (corrupt) => {
    const pin = structuredClone(rolePin());
    corrupt(pin.derivedRunPlan);
    expect(() => resolve(pin)).toThrow(DerivedRunPlanError);
  });
  it('refuses a required missing pin, invalid path and mismatched snapshot', () => {
    for (const pin of [
      { runListStrategy: 'derived' },
      { ...rolePin(), executionPath: 'bogus' },
      { ...rolePin(), runListSnapshot: [] },
    ])
      expect(() => resolve(pin)).toThrow(DerivedRunPlanError);
  });
  it('accepts path-absent replacement outcomes without borrowing another candidate binding', () => {
    const pin = structuredClone(rolePin());
    const plan =
      pin.derivedRunPlan as import('../src/modularity/derived-task-types.js').DerivedRunPlanV2;
    const base = plan.base.candidates.find((c) => c.executionPath === 'quick_bugfix')!;
    (base.stepIds as string[]).splice(base.stepIds.indexOf(REVIEW), 1);
    const c = plan.candidates.find((c) => c.executionPath === 'quick_bugfix')!;
    (c.stepIds as string[]).splice(0, c.stepIds.length, ...base.stepIds);
    c.roleBindings = {};
    c.effectiveEntries = [];
    c.outcomes[0]!.outcome = 'path-absent';
    c.outcomes[0]!.reason = 'target-not-on-path';
    expect(
      resolve({ ...pin, executionPath: 'quick_bugfix', runListSnapshot: c.stepIds }),
    ).toMatchObject({ state: 'absent', stepId: null });
  });
  it('removing a replacement removes its binding, and later inserts address its physical anchor', () => {
    const pin = structuredClone(rolePin());
    const plan =
      pin.derivedRunPlan as import('../src/modularity/derived-task-types.js').DerivedRunPlanV2;
    const changes = [{ insertAfter: PRODUCER, step: 'module.example.notes' }, { remove: PRODUCER }];
    plan.overlay.changes.push(...changes);
    plan.composableEntries.push({
      stepId: 'module.example.notes',
      label: 'Notes',
      group: 'test',
      dispatchesCli: false,
      requires: [],
      provides: [],
    });
    for (const c of plan.candidates) {
      c.outcomes.push(
        ...changes.map((change, i) => ({
          change,
          operationIndex: i + 1,
          outcome: 'applied' as const,
          reason: 'change-applied' as const,
        })),
      );
      (c.stepIds as string[]).splice(c.stepIds.indexOf(PRODUCER), 1, 'module.example.notes');
      c.roleBindings = {};
      c.effectiveEntries = [];
    }
    expect(resolve({ ...pin, runListSnapshot: plan.candidates[3]!.stepIds })).toMatchObject({
      state: 'absent',
      stepId: null,
    });
  });
  it('refuses replacing a replacement, consumed anchors and canonical reintroduction', () => {
    for (const change of [
      { replace: PRODUCER, with: 'module.example.other' },
      { insertAfter: REVIEW, step: 'module.example.other' },
      { insertAfter: PRODUCER, step: REVIEW },
    ]) {
      const pin = structuredClone(rolePin());
      const plan =
        pin.derivedRunPlan as import('../src/modularity/derived-task-types.js').DerivedRunPlanV2;
      plan.overlay.changes.push(change);
      for (const c of plan.candidates)
        c.outcomes.push({
          change,
          operationIndex: 1,
          outcome: 'applied',
          reason: 'change-applied',
        });
      expect(() => resolve(pin)).toThrow(DerivedRunPlanError);
    }
  });
  it('does not add binding fields to v1', () => {
    const p = rolePlan(1) as any;
    p.candidates[0].roleBindings = {};
    expect(() => parseDerivedRunPlan(p)).toThrow(DerivedRunPlanError);
  });
});
