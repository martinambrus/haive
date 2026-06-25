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

describe('gate-2 status summary', () => {
  const baseDetect = (overrides: Record<string, unknown>) =>
    ({
      verify: { test: null, lint: null, typecheck: null },
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

  const form = (detected: never) => gate2VerifyApprovalStep.form!({} as never, detected)!;
  const decisionDefault = (detected: never): string => {
    const field = form(detected).fields.find((f) => f.id === 'decision') as { default?: string };
    return field.default ?? '';
  };
  const rows = (detected: never) => form(detected).statusSummary ?? [];
  const row = (detected: never, label: string) => rows(detected).find((r) => r.label === label);

  const failSmoke = (httpStatus: number | null) => ({
    ran: true,
    passed: false,
    httpStatus,
    url: 'https://app.ddev.site',
    errorExcerpt: '<html><body>installer</body></html>',
  });
  const mcpPass = {
    method: 'mcp',
    passed: true,
    failures: [],
    visualVerdict: null,
    checklistMarkdown: null,
    skipped: false,
  };

  it('hides skipped verify checks and shows ran ones with PASS/FAIL', () => {
    const d = baseDetect({
      verify: {
        test: { ran: true, passed: false, output: 'boom' },
        lint: { ran: false, passed: false, output: 'skipped' },
        typecheck: { ran: true, passed: true, output: '' },
      },
    });
    const labels = rows(d).map((r) => r.label);
    expect(labels).toContain('Tests');
    expect(labels).toContain('Typecheck');
    expect(labels).not.toContain('Lint'); // ran:false → omitted, not a contradictory FAIL
    expect(row(d, 'Tests')?.status).toBe('fail');
    expect(row(d, 'Typecheck')?.status).toBe('pass');
    expect(form(d).description ?? '').not.toContain('All verification checks passed');
  });

  it('emits no rows when every verify check was skipped', () => {
    const d = baseDetect({
      verify: {
        test: { ran: false, passed: false, output: 'skipped' },
        lint: { ran: false, passed: false, output: 'skipped' },
        typecheck: { ran: false, passed: false, output: 'skipped' },
      },
    });
    expect(rows(d).length).toBe(0);
  });

  it('a standalone smoke failure defaults the gate to reject', () => {
    const d = baseDetect({ runtimeSmoke: failSmoke(null) });
    expect(decisionDefault(d)).toBe('reject');
    expect(row(d, 'Runtime smoke')?.status).toBe('fail');
    expect(row(d, 'Runtime smoke')?.statusLabel).toBe('FAIL');
    expect(row(d, 'Runtime smoke')?.detail).toContain('did not respond');
  });

  it('marks a body-error 200 distinctly from a no-response failure', () => {
    const d = baseDetect({ runtimeSmoke: failSmoke(200) });
    expect(row(d, 'Runtime smoke')?.detail).toContain('responded HTTP 200');
  });

  it('demotes the smoke to advisory when a real-browser test passed (default stays approve)', () => {
    const d = baseDetect({ runtimeSmoke: failSmoke(null), browser: mcpPass });
    expect(decisionDefault(d)).toBe('approve');
    expect(row(d, 'Runtime smoke')?.status).toBe('warn');
    expect(row(d, 'Runtime smoke')?.statusLabel).toBe('ADVISORY');
    expect(row(d, 'Browser testing')?.status).toBe('pass');
  });

  it('keeps the smoke a hard fail when a manual checklist is the only browser signal', () => {
    const d = baseDetect({
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
    expect(decisionDefault(d)).toBe('reject');
    expect(row(d, 'Runtime smoke')?.status).toBe('fail');
  });
});
