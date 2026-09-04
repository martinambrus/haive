import { describe, it, expect } from 'vitest';
import { recurrenceTag } from './09-gate-2-verify-approval.js';
import { recurrenceKey } from './_review-findings.js';
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

  const cleanReview = {
    peerVerdict: 'APPROVE',
    securityVerdict: 'SECURE',
    blocking: false,
    reviewIncomplete: false,
    peerFindings: [],
    securityFindings: [],
    lensFindings: [],
    positives: [],
  };

  it('does not report an incomplete review as OK, and does not default to approve', () => {
    // Regression: an unreadable reviewer is non-blocking (the reviewer failed, not the
    // code), which made codeReviewOk true -- so the row rendered pass/OK, collapsed its
    // own "review did not complete" finding, and the gate defaulted to approve.
    const d = baseDetect({
      codeReview: {
        ...cleanReview,
        peerVerdict: 'DISCUSS',
        reviewIncomplete: true,
        peerFindings: ['[medium]  Peer review output was unparseable'],
      },
    });
    const r = row(d, 'Code review');
    expect(r?.status).toBe('warn');
    expect(r?.statusLabel).toBe('INCOMPLETE');
    expect(r?.defaultOpen).toBe(true);
    expect(decisionDefault(d)).toBe('reject');
  });

  it('still reports a complete, clean review as OK and defaults to approve', () => {
    const d = baseDetect({ codeReview: cleanReview });
    expect(row(d, 'Code review')?.status).toBe('pass');
    expect(row(d, 'Code review')?.statusLabel).toBe('OK');
    expect(decisionDefault(d)).toBe('approve');
  });

  it('a blocking review still outranks incomplete', () => {
    const d = baseDetect({
      codeReview: { ...cleanReview, blocking: true, reviewIncomplete: true },
    });
    expect(row(d, 'Code review')?.statusLabel).toBe('BLOCKING');
    expect(decisionDefault(d)).toBe('reject');
  });

  it('does not report a partially-covered review as OK, and does not default to approve', () => {
    // The reviewers approved everything they were handed -- but the changed-file list was
    // capped, so they never saw 50 of the 150 changed files. A clean verdict over code
    // nobody read is exactly what this row must not render.
    const d = baseDetect({
      codeReview: { ...cleanReview, coverage: { listed: 100, total: 150, truncated: true } },
    });
    const r = row(d, 'Code review');
    expect(r?.status).toBe('warn');
    expect(r?.statusLabel).toBe('PARTIAL');
    expect(r?.detail).toContain('only 100 of 150 changed files');
    expect(r?.body).toContain('## Coverage');
    expect(decisionDefault(d)).toBe('reject');
  });

  it('reports a review that covered the whole change as OK', () => {
    const d = baseDetect({
      codeReview: { ...cleanReview, coverage: { listed: 12, total: 12, truncated: false } },
    });
    expect(row(d, 'Code review')?.statusLabel).toBe('OK');
    expect(row(d, 'Code review')?.detail).not.toContain('changed files were given');
    expect(decisionDefault(d)).toBe('approve');
  });

  it('an unreadable reviewer still outranks a partial one in the label', () => {
    const d = baseDetect({
      codeReview: {
        ...cleanReview,
        reviewIncomplete: true,
        coverage: { listed: 100, total: 150, truncated: true },
      },
    });
    // Both are true; INCOMPLETE names the more serious of the two, and the coverage line
    // is appended to the detail rather than lost.
    expect(row(d, 'Code review')?.statusLabel).toBe('INCOMPLETE');
    expect(row(d, 'Code review')?.detail).toContain('only 100 of 150 changed files');
  });

  it('renders the broad audit row for a partial audit that found nothing', () => {
    // "No findings" over an unseen remainder is the claim worth disclosing, so the row
    // appears even with an empty findings list -- it never gates, the disclosure is the point.
    const d = baseDetect({
      codeAudit: { findings: [], coverage: { listed: 100, total: 150, truncated: true } },
    });
    const r = row(d, 'Code audit (broad)');
    expect(r?.statusLabel).toBe('PARTIAL');
    expect(r?.status).toBe('info');
    expect(r?.detail).toContain('only 100 of 150 changed files');
    // Advisory by design: a report-only step must not flip the gate.
    expect(decisionDefault(d)).toBe('approve');
  });

  it('still renders no audit row when the audit was complete and clean', () => {
    const d = baseDetect({
      codeAudit: { findings: [], coverage: { listed: 12, total: 12, truncated: false } },
    });
    expect(row(d, 'Code audit (broad)')).toBeUndefined();
  });

  const cleanQa = {
    level: 'poc',
    blocking: false,
    counts: { critical: 0, high: 0, total: 0 },
    findings: [],
    incomplete: false,
  };

  it('does not report an incomplete adversarial QA as OK, and does not default to approve', () => {
    // Same regression as the code-review row above: an adversary that died is non-blocking,
    // which made adversarialOk true — so a half-probed attack surface rendered CLEAN.
    const d = baseDetect({ adversarial: { ...cleanQa, incomplete: true } });
    const r = row(d, 'Adversarial QA (poc)');
    expect(r?.status).toBe('warn');
    expect(r?.statusLabel).toBe('INCOMPLETE');
    expect(r?.defaultOpen).toBe(true);
    expect(decisionDefault(d)).toBe('reject');
  });

  it('INCOMPLETE outranks the finding count on a partial roster', () => {
    const d = baseDetect({
      adversarial: {
        ...cleanQa,
        incomplete: true,
        counts: { critical: 0, high: 0, total: 3 },
        findings: ['[medium] qa-gap  agent died'],
      },
    });
    expect(row(d, 'Adversarial QA (poc)')?.statusLabel).toBe('INCOMPLETE');
  });

  it('still reports a complete, clean adversarial QA as CLEAN and defaults to approve', () => {
    const d = baseDetect({ adversarial: cleanQa });
    expect(row(d, 'Adversarial QA (poc)')?.status).toBe('pass');
    expect(row(d, 'Adversarial QA (poc)')?.statusLabel).toBe('CLEAN');
    expect(decisionDefault(d)).toBe('approve');
  });

  it('does not report a partially-covered adversarial QA as CLEAN', () => {
    const d = baseDetect({
      adversarial: { ...cleanQa, coverage: { listed: 100, total: 150, truncated: true } },
    });
    const r = row(d, 'Adversarial QA (poc)');
    expect(r?.status).toBe('warn');
    expect(r?.statusLabel).toBe('PARTIAL');
    expect(r?.detail).toContain('only 100 of 150 changed files');
    expect(decisionDefault(d)).toBe('reject');
  });

  it('a blocking adversarial QA still outranks incomplete', () => {
    const d = baseDetect({ adversarial: { ...cleanQa, blocking: true, incomplete: true } });
    expect(row(d, 'Adversarial QA (poc)')?.statusLabel).toBe('BLOCKING');
    expect(decisionDefault(d)).toBe('reject');
  });

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

