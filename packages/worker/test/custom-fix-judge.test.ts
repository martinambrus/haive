import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ExecutionContractError } from '@haive/shared/modularity';
import { deadTaskResolution } from '../src/queues/dead-task-boot.js';
import { StepRegistry } from '../src/step-engine/registry.js';
import type { StepDefinition } from '../src/step-engine/step-definition.js';

const fence = vi.hoisted(() => ({ assert: vi.fn() }));
vi.mock('../src/step-engine/execution-contract-support.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/step-engine/execution-contract-support.js')>()),
  assertWorkerExecutionContractSupported: fence.assert,
}));

const TARGET = 'module.cfj-fix.target';
const CORE = '07-phase-2-implement';
const REVIEW = 'cfj-review';
const AFTER = 'cfj-after';

const stub = (id: string, index: number, extra: object = {}): StepDefinition =>
  ({
    metadata: {
      id,
      workflowType: 'workflow',
      index,
      title: id,
      description: id,
      requiresCli: false,
    },
    detect: async () => ({}),
    form: () => null,
    apply: async () => ({}),
    ...extra,
  }) as unknown as StepDefinition;

const capable = { fixConsumer: { version: 1 }, editsCodeOrTests: true };

const registryOf = (...steps: StepDefinition[]): StepRegistry => {
  const registry = new StepRegistry();
  for (const def of steps) registry.register(def);
  return registry;
};

const pinOf = (stepId: string, capabilityVersion = 1) => ({
  version: 1,
  guardedSpans: [],
  fixTarget: { stepId, capabilityVersion },
});

const task = (over: Partial<Parameters<typeof deadTaskResolution>[0]> = {}) => ({
  id: 'cfj-task',
  type: 'workflow',
  currentStepId: REVIEW as string | null,
  runListSnapshot: [TARGET, REVIEW, AFTER] as string[] | null,
  customSteps: null,
  ...over,
});

const CONTRACT_REFUSED = new ExecutionContractError('refused').code;
const ORDINARY = { unresolved: [], outsideList: null };

describe('deadTaskResolution with the fence open', () => {
  beforeEach(() => fence.assert.mockReset());

  describe('a task the fix target does not constrain', () => {
    it('no pin resolves clean', () => {
      const registry = registryOf(stub(REVIEW, 1), stub(AFTER, 2), stub(TARGET, 0));
      expect(deadTaskResolution(task({ executionContract: null }), 'static', registry)).toEqual(
        ORDINARY,
      );
    });

    it('an empty pin resolves clean', () => {
      const registry = registryOf(stub(REVIEW, 1), stub(AFTER, 2), stub(TARGET, 0));
      const empty = { version: 1, guardedSpans: [] };
      expect(deadTaskResolution(task({ executionContract: empty }), 'static', registry)).toEqual(
        ORDINARY,
      );
    });

    it('a capable target in the snapshot resolves clean', () => {
      const registry = registryOf(stub(REVIEW, 1), stub(AFTER, 2), stub(TARGET, 0, capable));
      expect(
        deadTaskResolution(task({ executionContract: pinOf(TARGET) }), 'static', registry),
      ).toEqual(ORDINARY);
    });

    it('a capable target is no obstacle while the task sits on it', () => {
      const registry = registryOf(stub(REVIEW, 1), stub(AFTER, 2), stub(TARGET, 0, capable));
      expect(
        deadTaskResolution(
          task({ executionContract: pinOf(TARGET), currentStepId: TARGET }),
          'static',
          registry,
        ),
      ).toEqual(ORDINARY);
    });
  });

  describe('a target no worker can run as a fix round', () => {
    const ON_LIST = [TARGET, REVIEW, AFTER];
    const OFF_LIST = [REVIEW, AFTER];
    const incapable: [string, () => StepRegistry, string[]][] = [
      [
        'registered without fixConsumer',
        () => registryOf(stub(REVIEW, 1), stub(AFTER, 2), stub(TARGET, 0)),
        ON_LIST,
      ],
      [
        'with agentMining set',
        () =>
          registryOf(
            stub(REVIEW, 1),
            stub(AFTER, 2),
            stub(TARGET, 0, { ...capable, agentMining: { agents: [] } }),
          ),
        ON_LIST,
      ],
      [
        'unregistered and off the snapshot',
        () => registryOf(stub(REVIEW, 1), stub(AFTER, 2)),
        OFF_LIST,
      ],
      [
        'capable but off the snapshot',
        () => registryOf(stub(REVIEW, 1), stub(AFTER, 2), stub(TARGET, 0, capable)),
        OFF_LIST,
      ],
    ];
    it.each(incapable)(
      '%s names the target and lists nothing unresolved',
      (_n, build, snapshot) => {
        const found = deadTaskResolution(
          task({ executionContract: pinOf(TARGET), runListSnapshot: snapshot }),
          'static',
          build(),
        );
        expect(typeof found.supportReason).toBe('string');
        expect(found.supportReason).toContain(TARGET);
        expect(found.unresolved).toEqual([]);
      },
    );

    it('a core step named by the pin is refused', () => {
      const registry = registryOf(stub(REVIEW, 1), stub(AFTER, 2), stub(CORE, 0, capable));
      const found = deadTaskResolution(
        task({ executionContract: pinOf(CORE), runListSnapshot: [CORE, REVIEW, AFTER] }),
        'static',
        registry,
      );
      expect(typeof found.supportReason).toBe('string');
      expect(found.supportReason).toContain(CORE);
      expect(found.unresolved).toEqual([]);
    });

    it('a fixConsumer version that differs from the pin is refused', () => {
      const registry = registryOf(stub(REVIEW, 1), stub(AFTER, 2), stub(TARGET, 0, capable));
      (registry.get(TARGET) as unknown as { fixConsumer: unknown }).fixConsumer = { version: 2 };
      const found = deadTaskResolution(
        task({ executionContract: pinOf(TARGET) }),
        'static',
        registry,
      );
      expect(typeof found.supportReason).toBe('string');
      expect(found.supportReason).toContain(TARGET);
      expect(found.unresolved).toEqual([]);
    });

    it('an unregistered target in the snapshot stays unresolved', () => {
      const registry = registryOf(stub(REVIEW, 1), stub(AFTER, 2));
      const found = deadTaskResolution(
        task({ executionContract: pinOf(TARGET) }),
        'static',
        registry,
      );
      expect(found.unresolved).toContain(TARGET);
      expect(found.outsideList).toBeNull();
    });

    it('a malformed pin is refused with a reason', () => {
      const registry = registryOf(stub(REVIEW, 1), stub(AFTER, 2), stub(TARGET, 0, capable));
      const found = deadTaskResolution(
        task({ executionContract: { version: 1, fixTarget: 'nope' } }),
        'static',
        registry,
      );
      expect(typeof found.supportReason).toBe('string');
      expect(found.unresolved).toEqual([]);
    });
  });
});

