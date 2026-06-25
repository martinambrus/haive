import { describe, it, expect } from 'vitest';
import { gate2VerifyApprovalStep } from './09-gate-2-verify-approval.js';

describe('gate-2 restartLoop diagnosis', () => {
  it('threads captured runtime errors into the reject diagnosis', () => {
    const r = gate2VerifyApprovalStep.restartLoop!.evaluate({
      decision: 'reject',
      feedback: 'homepage looks broken',
      auditFindings: [],
      runtimeErrors: 'Browser console errors:\n- Uncaught TypeError: x is not a function',
    } as never);
    expect(r).not.toBeNull();
    expect(r!.diagnosis).toContain('homepage looks broken');
    expect(r!.diagnosis).toContain('Uncaught TypeError');
    expect(r!.diagnosis.toLowerCase()).toContain('reproduce');
  });

  it('does not restart on approve', () => {
    expect(
      gate2VerifyApprovalStep.restartLoop!.evaluate({
        decision: 'approve',
        feedback: '',
        auditFindings: [],
        runtimeErrors: '',
      } as never),
    ).toBeNull();
  });
});

describe('gate-2 runtime-smoke surfacing', () => {
  const baseDetect = (overrides: Record<string, unknown>) =>
    ({
      testResults: 'tests: PASS',
      lintResults: 'lint: not run',
      typecheckResults: 'typecheck: not run',
      allPassed: true,
      validation: null,
      testManagement: null,
      browser: null,
      codeReview: null,
      codeAudit: null,
      adversarial: null,
      liveBrowser: null,
      runtimeSmoke: null,
      ...overrides,
    }) as never;

  const decisionDefault = (detected: never): string => {
    const schema = gate2VerifyApprovalStep.form({} as never, detected)!;
    const field = schema.fields.find((f) => f.id === 'decision') as { default?: string };
    return field.default ?? '';
  };

  const failSmoke = (httpStatus: number | null) => ({
    ran: true,
    passed: false,
    httpStatus,
    url: 'https://app.ddev.site',
    errorExcerpt: '<html><body>installer</body></html>',
  });

  it('a standalone smoke failure defaults the gate to reject', () => {
    const detected = baseDetect({ runtimeSmoke: failSmoke(null) });
    expect(decisionDefault(detected)).toBe('reject');
    const schema = gate2VerifyApprovalStep.form({} as never, detected)!;
    expect(schema.description).toContain('Runtime smoke: FAIL');
    expect(schema.description).toContain('did not respond');
  });

  it('describes a body-error 200 distinctly from a no-response failure', () => {
    const schema = gate2VerifyApprovalStep.form(
      {} as never,
      baseDetect({ runtimeSmoke: failSmoke(200) }),
    )!;
    expect(schema.description).toContain('responded (HTTP 200)');
  });

  it('demotes the smoke to advisory when a real-browser test passed (default stays approve)', () => {
    const detected = baseDetect({
      runtimeSmoke: failSmoke(null),
      browser: {
        method: 'mcp',
        passed: true,
        failures: [],
        visualVerdict: null,
        checklistMarkdown: null,
        skipped: false,
      },
    });
    expect(decisionDefault(detected)).toBe('approve');
    const schema = gate2VerifyApprovalStep.form({} as never, detected)!;
    expect(schema.description).toContain('advisory');
    expect(schema.description).not.toContain('Runtime smoke: FAIL');
  });

  it('keeps the smoke a hard fail when a manual checklist is the only browser signal', () => {
    const detected = baseDetect({
      runtimeSmoke: failSmoke(null),
      browser: {
        method: 'manual',
        passed: true,
        failures: [],
        visualVerdict: null,
        checklistMarkdown: '# checklist',
        skipped: false,
      },
    });
    expect(decisionDefault(detected)).toBe('reject');
  });
});
