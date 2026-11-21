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
const notCapable = (id: string, version = 1) =>
  `the pinned fix target ${id} is not a registered module step with fix consumer version ${version} on this worker`;
const offList = (id: string) => `the pinned fix target ${id} is not in the run list of this task`;

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
    expect(unsupportedPinnedFixTarget(task, registryOf([def(TARGET)]))).toBe(notCapable(TARGET));
  });

  it.each([
    ['a registered step without the capability', def(TARGET)],
    ['a fan-out step', def(TARGET, { fixConsumer: { version: 1 }, agentMining: {} })],
    ['a fix consumer of another version', def(TARGET, { fixConsumer: { version: 2 } })],
  ])('names %s', (_name, step) => {
    expect(unsupportedPinnedFixTarget(taskOf(pin(TARGET)), registryOf([step]))).toBe(
      notCapable(TARGET),
    );
  });

  it('names a core step the contract pins, since only a module step can be a fix target', () => {
    const core = def(FIX_LOOP_TARGET_STEP_ID, { fixConsumer: { version: 1 } });
    const task = taskOf(pin(FIX_LOOP_TARGET_STEP_ID), [FIX_LOOP_TARGET_STEP_ID, OTHER]);
    expect(unsupportedPinnedFixTarget(task, registryOf([core]))).toBe(
      notCapable(FIX_LOOP_TARGET_STEP_ID),
    );
  });

  it.each([
    ['a capable target', [capable]],
    ['an unregistered target', []],
  ])('names %s that is not on the pinned run list', (_name, registered) => {
    expect(unsupportedPinnedFixTarget(taskOf(pin(TARGET), [OTHER]), registryOf(registered))).toBe(
      offList(TARGET),
    );
  });

  it('reads the candidates of a derived plan as the run list', () => {
    const task = { executionContract: pin(TARGET), derivedRunPlan: rolePlan(1) };
    expect(unsupportedPinnedFixTarget(task, registryOf([capable]))).toBe(offList(TARGET));
  });

  it('throws on a malformed contract instead of reading it as no target', () => {
    expect(() =>
      unsupportedPinnedFixTarget(taskOf({ version: 99 }), registryOf([capable])),
    ).toThrow(ExecutionContractError);
  });
});
