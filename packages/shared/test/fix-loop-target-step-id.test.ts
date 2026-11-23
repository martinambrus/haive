import { describe, expect, it } from 'vitest';
import {
  assertExecutionContractSupported,
  ExecutionContractError,
  FIX_LOOP_TARGET_STEP_ID,
} from '../src/modularity/index.js';

const CUSTOM = 'module.fix-demo.repair';
const pin = { version: 1, guardedSpans: [], fixTarget: { stepId: CUSTOM, capabilityVersion: 1 } };

async function fixLoopTargetStepId(contract: unknown): Promise<string> {
  const mod = (await import('../src/modularity/index.js')) as unknown as {
    fixLoopTargetStepId: (contract: unknown) => string;
  };
  return mod.fixLoopTargetStepId(contract);
}

describe('fence parity', () => {
  it('admits a static contract that pins a module fix target', () => {
    expect(() => assertExecutionContractSupported(pin, { staticPinnedList: true })).not.toThrow();
  });
  it('checks module-target membership when the caller supplies the pinned list', () => {
    expect(() =>
      assertExecutionContractSupported(pin, {
        staticPinnedList: true,
        stepIds: [CUSTOM],
      }),
    ).not.toThrow();
    expect(() =>
      assertExecutionContractSupported(pin, {
        staticPinnedList: true,
        stepIds: ['other'],
      }),
    ).toThrow(`fix-target ${CUSTOM} must be a module step in the pinned run list`);
  });
});

it.each([
  '07-phase-2-implement',
  'custom.fx.repair',
  'module.fx._repair',
  'module.fx.repair.extra',
])('refuses an unsupported target by name: %s', (stepId) => {
  expect(() =>
    assertExecutionContractSupported(
      { ...pin, fixTarget: { stepId, capabilityVersion: 1 } },
      { staticPinnedList: true },
    ),
  ).toThrow(stepId);
});

describe('fixLoopTargetStepId', () => {
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a contract without a pin', { version: 1, guardedSpans: [] }],
  ])('names the legacy implementation step for %s', async (_name, contract) => {
    expect(await fixLoopTargetStepId(contract)).toBe(FIX_LOOP_TARGET_STEP_ID);
    expect(FIX_LOOP_TARGET_STEP_ID).toBe('07-phase-2-implement');
  });

  it('names the pinned step', async () => {
    expect(await fixLoopTargetStepId(pin)).toBe(CUSTOM);
  });

  it.each([
    ['a wrong version', { version: 2, guardedSpans: [] }],
    [
      'a pin without a step id',
      { version: 1, guardedSpans: [], fixTarget: { capabilityVersion: 1 } },
    ],
    ['a string', 'module.fix-demo.repair'],
    ['an array', []],
  ])('throws ExecutionContractError for %s instead of reading it as no target', async (_n, bad) => {
    await expect(fixLoopTargetStepId(bad)).rejects.toBeInstanceOf(ExecutionContractError);
  });
});
