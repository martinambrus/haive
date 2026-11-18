import { describe, expect, it } from 'vitest';
import { ExecutionContractError } from '@haive/shared/modularity';
import type { FixLoopDef } from '../src/queues/run-list.js';
import { resolveFixLoopTarget } from '../src/queues/run-list.js';
import type { StepDefinition } from '../src/step-engine/step-definition.js';
import { FIX_LOOP_TARGET_STEP_ID } from '../src/step-engine/steps/workflow/_fix-loop.js';

const TYPE = 'fx-type';
const MODULE_TARGET = 'module.fx.fix';

function def(id: string, fixConsumer?: unknown): StepDefinition {
  return {
    metadata: {
      id,
      workflowType: 'fx',
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
    ...(fixConsumer === undefined ? {} : { fixConsumer }),
  } as unknown as StepDefinition;
}

function registryOf(defs: StepDefinition[]) {
  return { get: (id: string) => defs.find((d) => d.metadata.id === id) };
}

const pin = (stepId: string, capabilityVersion: unknown = 1) => ({
  version: 1,
  guardedSpans: [],
  fixTarget: { stepId, capabilityVersion },
});
const EMPTY_PIN = { version: 1, guardedSpans: [] };

const liveLoop = (targetStepId: string): FixLoopDef => ({
  targetStepId,
  humanRejectSourceStepIds: [],
  honoredConstraintSourceStepIds: [],
});

const legacy07 = def(FIX_LOOP_TARGET_STEP_ID);
const capable = def(MODULE_TARGET, { version: 1 });

const notCapable = (id: string) =>
  `fix loop target ${id} of task type ${TYPE} is not a registered module step with fix consumer version 1`;
const offList = (id: string) => `fix loop target ${id} is not in the run list of task type ${TYPE}`;

describe('resolveFixLoopTarget without a pinned fix target (legacy path untouched)', () => {
  const runList = [legacy07, capable];
  const registry = registryOf([legacy07, capable]);
  for (const [name, executionContract] of [
    ['no pin', undefined],
    ['a null pin', null],
    ['an empty pin', EMPTY_PIN],
  ] as const) {
    it(`resolves the implement step with ${name}`, () => {
      const resolved = resolveFixLoopTarget({
        taskType: TYPE,
        fixLoop: null,
        runList,
        registry,
        executionContract,
      });
      expect(resolved).toEqual({ ok: true, def: legacy07 });
    });

    it(`keeps the off-list sentence with ${name}`, () => {
      const resolved = resolveFixLoopTarget({
        taskType: TYPE,
        fixLoop: null,
        runList: [capable],
        registry,
        executionContract,
      });
      expect(resolved).toEqual({ ok: false, reason: offList(FIX_LOOP_TARGET_STEP_ID) });
    });

    it(`keeps the cannot-read-the-diagnosis sentence for another live target with ${name}`, () => {
      const resolved = resolveFixLoopTarget({
        taskType: TYPE,
        fixLoop: liveLoop('08c-code-review'),
        runList,
        registry,
        executionContract,
      });
      expect(resolved).toEqual({
        ok: false,
        reason: `fix loop target 08c-code-review of task type ${TYPE} cannot read the fix diagnosis; only ${FIX_LOOP_TARGET_STEP_ID} can`,
      });
    });
  }

  it('keeps the cannot-read-the-diagnosis sentence for a live module target the pin does not name', () => {
    const resolved = resolveFixLoopTarget({
      taskType: TYPE,
      fixLoop: liveLoop(MODULE_TARGET),
      runList,
      registry,
      executionContract: EMPTY_PIN,
    });
    expect(resolved).toEqual({
      ok: false,
      reason: `fix loop target ${MODULE_TARGET} of task type ${TYPE} cannot read the fix diagnosis; only ${FIX_LOOP_TARGET_STEP_ID} can`,
    });
  });
});

describe('resolveFixLoopTarget with a pinned fix target', () => {
  const args = (over: Partial<Parameters<typeof resolveFixLoopTarget>[0]>) => ({
    taskType: TYPE,
    fixLoop: null,
    runList: [legacy07, capable],
    registry: registryOf([legacy07, capable]),
    executionContract: pin(MODULE_TARGET),
    ...over,
  });

  it('resolves a capable module step that is in the run list and registered', () => {
    expect(resolveFixLoopTarget(args({}))).toEqual({ ok: true, def: capable });
  });

  it('resolves it when 07 is absent from the run list', () => {
    expect(resolveFixLoopTarget(args({ runList: [capable] }))).toEqual({
      ok: true,
      def: capable,
    });
  });

  it('lets a pin that names a target win over a live fix loop pointing elsewhere', () => {
    expect(resolveFixLoopTarget(args({ fixLoop: liveLoop('08c-code-review') }))).toEqual({
      ok: true,
      def: capable,
    });
    expect(resolveFixLoopTarget(args({ fixLoop: liveLoop(FIX_LOOP_TARGET_STEP_ID) }))).toEqual({
      ok: true,
      def: capable,
    });
  });

  it('refuses a target that is not registered, never falling back to 07', () => {
    expect(
      resolveFixLoopTarget(
        args({ registry: registryOf([legacy07]), runList: [legacy07, capable] }),
      ),
    ).toEqual({ ok: false, reason: notCapable(MODULE_TARGET) });
  });

  it('checks the capability before the run list: unregistered and off-list reads as not capable', () => {
    expect(
      resolveFixLoopTarget(args({ registry: registryOf([legacy07]), runList: [legacy07] })),
    ).toEqual({ ok: false, reason: notCapable(MODULE_TARGET) });
  });

  it('refuses a registered module step without the fix consumer capability', () => {
    const plain = def(MODULE_TARGET);
    expect(resolveFixLoopTarget(args({ registry: registryOf([plain]), runList: [plain] }))).toEqual(
      { ok: false, reason: notCapable(MODULE_TARGET) },
    );
  });

  it('refuses a capability of another version than the pin names', () => {
    const v2 = def(MODULE_TARGET, { version: 2 });
    expect(resolveFixLoopTarget(args({ registry: registryOf([v2]), runList: [v2] }))).toEqual({
      ok: false,
      reason: notCapable(MODULE_TARGET),
    });
  });

  it('refuses a capable module step that runs as a fan-out', () => {
    const fanOut = { ...def(MODULE_TARGET, { version: 1 }), agentMining: {} } as StepDefinition;
    expect(
      resolveFixLoopTarget(args({ registry: registryOf([fanOut]), runList: [fanOut] })),
    ).toEqual({ ok: false, reason: notCapable(MODULE_TARGET) });
  });

  it('refuses a core step id even when the registry marks it capable', () => {
    const marked = def(FIX_LOOP_TARGET_STEP_ID, { version: 1 });
    expect(
      resolveFixLoopTarget(
        args({
          executionContract: pin(FIX_LOOP_TARGET_STEP_ID),
          registry: registryOf([marked]),
          runList: [marked],
        }),
      ),
    ).toEqual({ ok: false, reason: notCapable(FIX_LOOP_TARGET_STEP_ID) });
    const core = def('08c-code-review', { version: 1 });
    expect(
      resolveFixLoopTarget(
        args({
          executionContract: pin('08c-code-review'),
          registry: registryOf([core]),
          runList: [core],
        }),
      ),
    ).toEqual({ ok: false, reason: notCapable('08c-code-review') });
  });

  it('refuses a custom prompt step even when the registry marks it capable', () => {
    const prompt = def('custom.fixer', { version: 1 });
    expect(
      resolveFixLoopTarget(
        args({
          executionContract: pin('custom.fixer'),
          registry: registryOf([prompt]),
          runList: [prompt],
        }),
      ),
    ).toEqual({ ok: false, reason: notCapable('custom.fixer') });
  });

  it('refuses a capable registered module step that is not in the run list, with the legacy sentence', () => {
    expect(resolveFixLoopTarget(args({ runList: [legacy07] }))).toEqual({
      ok: false,
      reason: offList(MODULE_TARGET),
    });
  });

  it.each([
    [
      'a non-array span list',
      { version: 1, guardedSpans: 'x', fixTarget: { stepId: MODULE_TARGET, capabilityVersion: 1 } },
    ],
    ['an unknown capability version', pin(MODULE_TARGET, 2)],
    ['an unknown pin version', { version: 99 }],
    [
      'an unexpected key inside the target',
      {
        ...pin(MODULE_TARGET),
        fixTarget: { stepId: MODULE_TARGET, capabilityVersion: 1, extra: 1 },
      },
    ],
  ])(
    'refuses a malformed pin (%s) by name instead of routing to 07',
    (_name, executionContract) => {
      expect(resolveFixLoopTarget(args({ executionContract }))).toEqual({
        ok: false,
        reason: `fix loop target of task type ${TYPE} cannot be read from its pinned execution contract`,
      });
    },
  );
});

describe('pinnedFixTarget', () => {
  const load = async () => (await import('../src/step-engine/fix-consumer.js')).pinnedFixTarget;

  it('reads no target from no pin, an empty pin or a pin without a target', async () => {
    const pinnedFixTarget = await load();
    expect(pinnedFixTarget(undefined)).toBeNull();
    expect(pinnedFixTarget(null)).toBeNull();
    expect(pinnedFixTarget(EMPTY_PIN)).toBeNull();
  });

  it('reads the pinned target', async () => {
    const pinnedFixTarget = await load();
    expect(pinnedFixTarget(pin(MODULE_TARGET))).toEqual({
      stepId: MODULE_TARGET,
      capabilityVersion: 1,
    });
  });

  it.each([
    ['an unknown pin version', { version: 99 }],
    ['a non-object', 'pinned'],
    ['an unknown capability version', pin(MODULE_TARGET, 2)],
    [
      'a stray key in the target',
      { ...pin(MODULE_TARGET), fixTarget: { stepId: 'a', capabilityVersion: 1, extra: 1 } },
    ],
  ])('throws the contract error for %s, never reading it as no target', async (_name, raw) => {
    const pinnedFixTarget = await load();
    expect(() => pinnedFixTarget(raw)).toThrow(ExecutionContractError);
  });
});

describe('resolvePinnedFixConsumer', () => {
  const load = async () =>
    (await import('../src/step-engine/fix-consumer.js')).resolvePinnedFixConsumer;
  const target = { stepId: MODULE_TARGET, capabilityVersion: 1 as const };

  it('resolves a registered module step with the pinned capability version', async () => {
    const resolvePinnedFixConsumer = await load();
    const result = resolvePinnedFixConsumer(target, registryOf([capable]));
    expect(result).toEqual({ ok: true, def: capable });
  });

  it.each([
    ['an unregistered step', []],
    ['a step without the capability', [def(MODULE_TARGET)]],
    ['a capability of another version', [def(MODULE_TARGET, { version: 2 })]],
    [
      'a capable fan-out step',
      [{ ...def(MODULE_TARGET, { version: 1 }), agentMining: {} } as StepDefinition],
    ],
  ])('refuses %s', async (_name, defs) => {
    const resolvePinnedFixConsumer = await load();
    const result = resolvePinnedFixConsumer(target, registryOf(defs));
    expect(result.ok).toBe(false);
  });

  it.each([FIX_LOOP_TARGET_STEP_ID, 'custom.fixer'])(
    'refuses the non-module id %s even when marked capable',
    async (id) => {
      const resolvePinnedFixConsumer = await load();
      const result = resolvePinnedFixConsumer(
        { stepId: id, capabilityVersion: 1 },
        registryOf([def(id, { version: 1 })]),
      );
      expect(result.ok).toBe(false);
    },
  );
});
