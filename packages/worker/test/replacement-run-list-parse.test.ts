import { expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ parse: vi.fn() }));
vi.mock('@haive/shared/modularity', async (original) => {
  const actual = await original<typeof import('@haive/shared/modularity')>();
  return { ...actual, parseDerivedRunPlan: h.parse.mockImplementation(actual.parseDerivedRunPlan) };
});
import { buildRunList, type ResolvedTaskContext } from '../src/queues/run-list.js';
import { stepRegistry } from '../src/step-engine/registry.js';
import { codeReviewStep } from '../src/step-engine/steps/workflow/08c-code-review.js';
import { rolePin, REVIEW, PRODUCER } from './replacement-fixtures.js';
import { CODE_REVIEW_OUTPUT_CONTRACT } from '@haive/shared/step-outputs';
it.each([1, 2] as const)(
  'parses a v%s pin once per build, preserving host policy',
  async (version) => {
    const pin = rolePin(version);
    vi.spyOn(stepRegistry, 'get').mockImplementation((id) =>
      id === REVIEW
        ? codeReviewStep
        : {
            metadata: { ...codeReviewStep.metadata, id },
            apply: async () => null,
            ...(id === PRODUCER
              ? { replaces: [REVIEW], outputContract: CODE_REVIEW_OUTPUT_CONTRACT }
              : {}),
          },
    );
    let validations = 0;
    Object.defineProperty(pin.derivedRunPlan, 'version', {
      get: () => {
        validations++;
        return version;
      },
    });
    h.parse(pin.derivedRunPlan);
    const once = validations;
    validations = 0;
    h.parse.mockClear();
    try {
      const list = await buildRunList(
        { ...pin, runListStrategy: 'derived' } as ResolvedTaskContext,
        {} as never,
      );
      expect(list.map((s) => s.metadata.id)).toEqual(pin.runListSnapshot);
      expect(h.parse).toHaveBeenCalledTimes(1);
      expect(validations).toBe(once);
      if (version === 2)
        expect(list.find((s) => s.metadata.id === PRODUCER)!.fixLoop).toBe(codeReviewStep.fixLoop);
    } finally {
      vi.restoreAllMocks();
    }
  },
);
