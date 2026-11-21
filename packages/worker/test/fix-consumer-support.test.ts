import { describe, expect, it } from 'vitest';
import { ExecutionContractError } from '@haive/shared/modularity';
import type { StepDefinition } from '../src/step-engine/step-definition.js';
import { unsupportedPinnedFixTarget } from '../src/step-engine/fix-consumer.js';
import { FIX_LOOP_TARGET_STEP_ID } from '../src/step-engine/steps/workflow/_fix-loop.js';
import { rolePlan } from './replacement-fixtures.js';

const TARGET = 'module.fcs.fix';
const OTHER = 'fcs-other';

function def(id: string, extra: Record<string, unknown> = {}): StepDefinition {
  return {
    metadata: {
      id,
      workflowType: 'fcs',
      index: 1,
      title: id,
      description: id,
      requiresCli: false,
    },
    async detect() {
      return {};
    },
    async apply() {
      return {};
    },
    ...extra,
  } as unknown as StepDefinition;
}

const registryOf = (defs: StepDefinition[]) => ({
  get: (id: string) => defs.find((d) => d.metadata.id === id),
});
const pin = (stepId: string, capabilityVersion: unknown = 1) => ({
  version: 1,
  guardedSpans: [],
  fixTarget: { stepId, capabilityVersion },
});
const taskOf = (
  executionContract: unknown,
  runListSnapshot: string[] | null = [TARGET, OTHER],
) => ({
  executionContract,
  runListSnapshot,
});
// Each refusal row varies one input, so a refusal alone says which check fired; the wording is free to change.
const refusedFor = (id: string) => expect.stringContaining(id);

describe('unsupportedPinnedFixTarget', () => {
  const capable = def(TARGET, { fixConsumer: { version: 1 } });

  it.each([
    ['no contract', undefined],
    ['a null contract', null],
    ['a contract with no fix target', { version: 1, guardedSpans: [] }],
  ])('names nothing for %s, whatever is registered or listed', (_name, contract) => {
    expect(unsupportedPinnedFixTarget(taskOf(contract, []), registryOf([def(OTHER)]))).toBeNull();
  });

  it('names nothing for a registered capable module step on the run list', () => {
    expect(unsupportedPinnedFixTarget(taskOf(pin(TARGET)), registryOf([capable]))).toBeNull();
  });

  it('leaves an unregistered target on the run list to the unresolved-step check', () => {
    expect(unsupportedPinnedFixTarget(taskOf(pin(TARGET)), registryOf([]))).toBeNull();
  });

  it('judges a task with no pinned run list by the registry alone', () => {
    const task = taskOf(pin(TARGET), null);
    expect(unsupportedPinnedFixTarget(task, registryOf([capable]))).toBeNull();
    expect(unsupportedPinnedFixTarget(task, registryOf([def(TARGET)]))).toEqual(refusedFor(TARGET));
  });

  it.each([
    ['a registered step without the capability', def(TARGET)],
    ['a fan-out step', def(TARGET, { fixConsumer: { version: 1 }, agentMining: {} })],
    ['a fix consumer of another version', def(TARGET, { fixConsumer: { version: 2 } })],
  ])('names %s', (_name, step) => {
    expect(unsupportedPinnedFixTarget(taskOf(pin(TARGET)), registryOf([step]))).toEqual(
      refusedFor(TARGET),
    );
  });

  it('names a core step the contract pins, since only a module step can be a fix target', () => {
    const core = def(FIX_LOOP_TARGET_STEP_ID, { fixConsumer: { version: 1 } });
    const task = taskOf(pin(FIX_LOOP_TARGET_STEP_ID), [FIX_LOOP_TARGET_STEP_ID, OTHER]);
    expect(unsupportedPinnedFixTarget(task, registryOf([core]))).toEqual(
      refusedFor(FIX_LOOP_TARGET_STEP_ID),
    );
  });

  it.each([
    ['a capable target', [capable]],
    ['an unregistered target', []],
  ])('names %s that is not on the pinned run list', (_name, registered) => {
    expect(
      unsupportedPinnedFixTarget(taskOf(pin(TARGET), [OTHER]), registryOf(registered)),
    ).toEqual(refusedFor(TARGET));
  });

  describe('a derived plan', () => {
    const planListing = (...paths: (string | null)[]) => {
      const plan = structuredClone(rolePlan(1)) as unknown as {
        candidates: { executionPath: string | null; stepIds: string[] }[];
      };
      for (const c of plan.candidates) if (paths.includes(c.executionPath)) c.stepIds.push(TARGET);
      return plan;
    };

    it('reads the candidates as the run list', () => {
      const task = { executionContract: pin(TARGET), derivedRunPlan: rolePlan(1) };
      expect(unsupportedPinnedFixTarget(task, registryOf([capable]))).toEqual(refusedFor(TARGET));
    });

    it.each([
      ['before triage chose a path, one candidate listing it is enough', null],
      ['on the chosen path that lists it', 'quick_bugfix'],
    ])('names nothing for a capable target: %s', (_name, executionPath) => {
      const task = {
        executionContract: pin(TARGET),
        derivedRunPlan: planListing('quick_bugfix'),
        executionPath,
      };
      expect(unsupportedPinnedFixTarget(task, registryOf([capable]))).toBeNull();
    });

    it('names a capable target the chosen path does not list', () => {
      const task = {
        executionContract: pin(TARGET),
        derivedRunPlan: planListing('quick_bugfix'),
        executionPath: 'full_workflow',
      };
      expect(unsupportedPinnedFixTarget(task, registryOf([capable]))).toEqual(refusedFor(TARGET));
    });
  });

  it('throws on a malformed contract instead of reading it as no target', () => {
    expect(() =>
      unsupportedPinnedFixTarget(taskOf({ version: 99 }), registryOf([capable])),
    ).toThrow(ExecutionContractError);
  });
});
