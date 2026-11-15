import { describe, expect, it, vi } from 'vitest';
import {
  CODE_AUDIT_OUTPUT_CONTRACT as audit,
  CODE_REVIEW_OUTPUT_CONTRACT as review,
} from '@haive/shared/step-outputs';
import type { StepDefinition } from '@haive/shared/step';
import {
  validateSuccessfulStepOutput,
  StepOutputContractInvalidError,
} from '../src/step-engine/step-output-contract.js';
const def = (id: string, contract = audit): StepDefinition => ({
  metadata: {
    id,
    title: id,
    description: '',
    index: 0,
    workflowType: 'workflow',
    requiresCli: false,
  },
  outputContract: contract,
  apply: async () => null,
});
describe('successful output mismatch policy', () => {
  it.each(['08c-code-review', '08c2-code-audit'])(
    'warns and retains live builtin %s output',
    (id) => {
      const warn = vi.fn();
      expect(() =>
        validateSuccessfulStepOutput(
          def(id, id === '08c-code-review' ? review : audit),
          { PRIVATE: 'never log' },
          { warn },
        ),
      ).not.toThrow();
      expect(warn).toHaveBeenCalledOnce();
      expect(JSON.stringify(warn.mock.calls)).not.toContain('PRIVATE');
      expect(warn.mock.calls[0]?.[0]).toMatchObject({
        contractId: id === '08c-code-review' ? review.id : audit.id,
        issuePaths: expect.any(Array),
      });
    },
  );
  it('hard fails only a directly bound declared replacement, with bounded paths and no values', () => {
    const warn = vi.fn();
    const step = { ...def('module.fx.audit'), replaces: ['08c2-code-audit'] as const };
    expect(() =>
      validateSuccessfulStepOutput(step, { audited: 'PRIVATE' }, { warn }),
    ).not.toThrow();
    expect(() =>
      validateSuccessfulStepOutput(step, { audited: 'PRIVATE' }, { warn }, '08c2-code-audit'),
    ).toThrow(StepOutputContractInvalidError);
    try {
      validateSuccessfulStepOutput(step, { audited: 'PRIVATE' }, { warn }, '08c2-code-audit');
    } catch (err) {
      expect(String(err)).toContain('step-output-contract-invalid');
      expect(String(err)).not.toContain('PRIVATE');
    }
  });
});
