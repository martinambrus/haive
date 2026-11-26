import { afterEach, expect, it, vi } from 'vitest';
import { logger } from '@haive/shared';
import type { StepDefinition } from '@haive/shared/step';
import { registerModuleSteps } from '../src/modules/loader.js';
import { resolveFixLoopTarget } from '../src/queues/run-list.js';
import { unsupportedPinnedFixTarget } from '../src/step-engine/fix-consumer.js';
import { assertWorkerExecutionContractSupported } from '../src/step-engine/execution-contract-support.js';
import { StepRegistry } from '../src/step-engine/registry.js';

const id = 'module.fx.mine';
const pin = { version: 1, guardedSpans: [], fixTarget: { stepId: id, capabilityVersion: 1 } };
const mining = {
  metadata: { id, workflowType: 'module.fx', title: 'Mine', index: 1, requiresCli: false },
  fixConsumer: { version: 1 },
  editsCodeOrTests: true,
  agentMining: {},
} as unknown as StepDefinition;
afterEach(() => vi.restoreAllMocks());

it.each(['helper', 'router', 'fence'])('names fan-out in the %s refusal', (site) => {
  const registry = new StepRegistry();
  registry.register(mining);
  const task = { executionContract: pin, runListSnapshot: [id] };
  if (site === 'helper') expect(unsupportedPinnedFixTarget(task, registry)).toContain('fan-out');
  const routed = resolveFixLoopTarget({
    taskType: 'fx',
    runList: [mining],
    registry,
    executionContract: pin,
    fixLoop: null,
  });
  if (site === 'router')
    expect(routed).toMatchObject({ ok: false, reason: expect.stringContaining('fan-out') });
  if (site === 'fence')
    expect(() =>
      assertWorkerExecutionContractSupported(
        pin,
        { runListStrategy: 'static', runListSnapshot: [id] },
        registry,
      ),
    ).toThrow('fan-out');
});

it.each(['helper', 'router', 'fence'])(
  'keeps the ordinary refusal for fan-out without a declared fix consumer (%s)',
  (site) => {
    const registry = new StepRegistry();
    const def = { ...mining, fixConsumer: undefined };
    registry.register(def);
    const task = { executionContract: pin, runListSnapshot: [id] };
    if (site === 'helper') {
      const reason = unsupportedPinnedFixTarget(task, registry);
      expect(reason).toContain('not a registered module step');
      expect(reason).not.toContain('fan-out');
    } else if (site === 'router') {
      const result = resolveFixLoopTarget({
        taskType: 'fx',
        runList: [def],
        registry,
        executionContract: pin,
        fixLoop: null,
      });
      expect(result).toMatchObject({
        ok: false,
        reason: expect.stringContaining('not a registered module step'),
      });
      expect(result).toMatchObject({ reason: expect.not.stringContaining('fan-out') });
    } else {
      const check = () =>
        assertWorkerExecutionContractSupported(
          pin,
          { runListStrategy: 'static', runListSnapshot: [id] },
          registry,
        );
      expect(check).toThrow('not a registered module fix consumer');
      expect(check).not.toThrow('fan-out');
    }
  },
);

it('warns once per withheld step, including a step without a composable entry, with only its id', () => {
  const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
  const steps = ['mine', 'other', 'writer', 'reader'].map((local) => ({
    ...mining,
    metadata: { ...mining.metadata, id: local },
    ...(local === 'writer' ? { agentMining: undefined } : {}),
    ...(local === 'reader' ? { fixConsumer: undefined } : {}),
  }));
  const [loaded] = registerModuleSteps(new StepRegistry(), [
    {
      packageName: '@haive/module-fx',
      manifest: {
        id: 'fx',
        name: 'Fx',
        version: '1',
        schemaVersion: 1,
        composableSteps: [
          {
            stepId: 'mine',
            label: 'Mine',
            group: 'test',
            requires: [],
            provides: [],
            dispatchesCli: false,
            fixConsumer: { version: 1 },
          },
        ],
      },
      steps,
    },
  ]);
  expect(loaded!.composable[0]!.fixConsumer).toBeUndefined();
  expect(warn.mock.calls).toEqual([
    [{ stepId: id }, expect.stringContaining('fan-out')],
    [{ stepId: 'module.fx.other' }, expect.stringContaining('fan-out')],
  ]);
});