describe('recurrenceTag', () => {
  const map = new Map<string, number[]>([
    [recurrenceKey('peer-reviewer', 'src/a.ts'), [0, 2]],
    [recurrenceKey('peer-reviewer', 'src/once.ts'), [1]],
  ]);

  it('is empty on a finding with no history — most findings, most rounds', () => {
    expect(recurrenceTag(map, 'peer-reviewer', 'src/new.ts')).toBe('');
    expect(recurrenceTag(new Map(), 'peer-reviewer', 'src/a.ts')).toBe('');
  });

  it('counts rounds including this one', () => {
    expect(recurrenceTag(map, 'peer-reviewer', 'src/a.ts')).toBe('[repeat x3] ');
    expect(recurrenceTag(map, 'peer-reviewer', 'src/once.ts')).toBe('[repeat x2] ');
  });

  it('is scoped to the reviewer — one reviewer repeating is not another repeating', () => {
    expect(recurrenceTag(map, 'security-code-reviewer', 'src/a.ts')).toBe('');
  });

  it('survives a finding whose path is missing or not a string', () => {
    expect(recurrenceTag(map, 'peer-reviewer', undefined)).toBe('');
    expect(recurrenceTag(map, 'peer-reviewer', 42)).toBe('');
  });
});

describe('gate-2 discloses what was not reviewed', () => {
  const baseDetect = (validation: Record<string, unknown> | null) =>
    ({
      verify: { test: null, lint: null, typecheck: null },
      allPassed: true,
      validation,
      testManagement: null,
      browser: null,
      codeReview: null,
      codeAudit: null,
      adversarial: null,
      liveBrowser: null,
      runtimeSmoke: null,
    }) as never;

  const validation = (excludedDimensions: string[]) => ({
    verdict: 'VALID',
    summary: 'looks fine',
    openIssues: [],
    failedDimensions: [],
    excludedDimensions,
    fixesApplied: 0,
    exhaustedBudget: false,
    converged: true,
    churnFiles: [],
    report: '',
  });

  const validationBody = (excluded: string[]): string => {
    const schema = gate2VerifyApprovalStep.form!({} as never, baseDetect(validation(excluded)))!;
    const row = (schema.statusSummary ?? []).find((r) => r.label === 'Implementation validation');
    return row?.body ?? '';
  };

  // A dimension nobody scored yields the same empty finding list as one that passed.
  // Saying so is the only thing that keeps a narrowed review from reading as clean.
  it('names the dimensions this run did not score', () => {
    const body = validationBody(['Accessibility', 'Internationalization']);
    expect(body).toContain('## Not reviewed');
    expect(body).toContain('Accessibility, Internationalization');
    expect(body).toContain('their absence is not a pass');
  });

  it('says nothing when every dimension was scored', () => {
    expect(validationBody([])).not.toContain('## Not reviewed');
  });

  // Step outputs are persisted: a task validated before this field existed has none.
  it('says nothing when the stored 07b output predates the field', () => {
    const v = validation([]) as Record<string, unknown>;
    delete v.excludedDimensions;
    const schema = gate2VerifyApprovalStep.form!({} as never, baseDetect(v))!;
    const row = (schema.statusSummary ?? []).find((r) => r.label === 'Implementation validation');
    expect(row?.body ?? '').not.toContain('## Not reviewed');
  });
});
