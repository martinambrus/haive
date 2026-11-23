import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ExecutionContractError } from '@haive/shared/modularity';
import type { StepDefinition } from '@haive/shared/step';
import { assertWorkerExecutionContractSupported } from '../src/step-engine/execution-contract-support.js';
import { buildRunList } from '../src/queues/run-list.js';
import { deadTaskResolution } from '../src/queues/dead-task-boot.js';
import { StepRegistry, stepRegistry } from '../src/step-engine/registry.js';

type Strategy = Parameters<typeof deadTaskResolution>[1];
const ids = ['fx-plan', 'fx-a', 'fx-b', 'fx-report'];
const PREDICATE = 'module.fx.guard';
const argsSchema = z.strictObject({});
const evaluate = async () => true;

function stub(id: string, index: number, workflowType: string, provides: boolean): StepDefinition {
  return {
    metadata: {
      id,
      workflowType,
      index,
      title: id,
      description: 'fence test stub',
      requiresCli: false,
    },
    detect: async () => ({}),
    apply: async () => ({}),
    ...(provides ? { guardPredicates: { guard: { argsSchema, evaluate } } } : {}),
  } as StepDefinition;
}
function registryOf(providerType: string | null): StepRegistry {
  const registry = new StepRegistry();
  ids.forEach((id, i) =>
    registry.register(
      stub(id, i, i === 1 && providerType ? providerType : 'workflow', i === 1 && !!providerType),
    ),
  );
  return registry;
}
for (const [i, id] of ids.entries())
  stepRegistry.register(stub(id, i, i === 1 ? 'module.fx' : 'workflow', i === 1));

