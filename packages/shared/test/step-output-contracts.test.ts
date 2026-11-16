import { describe, expect, expectTypeOf, it } from 'vitest';
import * as contracts from '@haive/shared/step-outputs';
import type {
  CodeAuditOutput,
  CodeReviewOutput,
  FileCoverage,
  StepOutputContractRef,
} from '@haive/shared/step';

const {
  CODE_REVIEW_OUTPUT_CONTRACT: review,
  CODE_AUDIT_OUTPUT_CONTRACT: audit,
  parseStepOutputContractRef,
  stepOutputContractsEqual,
  stepRoleOutputContract,
  safeParseStepOutput,
} = contracts;

describe('host output contracts', () => {
  it('exports frozen references and operations, never the mutable schemas or validator registry', () => {
    expect(Object.keys(contracts).sort()).toEqual([
      'CHECK_RESULT_ROLES',
      'CODE_AUDIT_OUTPUT_CONTRACT',
      'CODE_REVIEW_OUTPUT_CONTRACT',
      'DISCOVERY_OUTPUT_CONTRACT',
      'DISCOVERY_ROLE',
      'HOST_POLICY_STEP_ROLES',
      'IMPLEMENTATION_SUMMARY_DAG_STEP_ID',
      'IMPLEMENTATION_SUMMARY_OUTPUT_CONTRACT',
      'IMPLEMENTATION_SUMMARY_ROLE',
      'REQUIREMENTS_DRAFT_OUTPUT_CONTRACT',
      'REQUIREMENTS_HUMANIZED_OUTPUT_CONTRACT',
      'REQUIREMENTS_ROLES',
      'SPEC_CHECKED_OUTPUT_CONTRACT',
      'SPEC_DRAFT_OUTPUT_CONTRACT',
      'SPEC_RESOLVED_OUTPUT_CONTRACT',
      'SPEC_ROLES',
      'STEP_ROLES',
      'STEP_ROLE_REGISTRY',
      'TEST_MANAGEMENT_OUTPUT_CONTRACT',
      'VALIDATION_OUTPUT_CONTRACT',
      'VERIFY_OUTPUT_CONTRACT',
      'isPromptProvidableRole',
      'isQuotableRole',
      'parseRegistryOutputContractRef',
      'parseStepOutputContractRef',
      'projectRoleOutput',
      'projectStepOutputRoles',
      'readStepRole',
      'safeParseStepOutput',
      'stepOutputContractsEqual',
      'stepOutputJsonSchema',
      'stepRoleOutputContract',
    ]);
    expect(Object.isFrozen(review)).toBe(true);
    expect(Object.isFrozen(audit)).toBe(true);
    expect(() => Object.assign(review, { version: 2 })).toThrow();
    expect(stepRoleOutputContract('08c-code-review')).toBe(review);
    expect(stepRoleOutputContract('08c2-code-audit')).toBe(audit);
    expect(stepOutputContractsEqual(review, { ...review })).toBe(true);
    expect(stepOutputContractsEqual(review, audit)).toBe(false);
  });
  it.each([
    null,
    {},
    { id: 'haive.code-review', version: 2 },
    { id: 'other', version: 1 },
    { id: 'haive.code-review', version: '1' },
    { id: 'haive.code-review', version: 1, schema: {} },
  ])('refuses non-host references: %#', (ref) => {
    expect(parseStepOutputContractRef(ref)).toBeNull();
    expect(stepOutputContractsEqual(review, ref)).toBe(false);
  });
  it('canonicalizes an exact serializable reference', () => {
    expect(parseStepOutputContractRef(JSON.parse(JSON.stringify(review)))).toBe(review);
  });
  it('preserves nested extension fields, absent legacy optionals, and nullable coverage', () => {
    const value = {
      audited: true,
      findings: [{ severity: 'low', extension: { a: 1 } }],
      coverage: null,
      extension: 42,
    };
    expect(safeParseStepOutput(audit, value)).toEqual({ success: true, data: value });
    expect(safeParseStepOutput(audit, { ...value, audited: 'true' }).success).toBe(false);
    expect(
      safeParseStepOutput(audit, {
        ...value,
        coverage: { listed: '1', total: 1, truncated: false },
      }).success,
    ).toBe(false);
    expect(safeParseStepOutput(audit, { audited: true }).success).toBe(false);
  });
  it('reports bounded paths without exposing values', () => {
    const result = safeParseStepOutput(audit, {
      audited: 'PRIVATE',
      findings: Array.from({ length: 12 }, () => ({ severity: 'PRIVATE' })),
      coverage: 'PRIVATE',
    });
    expect(result.success).toBe(false);
    if (result.success) throw new Error('expected invalid');
    expect(result.issuePaths).toHaveLength(8);
    expect(result.issuePaths.every((p) => p.length <= 160)).toBe(true);
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
    expect(result.issuePaths).toContain('audited');
  });
  it('accepts small diagnostic bounds for controls', () => {
    const result = safeParseStepOutput(
      audit,
      { audited: 'PRIVATE', findings: 'PRIVATE', coverage: 'PRIVATE' },
      { maxIssues: 2, maxPathChars: 3 },
    );
    expect(result).toEqual({ success: false, issuePaths: ['aud', 'fin'] });
  });
  it('keeps public inferred output types available to SDK consumers', () => {
    expectTypeOf<CodeAuditOutput>().toEqualTypeOf<contracts.CodeAuditOutput>();
    expectTypeOf<CodeReviewOutput>().toEqualTypeOf<contracts.CodeReviewOutput>();
    expectTypeOf<FileCoverage>().toEqualTypeOf<contracts.FileCoverage>();
    const ref: StepOutputContractRef = review;
    expect(ref).toBe(review);
    const reviewResult = safeParseStepOutput(review, null);
    if (reviewResult.success) expectTypeOf(reviewResult.data).toEqualTypeOf<CodeReviewOutput>();
    const auditResult = safeParseStepOutput(audit, null);
    if (auditResult.success) expectTypeOf(auditResult.data).toEqualTypeOf<CodeAuditOutput>();
  });
});
