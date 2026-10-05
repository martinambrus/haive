import { beforeEach, describe, it, expect, vi } from 'vitest';

const m = vi.hoisted(() => ({
  loadPreviousStepOutput: vi.fn(),
  getTaskEnvTemplate: vi.fn(),
  hasWorkspaceEntry: vi.fn(),
  resolveTaskDirectAccess: vi.fn(),
  resolveScreenshotRoot: vi.fn(),
  loadTaskSimilarSites: vi.fn(),
  loadUnactedInsights: vi.fn(),
}));

vi.mock('../onboarding/_helpers.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../onboarding/_helpers.js')>()),
  loadPreviousStepOutput: m.loadPreviousStepOutput,
}));
vi.mock('../env-replicate/_shared.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../env-replicate/_shared.js')>()),
  getTaskEnvTemplate: m.getTaskEnvTemplate,
}));
vi.mock('../../workspace-probe.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../workspace-probe.js')>()),
  hasWorkspaceEntry: m.hasWorkspaceEntry,
}));
vi.mock('../../../sandbox/_browser-access.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../sandbox/_browser-access.js')>()),
  resolveTaskDirectAccess: m.resolveTaskDirectAccess,
}));
vi.mock('./_screenshots.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./_screenshots.js')>()),
  resolveScreenshotRoot: m.resolveScreenshotRoot,
}));
vi.mock('./_similar-sites.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./_similar-sites.js')>()),
  loadTaskSimilarSites: m.loadTaskSimilarSites,
}));
vi.mock('./_gate-insights.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./_gate-insights.js')>()),
  loadUnactedInsights: m.loadUnactedInsights,
}));

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
  // A verification that actually RAN and passed. The base fixture used to leave all three
  // slots null, which is not "a clean run" but "nothing was checked" — the two now differ, so
  // every case below that is about some OTHER signal has to start from a real green run.
  const ranClean = { ran: true, passed: true, output: '' };
  const baseDetect = (overrides: Record<string, unknown>) =>
    ({
      verify: { test: ranClean, lint: ranClean, typecheck: ranClean },
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

  it('keeps upstream observations visible for a decision without labelling them automatic blockers', () => {
    const d = baseDetect({
      codeReview: {
        ...cleanReview,
        advisoryVerdict: true,
        upstreamObservations: true,
        securityFindings: [
          '[upstream dependency — user decision] [medium] web/modules/contrib/foo/a.php upstream observation',
        ],
      },
    });
    expect(row(d, 'Code review')?.status).toBe('warn');
    expect(row(d, 'Code review')?.body).toContain('upstream dependency — user decision');
    expect(row(d, 'Code review')?.statusLabel).toBe('UPSTREAM');
    expect(row(d, 'Code review')?.detail).toContain('no upstream repair was assigned');
    expect(decisionDefault(d)).toBe('reject');
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

  // A skipped check is not a failure, so it still gets no pass/fail row — but with all three
  // skipped, omission alone left an empty table beside an `allPassed` that is true only
  // because nothing ran, and the gate pre-selected Approve on that.
  const allSkipped = {
    test: { ran: false, passed: false, output: 'skipped' },
    lint: { ran: false, passed: false, output: 'skipped' },
    typecheck: { ran: false, passed: false, output: 'skipped' },
  };

  it('states that nothing was verified instead of emitting an empty table', () => {
    const d = baseDetect({ verify: allSkipped });
    expect(rows(d).map((r) => r.label)).toEqual(['Tests / lint / typecheck']);
    const r = row(d, 'Tests / lint / typecheck');
    expect(r?.status).toBe('warn');
    expect(r?.statusLabel).toBe('NOT RUN');
    expect(r?.defaultOpen).toBe(true);
    expect(r?.body).toContain('subdirectory');
  });

  it('does not default to approve when nothing was verified', () => {
    expect(decisionDefault(baseDetect({ verify: allSkipped }))).toBe('reject');
    // Absent slots entirely — an 08 payload that recorded no verify block at all.
    expect(
      decisionDefault(baseDetect({ verify: { test: null, lint: null, typecheck: null } })),
    ).toBe('reject');
  });

  it('says nothing about "not run" once any one check ran', () => {
    const d = baseDetect({
      verify: { ...allSkipped, lint: { ran: true, passed: true, output: '' } },
    });
    expect(row(d, 'Tests / lint / typecheck')).toBeUndefined();
    expect(row(d, 'Lint')?.status).toBe('pass');
    expect(decisionDefault(d)).toBe('approve');
  });

  // A check that RAN and failed is a failure, not an absence — it must keep its own red row
  // and must not also be reported as "not run".
  it('keeps a real failure as a failure', () => {
    const d = baseDetect({
      verify: { ...allSkipped, test: { ran: true, passed: false, output: '1 failing' } },
      allPassed: false,
    });
    expect(row(d, 'Tests / lint / typecheck')).toBeUndefined();
    expect(row(d, 'Tests')?.status).toBe('fail');
    expect(decisionDefault(d)).toBe('reject');
  });

  it('keeps check output that holds a fence of its own inside one code block', () => {
    const output = 'FAIL\n```\n![x](https://img.example/p.png)\n```';
    const d = baseDetect({
      verify: { ...allSkipped, test: { ran: true, passed: false, output } },
      allPassed: false,
    });
    expect(row(d, 'Tests')?.body).toBe(['````', output, '````'].join('\n'));
  });

  // A pass that left pre-existing violations is still a pass, but a bare green row would hide them.
  describe('a lint verdict limited to the lines the change wrote', () => {
    const withLint = (lint: Record<string, unknown>) =>
      baseDetect({ verify: { test: ranClean, lint, typecheck: ranClean } });
    const LEFT = '35 pre-existing violation(s) elsewhere predate this change — not blocking.';

    it('renders a pass that left pre-existing violations as a warning row, not a bare pass', () => {
      const d = withLint({
        ran: true,
        passed: true,
        output: LEFT,
        scope: { blocking: 0, preExisting: 35 },
      });

      expect(row(d, 'Lint')).toEqual({
        label: 'Lint',
        status: 'warn',
        statusLabel: 'PRE-EXISTING',
        detail: '35 pre-existing violation(s) elsewhere, none on lines this change wrote',
      });
      expect(row(d, 'Tests')?.status).toBe('pass');
    });

    it('still defaults the gate to approve, since nothing the change wrote is wrong', () => {
      const d = withLint({
        ran: true,
        passed: true,
        output: LEFT,
        scope: { blocking: 0, preExisting: 35 },
      });

      expect(decisionDefault(d)).toBe('approve');
    });

    it('renders a pass with nothing left over as a plain pass', () => {
      const d = withLint({
        ran: true,
        passed: true,
        output: '',
        scope: { blocking: 0, preExisting: 0 },
      });

      expect(row(d, 'Lint')).toEqual({ label: 'Lint', status: 'pass' });
    });

    it('renders a failure as a failure whatever its scope, with the list as its body', () => {
      const output =
        'src/a.php:11: [ERROR] m (S.A)\n3 pre-existing violation(s) elsewhere predate this change — do not edit code to clear them.';
      const d = withLint({
        ran: true,
        passed: false,
        output,
        scope: { blocking: 1, preExisting: 3 },
      });

      expect(row(d, 'Lint')).toEqual({
        label: 'Lint',
        status: 'fail',
        body: ['```', output, '```'].join('\n'),
        defaultOpen: false,
      });
    });

    it('shows the note of a verdict that could not be limited beside a failure', () => {
      const d = withLint({
        ran: true,
        passed: false,
        output: 'raw report',
        note: 'lint verdict unscoped: phpcs wrote no report',
      });

      expect(row(d, 'Lint')).toMatchObject({
        status: 'fail',
        detail: 'lint verdict unscoped: phpcs wrote no report',
      });
    });

    it('renders a payload without a scope or a note exactly as before', () => {
      expect(row(withLint({ ran: true, passed: true, output: '' }), 'Lint')).toEqual({
        label: 'Lint',
        status: 'pass',
      });
      expect(row(withLint({ ran: true, passed: false, output: 'boom' }), 'Lint')).toEqual({
        label: 'Lint',
        status: 'fail',
        body: ['```', 'boom', '```'].join('\n'),
        defaultOpen: false,
      });
    });
  });

  describe('a check that was selected but could not run', () => {
    const NOT_FOUND = 'vendor/bin/phpcs not found — lint not run';
    const ENV_STOPPED = 'test run stopped by its environment, not a test failure';
    const withSlots = (slots: Record<string, unknown>) =>
      baseDetect({ verify: { test: ranClean, lint: ranClean, typecheck: ranClean, ...slots } });
    const phpcsMissing = { ran: false, passed: false, output: NOT_FOUND, note: NOT_FOUND };

    it('shows a NOT RUN warning carrying the note', () => {
      const d = withSlots({ lint: phpcsMissing });

      expect(row(d, 'Lint')).toMatchObject({
        status: 'warn',
        statusLabel: 'NOT RUN',
        detail: NOT_FOUND,
      });
      expect(row(d, 'Lint')).not.toHaveProperty('body');
      expect(rows(d).map((r) => r.label)).toEqual(['Tests', 'Lint', 'Typecheck']);
    });

    it('does not default to approve while another check ran and passed', () => {
      expect(decisionDefault(withSlots({ lint: phpcsMissing }))).toBe('reject');
    });

    it('keeps what the check printed, collapsed the way a failing row keeps it', () => {
      const output = "browserType.launch: Executable doesn't exist at /root/.cache/ms-playwright";
      const d = withSlots({ test: { ran: false, passed: false, output, note: ENV_STOPPED } });

      expect(row(d, 'Tests')).toEqual({
        label: 'Tests',
        status: 'warn',
        statusLabel: 'NOT RUN',
        detail: ENV_STOPPED,
        body: ['```', output, '```'].join('\n'),
        defaultOpen: false,
      });
      expect(row(d, 'Lint')).toEqual({ label: 'Lint', status: 'pass' });
      expect(decisionDefault(d)).toBe('reject');
    });

    it('gives a check that printed nothing no body', () => {
      const note = 'DDEV runner unavailable — typecheck not run';
      const d = withSlots({ typecheck: { ran: false, passed: false, output: '', note } });

      expect(row(d, 'Typecheck')).toEqual({
        label: 'Typecheck',
        status: 'warn',
        statusLabel: 'NOT RUN',
        detail: note,
      });
    });

    it('still omits a check nobody selected, which carries no note, and defaults to approve', () => {
      const d = withSlots({ lint: { ran: false, passed: false, output: 'skipped' } });

      expect(rows(d).map((r) => r.label)).toEqual(['Tests', 'Typecheck']);
      expect(decisionDefault(d)).toBe('approve');
    });

    it('keeps the all-three row for the case where nothing ran', () => {
      const d = withSlots({
        test: { ran: false, passed: false, output: '', note: ENV_STOPPED },
        lint: phpcsMissing,
        typecheck: { ran: false, passed: false, output: 'skipped' },
      });

      expect(rows(d).map((r) => r.label)).toEqual(['Tests', 'Lint', 'Tests / lint / typecheck']);
      expect(decisionDefault(d)).toBe('reject');
    });
  });

  it('a standalone smoke failure defaults the gate to reject', () => {
    const d = baseDetect({ runtimeSmoke: failSmoke(null) });
    expect(decisionDefault(d)).toBe('reject');
    expect(row(d, 'Runtime smoke')?.status).toBe('fail');
    expect(row(d, 'Runtime smoke')?.statusLabel).toBe('FAIL');
    expect(row(d, 'Runtime smoke')?.detail).toContain('did not respond');
  });

  it.each([400, 401, 403, 404, 429, 499])(
    'renders HTTP %i as UNSURE with its evidence',
    (status) => {
      const d = baseDetect({ runtimeSmoke: { ...failSmoke(status), passed: null } });
      expect(row(d, 'Runtime smoke')).toMatchObject({
        status: 'warn',
        statusLabel: 'UNSURE',
        detail: `HTTP ${status} — runtime health could not be verified`,
        defaultOpen: true,
      });
      expect(row(d, 'Runtime smoke')?.body).toContain('login or access wall');
      expect(row(d, 'Runtime smoke')?.body).toContain('<html><body>installer</body></html>');
      expect(row(d, 'Runtime smoke')?.body).not.toContain('body contains a runtime-error');
      expect(decisionDefault(d)).toBe('reject');
    },
  );

  it('reclassifies a saved 403 pass without rebuilding the detect payload', () => {
    const d = baseDetect({ runtimeSmoke: { ...failSmoke(403), passed: true } });
    expect(row(d, 'Runtime smoke')?.statusLabel).toBe('UNSURE');
    expect(decisionDefault(d)).toBe('reject');
  });

  it('keeps a 4xx with a detected runtime error as FAIL', () => {
    const d = baseDetect({
      runtimeSmoke: { ...failSmoke(403), errorExcerpt: 'Fatal error: SQLSTATE' },
    });
    expect(row(d, 'Runtime smoke')?.status).toBe('fail');
    expect(decisionDefault(d)).toBe('reject');
  });

  it('keeps UNSURE visible when an authoritative browser pass allows approval', () => {
    const d = baseDetect({
      runtimeSmoke: { ...failSmoke(403), passed: null },
      browser: mcpPass,
    });
    expect(row(d, 'Runtime smoke')).toMatchObject({ status: 'warn', statusLabel: 'UNSURE' });
    expect(row(d, 'Runtime smoke')?.body).toContain('Browser testing already passed');
    expect(decisionDefault(d)).toBe('approve');
  });

  it.each([
    { ...mcpPass, method: 'manual' },
    { ...mcpPass, verificationIncomplete: true },
    { ...mcpPass, skipped: true },
    { ...mcpPass, passed: false },
  ])('does not let an unverified browser result override UNSURE: %j', (browser) => {
    expect(
      decisionDefault(
        baseDetect({
          runtimeSmoke: { ...failSmoke(403), passed: null },
          browser,
        }),
      ),
    ).toBe('reject');
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

describe('gate-2 similar sites', () => {
  const ran = { ran: true, passed: true, output: '' };
  const base = {
    verify: { test: ran, lint: ran, typecheck: ran },
    allPassed: true,
    validation: null,
    testManagement: null,
    browser: null,
    codeReview: null,
    codeAudit: null,
    adversarial: null,
    liveBrowser: null,
    runtimeSmoke: { ran: true, passed: true, httpStatus: 200, url: 'u', errorExcerpt: '' },
  };
  const form = (detected: unknown) =>
    gate2VerifyApprovalStep.form!({} as never, detected as never)!;

  it('lists them in the last row, with the way to act on them', () => {
    const rows =
      form({
        ...base,
        similarSites: [{ path: 'b.ts', reason: 'same', source: 'implementation round 0' }],
        similarSitesOmitted: 0,
      }).statusSummary ?? [];
    const last = rows[rows.length - 1]!;
    expect(last.label).toBe('Similar code elsewhere — not changed');
    expect(last.status).toBe('info');
    expect(last.body).toContain('reject with feedback that names it');
    expect(last.body).toContain('- `b.ts` — same (from implementation round 0)');
  });

  it('renders a payload persisted before the field existed exactly as before', () => {
    const before = form(base);
    expect((before.statusSummary ?? []).some((r) => r.label.startsWith('Similar code'))).toBe(
      false,
    );
    expect(form({ ...base, similarSites: [], similarSitesOmitted: 0 })).toEqual(before);
  });

  it('never moves the decision default', () => {
    const decision = (d: unknown) =>
      (form(d).fields.find((f) => f.id === 'decision') as { default?: string }).default;
    const withSites = {
      ...base,
      similarSites: [{ path: 'b.ts', reason: '', source: 'implementation round 0' }],
    };
    expect(decision(base)).toBe('approve');
    expect(decision(withSites)).toBe('approve');
  });
});

describe('gate-2 out-of-scope insights', () => {
  const ran = { ran: true, passed: true, output: '' };
  const base = {
    verify: { test: ran, lint: ran, typecheck: ran },
    allPassed: true,
    validation: null,
    testManagement: null,
    browser: null,
    codeReview: null,
    codeAudit: null,
    adversarial: null,
    liveBrowser: null,
    runtimeSmoke: { ran: true, passed: true, httpStatus: 200, url: 'u', errorExcerpt: '' },
  };
  const insight = {
    id: 'i-1',
    sourceStep: '08c-code-review',
    title: 'Cache lookup',
    location: 'x.ts:1',
    description: 'hot path',
  };
  const form = (detected: unknown) =>
    gate2VerifyApprovalStep.form!({} as never, detected as never)!;

  it('lists them after the similar-sites row, with the way to act on them', () => {
    const rows =
      form({
        ...base,
        similarSites: [{ path: 'b.ts', reason: 'same', source: 'implementation round 0' }],
        outOfScopeInsights: [insight],
        outOfScopeInsightsOmitted: 0,
      }).statusSummary ?? [];
    expect(rows[rows.length - 2]!.label).toBe('Similar code elsewhere — not changed');
    const last = rows[rows.length - 1]!;
    expect(last.label).toBe('Out-of-scope findings — not acted on');
    expect(last.body).toContain('reject with feedback that names it');
    expect(last.body).toContain('- Cache lookup (`x.ts:1`) — hot path (from 08c-code-review)');
  });

  it('renders a payload persisted before the field existed exactly as before', () => {
    const before = form(base);
    expect((before.statusSummary ?? []).some((r) => r.label.startsWith('Out-of-scope'))).toBe(
      false,
    );
    expect(form({ ...base, outOfScopeInsights: [], outOfScopeInsightsOmitted: 0 })).toEqual(before);
  });

  it('never moves the decision default', () => {
    const decision = (d: unknown) =>
      (form(d).fields.find((f) => f.id === 'decision') as { default?: string }).default;
    expect(decision({ ...base, outOfScopeInsights: [insight] })).toBe('approve');
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

describe('gate-2 verification results read from 08', () => {
  const ctx = {
    taskId: 'task-1',
    repoPath: '/repos/u/r',
    round: 0,
    db: { query: { tasks: { findFirst: vi.fn(async () => null) } } },
    logger: { info: vi.fn(), warn: vi.fn() },
  } as never;
  const skipped = { ran: false, passed: false, command: null, output: 'skipped' };
  const passedRun = { ran: true, passed: true, command: 'pnpm run check', output: '' };

  function stored(lint: unknown, others: unknown = skipped): void {
    m.loadPreviousStepOutput.mockImplementation(async (_db: unknown, _task: unknown, id: string) =>
      id === '08-phase-5-verify'
        ? { output: { test: others, lint, typecheck: others, passed: true, runtimeSmoke: null } }
        : null,
    );
  }

  beforeEach(() => {
    m.getTaskEnvTemplate.mockReset().mockResolvedValue(null);
    m.resolveTaskDirectAccess.mockReset().mockResolvedValue(false);
    m.hasWorkspaceEntry.mockReset().mockResolvedValue(false);
    m.resolveScreenshotRoot.mockReset().mockResolvedValue('/repos/u/r');
    m.loadTaskSimilarSites.mockReset().mockResolvedValue({ sites: [], omitted: 0 });
    m.loadUnactedInsights.mockReset().mockResolvedValue({ insights: [], omitted: 0 });
  });

  it('carries the scope and the note of a check through to the gate row', async () => {
    stored({
      ran: true,
      passed: true,
      command: 'vendor/bin/phpcs',
      output: '35 pre-existing violation(s) elsewhere predate this change — not blocking.',
      scope: { blocking: 0, preExisting: 35 },
      note: 'a note',
    });

    const detected = await gate2VerifyApprovalStep.detect!(ctx);

    expect(detected.verify.lint).toEqual({
      ran: true,
      passed: true,
      output: '35 pre-existing violation(s) elsewhere predate this change — not blocking.',
      scope: { blocking: 0, preExisting: 35 },
      note: 'a note',
    });
    const lint = (gate2VerifyApprovalStep.form!(ctx, detected)!.statusSummary ?? []).find(
      (r) => r.label === 'Lint',
    );
    expect(lint?.status).toBe('warn');
  });

  it('reads an output stored before the scope existed as the three fields it always carried', async () => {
    stored({ ran: true, passed: false, command: 'vendor/bin/phpcs', output: 'raw report' });

    const detected = await gate2VerifyApprovalStep.detect!(ctx);

    expect(detected.verify.lint).toEqual({ ran: true, passed: false, output: 'raw report' });
  });

  it.each([null, true])(
    'reads a stored 403 with passed:%s as an uncertain gate row',
    async (passed) => {
      m.loadPreviousStepOutput.mockImplementation(
        async (_db: unknown, _task: unknown, id: string) =>
          id === '08-phase-5-verify'
            ? {
                output: {
                  test: passedRun,
                  passed: true,
                  runtimeSmoke: {
                    ran: true,
                    passed,
                    httpStatus: 403,
                    url: 'https://app.ddev.site',
                    errorExcerpt: 'Access denied',
                  },
                },
              }
            : null,
      );
      const detected = await gate2VerifyApprovalStep.detect!(ctx);
      expect(detected.runtimeSmoke?.passed).toBe(passed);
      const form = gate2VerifyApprovalStep.form!(ctx, detected)!;
      expect(form.statusSummary?.find((r) => r.label === 'Runtime smoke')).toMatchObject({
        status: 'warn',
        statusLabel: 'UNSURE',
      });
    },
  );

  it('drops a scope that is not two counts, rather than rendering it', async () => {
    stored({ ran: true, passed: true, output: '', scope: { blocking: 'none', preExisting: 4 } });

    const detected = await gate2VerifyApprovalStep.detect!(ctx);

    expect(detected.verify.lint).toEqual({ ran: true, passed: true, output: '' });
  });

  it('carries a check that could not run through to a NOT RUN row, and does not default to approve', async () => {
    const note = 'vendor/bin/phpcs not found — lint not run';
    stored(
      { ran: false, passed: false, command: 'vendor/bin/phpcs', output: note, note },
      passedRun,
    );

    const detected = await gate2VerifyApprovalStep.detect!(ctx);

    expect(detected.verify.lint).toEqual({ ran: false, passed: false, output: note, note });
    const schema = gate2VerifyApprovalStep.form!(ctx, detected)!;
    expect((schema.statusSummary ?? []).find((r) => r.label === 'Lint')).toMatchObject({
      status: 'warn',
      statusLabel: 'NOT RUN',
      detail: note,
    });
    expect(schema.fields.find((f) => f.id === 'decision')).toMatchObject({ default: 'reject' });
  });

  it('renders a skipped check stored before notes existed exactly as it always did', async () => {
    stored(skipped, passedRun);

    const detected = await gate2VerifyApprovalStep.detect!(ctx);
    const schema = gate2VerifyApprovalStep.form!(ctx, detected)!;

    expect(schema.statusSummary).toEqual([
      { label: 'Tests', status: 'pass' },
      { label: 'Typecheck', status: 'pass' },
    ]);
    expect(schema.fields.find((f) => f.id === 'decision')).toMatchObject({ default: 'approve' });
  });
});