describe('deadTaskResolution with the real fence', () => {
  beforeEach(async () => {
    const actual = await vi.importActual<
      typeof import('../src/step-engine/execution-contract-support.js')
    >('../src/step-engine/execution-contract-support.js');
    fence.assert.mockReset();
    fence.assert.mockImplementation(actual.assertWorkerExecutionContractSupported);
  });

  it('refuses any fixTarget, even a capable one', () => {
    const registry = registryOf(stub(REVIEW, 1), stub(AFTER, 2), stub(TARGET, 0, capable));
    const found = deadTaskResolution(
      task({ executionContract: pinOf(TARGET) }),
      'static',
      registry,
    );
    expect(found).toMatchObject({ unresolved: [], outsideList: null });
    expect(found.supportReason).toContain(CONTRACT_REFUSED);
  });

  it('refuses an incapable fixTarget the same way', () => {
    const registry = registryOf(stub(REVIEW, 1), stub(AFTER, 2));
    const found = deadTaskResolution(
      task({ executionContract: pinOf(TARGET) }),
      'static',
      registry,
    );
    expect(found).toMatchObject({ unresolved: [], outsideList: null });
    expect(found.supportReason).toContain(CONTRACT_REFUSED);
  });

  it('leaves an unpinned task alone', () => {
    const registry = registryOf(stub(REVIEW, 1), stub(AFTER, 2), stub(TARGET, 0));
    expect(deadTaskResolution(task({ executionContract: null }), 'static', registry)).toEqual(
      ORDINARY,
    );
  });
});

describe('deadTaskResolution for a task with no run list snapshot', () => {
  beforeEach(() => fence.assert.mockReset());
  const noList = (over: Partial<Parameters<typeof deadTaskResolution>[0]> = {}) =>
    task({ runListSnapshot: null, currentStepId: REVIEW, ...over });

  it('lists an unregistered pinned target as unresolved', () => {
    const registry = registryOf(stub(REVIEW, 1), stub(AFTER, 2));
    expect(
      deadTaskResolution(noList({ executionContract: pinOf(TARGET) }), 'workflow_paths', registry),
    ).toEqual({ unresolved: [TARGET], outsideList: null });
  });

  it('answers a task with no pin exactly as before', () => {
    const registry = registryOf(stub(REVIEW, 1), stub(AFTER, 2));
    expect(
      deadTaskResolution(noList({ executionContract: null }), 'workflow_paths', registry),
    ).toEqual(ORDINARY);
  });

  it('leaves a registered capable pinned target alone', () => {
    const registry = registryOf(stub(REVIEW, 1), stub(AFTER, 2), stub(TARGET, 0, capable));
    expect(
      deadTaskResolution(noList({ executionContract: pinOf(TARGET) }), 'workflow_paths', registry),
    ).toEqual(ORDINARY);
  });
});
