import { describe, expect, it, vi } from 'vitest';
import {
  CODE_REVIEW_OUTPUT_CONTRACT as review,
  CODE_AUDIT_OUTPUT_CONTRACT as audit,
  safeParseStepOutput,
} from '@haive/shared/step-outputs';
import { logger } from '@haive/shared/logger';
import type { StepContext, AgentMiningResult } from '@haive/shared/step';
import { codeReviewStep } from '../src/step-engine/steps/workflow/08c-code-review.js';
import { codeAuditStep } from '../src/step-engine/steps/workflow/08c2-code-audit.js';

vi.mock('../src/step-engine/steps/workflow/_dependency-policy.js', async (original) => ({
  ...(await original<object>()),
  loadReviewDependencyPolicy: async () => ({ drupal: false, drupalRoots: [], ownedPaths: [] }),
}));
const ctx = {
  logger: logger.child({ test: 'producer-contracts' }),
  taskId: 'task',
  taskStepId: 'step',
  round: 0,
  db: { insert: () => ({ values: () => ({ onConflictDoNothing: async () => undefined }) }) },
} as unknown as StepContext;
const mining = (agentId: string, value: unknown): AgentMiningResult => ({
  agentId,
  agentTitle: agentId,
  status: 'done',
  output: null,
  rawOutput: typeof value === 'string' ? value : JSON.stringify(value),
  errorMessage: null,
});
const files = { files: ['src/a.ts'], total: 2, truncated: true, scanError: 'git failed' };
const detected = {
  spec: 'spec',
  implementationFiles: files,
  debtBlock: '',
  level: 'enterprise',
  promptDefectCapture: false,
  reviewDimensionIds: [],
  refuteEnabled: false,
  refuteLensCount: 1,
};

describe('contracts on actual producer apply returns', () => {
  it('names the same host contract on both definitions', () => {
    expect(codeReviewStep.outputContract).toEqual(review);
    expect(codeAuditStep.outputContract).toEqual(audit);
  });
  it.each([files, undefined])(
    'review bypass and legacy detection: %#',
    async (implementationFiles) => {
      const value = await codeReviewStep.apply(ctx, {
        detected: { ...detected, implementationFiles },
        formValues: {},
        iteration: 0,
        previousIterations: [],
        agentMiningResults: [],
      } as never);
      expect(safeParseStepOutput(review, value)).toEqual({ success: true, data: value });
      expect(value.reviewed).toBe(false);
      expect(value.coverage).toEqual(
        implementationFiles ? { listed: 1, total: 2, truncated: true, scanFailed: true } : null,
      );
    },
  );
  it('parses peer/security/extra lenses with real apply counts and optional rule evidence', async () => {
    const value = await codeReviewStep.apply(ctx, {
      detected,
      formValues: {},
      iteration: 0,
      previousIterations: [],
      miningWaveExhausted: true,
      agentMiningResults: [
        mining('peer-reviewer', {
          verdict: 'REQUEST_CHANGES',
          positives: ['kept'],
          findings: [
            {
              severity: 'high',
              path: 'src/a.ts',
              lines: '2-3',
              issue: 'bug',
              fix: 'fix',
              snippet: 'code',
            },
          ],
          rule_conflicts: [{ rule: 'A', reason: 'approved spec', file: 'src/a.ts' }],
        }),
        mining('security-code-reviewer', {
          verdict: 'NEEDS_FIXES',
          findings: [
            {
              severity: 'critical',
              path: 'src/a.ts',
              line: 2,
              in_scope: { unknown: true },
              issue: 'unsafe',
              cwe: 'CWE-79',
              attack: 'input',
              fix: 'escape',
            },
          ],
        }),
        mining('operational-reviewer', {
          verdict: 'DISCUSS',
          findings: [{ severity: 'low', issue: 'note' }],
        }),
      ],
    } as never);
    expect(value.reviewed).toBe(true);
    expect(value.counts.peer).toBe(1);
    expect(value.security.findings[0]?.in_scope).toEqual({ unknown: true });
    expect(value.ruleConflicts).toHaveLength(1);
    expect(value.extraLenses).toHaveLength(1);
    expect(safeParseStepOutput(review, value)).toEqual({ success: true, data: value });
    const extended = {
      ...value,
      extension: 'root',
      peer: {
        ...value.peer,
        extension: 'peer',
        findings: value.peer.findings.map((f) => ({ ...f, extension: 'finding' })),
      },
      security: {
        ...value.security,
        extension: 'security',
        findings: value.security.findings.map((f) => ({
          ...f,
          line: '2-3',
          extension: 'security finding',
        })),
      },
      extraLenses: value.extraLenses.map((lens) => ({ ...lens, extension: 'lens' })),
      coverage: { ...value.coverage!, extension: 'coverage' },
      counts: { ...value.counts, extension: 'counts' },
      ruleConflicts: value.ruleConflicts!.map((c) => ({ ...c, extension: 'conflict' })),
    };
    expect(safeParseStepOutput(review, extended)).toEqual({ success: true, data: extended });
  });
  it('validates the incomplete review fallback without turning it into success evidence', async () => {
    const value = await codeReviewStep.apply(ctx, {
      detected,
      formValues: {},
      iteration: 0,
      previousIterations: [],
      isFinalMiningAttempt: true,
      miningWaveExhausted: true,
      agentMiningResults: [mining('peer-reviewer', 'unreadable')],
    } as never);
    expect(value.reviewIncomplete).toBe(true);
    expect(safeParseStepOutput(review, value).success).toBe(true);
  });
  it.each([
    JSON.stringify({
      findings: [
        { severity: 'high', path: 'src/a.ts', lines: '2', issue: 'bug', fix: 'fix' },
        { severity: 'low' },
      ],
    }),
    'unreadable',
  ])('audit uses actual tolerant parser output: %#', async (llmOutput) => {
    const value = await codeAuditStep.apply(ctx, {
      detected: { spec: 'spec', implementationFiles: files },
      formValues: {},
      iteration: 0,
      previousIterations: [],
      llmOutput,
    } as never);
    expect(value.audited).toBe(true);
    expect(value.findings).toHaveLength(llmOutput === 'unreadable' ? 0 : 2);
    expect(safeParseStepOutput(audit, value)).toEqual({ success: true, data: value });
  });
});