const span = (over: Record<string, unknown> = {}) => ({
  id: 'work',
  firstStepId: 'fx-a',
  lastStepId: 'fx-b',
  predicateId: PREDICATE,
  args: {},
  ...over,
});
const guarded = (over: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({
  version: 1,
  guardedSpans: [span(over)],
  ...extra,
});

interface Scope {
  runListStrategy: Strategy;
  runListSnapshot: string[] | null | undefined;
  derivedRunPlan?: unknown;
}
interface Row {
  name: string;
  raw: unknown;
  scope?: Partial<Scope>;
  registry?: StepRegistry;
}
const base = (scope: Partial<Scope> = {}): Scope => ({
  runListStrategy: 'static',
  runListSnapshot: ids,
  derivedRunPlan: null,
  ...scope,
});

const supported: Row[] = [
  { name: 'S2 guarded static pin', raw: guarded() },
  {
    name: 'S2 two spans, second ends the list',
    raw: {
      version: 1,
      guardedSpans: [
        span(),
        span({
          id: 'tail',
          firstStepId: 'fx-report',
          lastStepId: 'fx-report',
          requiresSpan: 'work',
          when: false,
        }),
      ],
    },
  },
  { name: 'S2 span of one step at index 1', raw: guarded({ lastStepId: 'fx-a' }) },
];
const refused: Row[] = [
  {
    name: 'R1 fixTarget alone',
    raw: { version: 1, guardedSpans: [], fixTarget: { stepId: 'gone', capabilityVersion: 1 } },
  },
  {
    name: 'R1 fixTarget naming a listed step',
    raw: { version: 1, guardedSpans: [], fixTarget: { stepId: 'fx-a', capabilityVersion: 1 } },
  },
  {
    name: 'R1 fixTarget with spans',
    raw: guarded({}, { fixTarget: { stepId: 'fx-a', capabilityVersion: 1 } }),
  },
  ...(['derived', 'workflow_paths', 'run_app_modes'] as const).map((runListStrategy) => ({
    name: `R2 guarded under ${runListStrategy}`,
    raw: guarded(),
    scope: { runListStrategy },
  })),
  {
    name: 'R3 derived run plan present',
    raw: guarded(),
    scope: { derivedRunPlan: { version: 2, candidates: [] } },
  },
  { name: 'R4 snapshot null', raw: guarded(), scope: { runListSnapshot: null } },
  { name: 'R4 snapshot undefined', raw: guarded(), scope: { runListSnapshot: undefined } },
  {
    name: 'R5 duplicate snapshot id',
    raw: guarded(),
    scope: { runListSnapshot: [...ids, 'fx-a'] },
  },
  { name: 'R6 predicate no step provides', raw: guarded({ predicateId: 'module.fx.missing' }) },
  { name: 'R6 empty registry', raw: guarded(), registry: new StepRegistry() },
  { name: 'R6 provider is not a module step', raw: guarded(), registry: registryOf('workflow') },
  { name: 'R7 entry at index 0', raw: guarded({ firstStepId: 'fx-plan', lastStepId: 'fx-a' }) },
  { name: 'R8 first endpoint absent', raw: guarded({ firstStepId: 'nope' }) },
  { name: 'R8 last endpoint absent', raw: guarded({ lastStepId: 'nope' }) },
  { name: 'R8 last before first', raw: guarded({ firstStepId: 'fx-b', lastStepId: 'fx-a' }) },
  { name: 'R8 unknown requiresSpan', raw: guarded({ requiresSpan: 'nope' }) },
  { name: 'R8 args fail the schema', raw: guarded({ args: { extra: 1 } }) },
  { name: 'R9 unknown version', raw: { version: 99, guardedSpans: [] } },
  { name: 'R9 unknown top-level key', raw: { version: 1, guardedSpans: [], extra: true } },
  { name: 'R9 unknown span key', raw: guarded({ extra: true }) },
];

const ctxOf = (row: Row) => {
  const scope = base(row.scope);
  return {
    taskId: 'task',
    workflowType: 'test',
    currentStepId: null,
    customSteps: null,
    executionContract: row.raw,
    ...scope,
  };
};
const taskOf = (row: Row) => ({
  id: 'task',
  type: 'test',
  currentStepId: null,
  customSteps: null,
  runListSnapshot: base(row.scope).runListSnapshot ?? null,
  derivedRunPlan: base(row.scope).derivedRunPlan,
  executionContract: row.raw,
});
const regOf = (row: Row) => row.registry ?? stepRegistry;

describe('worker execution fence: supported shapes', () => {
  it.each(supported.map((r) => [r.name, r] as const))('%s', async (_name, row) => {
    const scope = base(row.scope);
    expect(() => assertWorkerExecutionContractSupported(row.raw, scope, regOf(row))).not.toThrow();
    const resolution = deadTaskResolution(
      taskOf(row),
      scope.runListStrategy,
      regOf(row) as StepRegistry,
    );
    expect(resolution.supportReason).toBeUndefined();
    const list = await buildRunList(ctxOf(row) as never, {} as never);
    expect(list.map((s) => s.metadata.id)).toEqual(ids);
  });
});

describe('worker execution fence: no contract and an empty contract', () => {
  const strategies: Strategy[] = ['static', 'derived', 'workflow_paths', 'run_app_modes'];
  const snapshots = [null, undefined, ids];
  it.each([null, undefined, { version: 1, guardedSpans: [] }])(
    'accepts %j under every scope',
    (raw) => {
      for (const runListStrategy of strategies)
        for (const runListSnapshot of snapshots)
          expect(() =>
            assertWorkerExecutionContractSupported(
              raw,
              { runListStrategy, runListSnapshot },
              new StepRegistry(),
            ),
          ).not.toThrow();
    },
  );
  it.each([null, undefined, { version: 1, guardedSpans: [] }])(
    'keeps %j through the run list and boot',
    async (raw) => {
      const row: Row = { name: 'plain', raw };
      expect(deadTaskResolution(taskOf(row), 'static', stepRegistry).supportReason).toBeUndefined();
      const list = await buildRunList(ctxOf(row) as never, {} as never);
      expect(list.map((s) => s.metadata.id)).toEqual(ids);
    },
  );
});

describe('worker execution fence: refused shapes', () => {
  it.each(refused.map((r) => [r.name, r] as const))('%s', async (_name, row) => {
    const scope = base(row.scope);
    let thrown: unknown;
    try {
      assertWorkerExecutionContractSupported(row.raw, scope, regOf(row));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ExecutionContractError);
    expect(thrown).toMatchObject({ code: 'invalid-execution-contract' });
    const resolution = deadTaskResolution(
      taskOf(row),
      scope.runListStrategy,
      regOf(row) as StepRegistry,
    );
    expect(typeof resolution.supportReason).toBe('string');
    expect(resolution.supportReason!.length).toBeGreaterThan(0);
    expect(resolution.unresolved).toEqual([]);
    if (!row.registry) {
      const built = buildRunList(ctxOf(row) as never, {} as never);
      await expect(built).rejects.toBeInstanceOf(ExecutionContractError);
      await expect(built).rejects.toMatchObject({ code: 'invalid-execution-contract' });
    }
  });
});

it.each([[], [span()]].map((guardedSpans) => ({ guardedSpans })))(
  'admits a capable module target with spans $guardedSpans',
  ({ guardedSpans }) => {
    const target = 'module.fx.repair';
    const registry = registryOf('module.fx');
    registry.register({
      ...stub(target, 0, 'module.fx', false),
      fixConsumer: { version: 1 },
      editsCodeOrTests: true,
    });
    const pin = { version: 1, guardedSpans, fixTarget: { stepId: target, capabilityVersion: 1 } };
    const scope = { runListStrategy: 'static' as const, runListSnapshot: [target, ...ids] };
    expect(() => assertWorkerExecutionContractSupported(pin, scope, registry)).not.toThrow();
    // Isolate membership: this executable is registered and capable, but off-list.
    expect(() =>
      assertWorkerExecutionContractSupported(
        pin,
        {
          ...scope,
          runListSnapshot: ids,
        },
        registry,
      ),
    ).toThrow(target);
    for (const stepId of ['module.fx.gone', 'fx-a', 'custom.fx.repair']) {
      expect(() =>
        assertWorkerExecutionContractSupported(
          { ...pin, fixTarget: { stepId, capabilityVersion: 1 } },
          scope,
          registry,
        ),
      ).toThrow(stepId);
    }
    (registry.get(target) as { fixConsumer: unknown }).fixConsumer = undefined;
    expect(() => assertWorkerExecutionContractSupported(pin, scope, registry)).toThrow(target);
  },
);
