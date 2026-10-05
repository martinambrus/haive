import { describe, expect, it } from 'vitest';
import { buildTaskHistory, historyDividerAfter, type HistoryStep } from './task-history';
import type { TaskEvent } from './api-client';

const endedAt = '2026-10-05T12:32:30.000Z';
function step(patch: Partial<HistoryStep> = {}): HistoryStep {
  return {
    id: 'implement-round-3',
    stepId: '07-phase-2-implement',
    title: 'Phase 2: Implement',
    round: 3,
    usesCli: true,
    cliInvocationCount: 1,
    status: 'done',
    output: null,
    warningMessage: null,
    degradedNote: null,
    endedAt,
    ...patch,
  };
}
function fixEvent(patch: Partial<TaskEvent> = {}): TaskEvent {
  return {
    id: 'event-1',
    taskId: 'task-1',
    taskStepId: 'implement-round-3',
    eventType: 'fix_loop.requested',
    createdAt: '2026-10-05T12:32:31.000Z',
    payload: { diagnosis: 'Recovery-marker deletion failed. Further details.' },
    ...patch,
  };
}
const entry = (patch: Partial<HistoryStep>, events: TaskEvent[] = []) =>
  buildTaskHistory([step(patch)], events)[0]!;

describe('previous-visit divider', () => {
  const entries = buildTaskHistory([
    step({ id: 'first', endedAt: '2026-10-05T12:00:00Z' }),
    step({ id: 'second', endedAt: '2026-10-05T12:01:00Z' }),
    step({ id: 'third', endedAt: '2026-10-05T12:02:00Z' }),
  ]);
  it('omits the divider for a first visit or invalid stored boundary', () => {
    expect(historyDividerAfter(entries, null)).toBeNull();
    expect(historyDividerAfter(entries, NaN)).toBeNull();
  });
  it('places one divider after the last outcome present on the previous visit', () => {
    expect(historyDividerAfter(entries, Date.parse('2026-10-05T12:01:00Z'))).toBe('second');
  });
  it('omits the divider when there are no newer or no previous outcomes', () => {
    expect(historyDividerAfter(entries, Date.parse('2026-10-05T12:02:00Z'))).toBeNull();
    expect(historyDividerAfter(entries, Date.parse('2026-10-05T11:59:00Z'))).toBeNull();
    expect(historyDividerAfter([], Date.parse(endedAt))).toBeNull();
  });
});

describe('implementation overview', () => {
  it('keeps separate rounds and sorts from first to last by completion time', () => {
    const history = buildTaskHistory([
      step(),
      step({ id: 'round-0', round: 0, endedAt: '2026-10-05T12:00:00Z' }),
      step({ id: 'review', round: 0, endedAt: '2026-10-05T12:31:00Z' }),
    ]);
    expect(history.map((e) => e.id)).toEqual(['round-0', 'review', 'implement-round-3']);
    expect(history.at(-1)).toMatchObject({ timestamp: endedAt, round: 3 });
  });
  it('omits skipped, live, pending and unended rows', () => {
    expect(
      buildTaskHistory([
        step({ status: 'skipped' }),
        step({ status: 'running' }),
        step({ status: 'waiting_cli' }),
        step({ status: 'pending' }),
        step({ endedAt: null }),
        step({ endedAt: 'invalid' }),
      ]),
    ).toEqual([]);
  });
  it('hides successful deterministic steps even if they carry a curated recap or warning', () => {
    expect(
      buildTaskHistory([
        step({
          usesCli: false,
          cliInvocationCount: 0,
          output: { summary: 'Reconciled the environment.' },
        }),
        step({ usesCli: false, cliInvocationCount: 0, warningMessage: 'A nonfatal warning.' }),
        step({
          usesCli: false,
          cliInvocationCount: 0,
          output: { test: { ran: true, passed: true } },
        }),
      ]),
    ).toEqual([]);
  });
  it('hides CLI-capable steps that ran no agent, including degraded deterministic checks', () => {
    expect(
      buildTaskHistory([
        step({ cliInvocationCount: 0 }),
        step({ cliInvocationCount: 0, degradedNote: 'No verification check ran.' }),
      ]),
    ).toEqual([]);
  });
  it('keeps deterministic failures and explicit failing checks', () => {
    const history = buildTaskHistory([
      step({ id: 'setup', usesCli: false, cliInvocationCount: 0, status: 'failed' }),
      step({
        id: 'check',
        usesCli: false,
        cliInvocationCount: 0,
        output: { test: { ran: true, passed: false } },
      }),
    ]);
    expect(history).toHaveLength(2);
    expect(history.find((e) => e.id === 'setup')).toMatchObject({
      tone: 'error',
      message: 'This step failed.',
    });
    expect(history.find((e) => e.id === 'check')?.message).toContain('failing checks');
  });
  it('keeps a deterministic step that requested a fix round', () => {
    expect(entry({ usesCli: false, cliInvocationCount: 0 }, [fixEvent()])).toMatchObject({
      tone: 'error',
      message: 'Another implementation pass was requested.',
    });
  });
  it('summarizes the audit without exposing long findings, paths or ellipses', () => {
    const result = entry({
      output: {
        audited: true,
        findings: [
          {
            severity: 'medium',
            issue:
              'The added post-start hook runs Composer on every DDEV startup. ' +
              'Long details. '.repeat(30),
            path: '.haive/spec.md',
          },
        ],
      },
    });
    expect(result.message).toBe('The audit found 1 medium-severity finding.');
    expect(result.message).not.toMatch(/Composer|haive|…/);
  });
  it('reports the count and highest severity for mixed reviewer findings', () => {
    expect(
      entry({
        output: {
          reviewed: true,
          peer: { findings: [{ severity: 'low', issue: 'Cosmetic concern.' }] },
          security: { findings: [{ severity: 'high', issue: 'Real defect.' }] },
        },
      }).message,
    ).toBe('The review found 2 findings (highest severity: high).');
  });
  it('keeps report-only observations advisory and trusts the host fix verdict', () => {
    const output = {
      blocking: false,
      peer: {
        findings: [{ severity: 'critical', upstream: 'third-party', issue: 'Upstream defect.' }],
      },
    };
    expect(entry({ output })).toMatchObject({
      tone: 'warning',
      message: 'The review found 1 critical-severity finding.',
    });
    expect(entry({ output: { ...output, blocking: true } }).message).toContain(
      'Fix round requested.',
    );
  });
  it('counts reviewer reports rather than claiming they are unique bugs', () => {
    expect(
      entry({
        output: {
          peer: { findings: [{ severity: 'high', issue: 'Same defect.' }] },
          security: { findings: [{ severity: 'high', issue: 'Same defect.' }] },
        },
      }).message,
    ).toBe('The review found 2 high-severity findings.');
  });
  it('excludes refuted findings from the reported count', () => {
    expect(
      entry({
        output: {
          peer: {
            findings: [
              { severity: 'critical', refuted: true, issue: 'Disproved bug.' },
              { severity: 'low', issue: 'Remaining advisory.' },
            ],
          },
        },
      }).message,
    ).toBe('The review found 1 low-severity finding.');
  });
  it('reports approval only when all reviewer verdicts explicitly approve', () => {
    const output = {
      reviewed: true,
      blocking: false,
      peer: { verdict: 'APPROVE', findings: [] },
      security: { verdict: 'SECURE', findings: [] },
      extraLenses: [{ verdict: 'APPROVE', findings: [] }],
    };
    expect(entry({ output })).toMatchObject({
      tone: 'success',
      message: 'All reviewers approved; no issues found.',
    });
    expect(entry({ output: { ...output, security: { verdict: 'UNPARSEABLE' } } }).tone).toBe(
      'neutral',
    );
    expect(entry({ output: { ...output, reviewIncomplete: true } }).tone).toBe('warning');
    expect(entry({ output: { ...output, coverage: { truncated: true } } }).tone).toBe('warning');
    expect(entry({ output: { ...output, advisoryVerdict: true } }).tone).toBe('warning');
    expect(entry({ output: { ...output, refutedCount: 2 } }).message).toContain('refuted');
  });
  it('distinguishes applied fixes, unresolved findings and clean validation', () => {
    expect(
      entry({
        output: { verdict: 'VALID', fixesApplied: ['Added marker verification.', 'Added tests.'] },
      }).message,
    ).toBe('Validation applied 2 fixes.');
    expect(entry({ output: { verdict: 'VALID', fixesApplied: [] } }).message).toBe(
      'No issues found; nothing to fix.',
    );
    expect(
      entry({
        output: {
          verdict: 'ISSUES_FOUND',
          fixesApplied: ['Partial repair.'],
          issues: [{ description: 'Deletion still fails.', severity: 'high' }],
        },
      }).message,
    ).toBe('Validation found 1 high-severity finding.');
    expect(entry({ output: { verdict: 'UNPARSEABLE' } }).tone).toBe('warning');
  });
  it('includes only the implementation-to-gate-2 segment, across all rounds', () => {
    const history = buildTaskHistory([
      step({ id: 'early-error', stepId: '01c-ddev-env', status: 'failed' }),
      step({ id: 'model-health', stepId: '00-model-health-workflow', output: { ok: true } }),
      step({ id: 'discovery', stepId: '03-phase-0a-discovery' }),
      step({ id: 'spec', stepId: '05-phase-0b5-spec-quality', output: { verdict: 'APPROVED' } }),
      step({ id: 'dag', stepId: '06c-dag-execute' }),
      step({ id: 'implement', round: 0 }),
      step({ id: 'validate', stepId: '07b-phase-4-validate', output: { verdict: 'VALID' } }),
      step({ id: 'gate2', stepId: '09-gate-2-verify-approval', output: { decision: 'approve' } }),
      step({ id: 'commit', stepId: '10-gate-3-commit', status: 'failed' }),
      step({ id: 'learn', stepId: '11-phase-8-learning' }),
      step({ id: 'cleanup', stepId: '12-worktree-cleanup', status: 'failed' }),
      step({ id: 'onboarding', stepId: '07-unrelated-onboarding-step', status: 'failed' }),
      step({ id: 'fix-pass', round: 4 }),
    ]);
    expect(history.map((e) => e.id).sort()).toEqual(['fix-pass', 'gate2', 'implement', 'validate']);
  });
  it('hides in-scope agent steps without an actionable result instead of showing generic completion', () => {
    expect(
      buildTaskHistory([
        step({ stepId: '08a-browser-setup', output: {} }),
        step({
          stepId: '08b-test-management',
          output: { testsCreated: [], testsUpdated: [], testsPassed: null },
        }),
      ]),
    ).toEqual([]);
  });
  it('shows a rejected verification gate even before its fix event arrives', () => {
    expect(
      entry({
        stepId: '09-gate-2-verify-approval',
        usesCli: false,
        cliInvocationCount: 0,
        output: { decision: 'reject', feedback: 'Long details.' },
      }),
    ).toMatchObject({
      tone: 'error',
      message: 'Verification was rejected; fixes requested.',
    });
    expect(
      buildTaskHistory([
        step({
          stepId: '09-gate-2-verify-approval',
          usesCli: false,
          cliInvocationCount: 0,
          output: { decision: 'approve' },
        }),
      ]),
    ).toEqual([]);
  });
  it('gives simplification and browser verification explicit short outcomes', () => {
    expect(
      entry({ stepId: '07a-code-simplify', output: { ran: true, noChangesNeeded: true } }).message,
    ).toBe('The simplifier found no changes needed.');
    expect(
      entry({ stepId: '07a-code-simplify', output: { ran: true, filesSimplified: ['a.php'] } })
        .message,
    ).toBe('The agent simplified 1 file.');
    expect(
      entry({ stepId: '08a-browser-verify', output: { ran: true, skipped: false, passed: true } })
        .message,
    ).toBe('Browser verification passed.');
  });
  it('keeps adversarial QA findings and incomplete coverage distinct from a clean result', () => {
    expect(
      entry({
        stepId: '08d-adversarial-qa',
        output: {
          ran: true,
          qaIncomplete: false,
          findings: [{ severity: 'medium', category: 'security', impact: 'Long details.' }],
        },
      }).message,
    ).toBe('The review found 1 medium-severity finding.');
    expect(
      entry({
        stepId: '08d-adversarial-qa',
        output: { ran: true, qaIncomplete: true, findings: [] },
      }).tone,
    ).toBe('warning');
    expect(
      entry({
        stepId: '08d-adversarial-qa',
        output: { ran: true, qaIncomplete: false, findings: [] },
      }).message,
    ).toBe('Adversarial QA found no issues.');
  });
  it('does not invent success for absent, null, skipped or stubbed checks', () => {
    expect(entry({ output: { testsPassed: null, passed: true } }).tone).toBe('neutral');
    expect(entry({ output: { test: { ran: false, passed: true } } }).tone).toBe('neutral');
    expect(
      entry({ output: { test: { ran: true, passed: true }, lint: { ran: false } } }),
    ).toMatchObject({ tone: 'warning', message: 'Checks passed; some checks were skipped.' });
    expect(entry({ output: { source: 'stub', verdict: 'VALID' } }).tone).toBe('warning');
    expect(entry({ output: { runtimeSmoke: { ran: true, passed: false } } }).message).toContain(
      'failing checks',
    );
    expect(entry({ output: { test: { ran: true, passed: true } } }).tone).toBe('success');
  });
  it('describes a fix pass concisely without reprinting the implementation recap', () => {
    const output = {
      filesTouched: ['a.php', 'b.php'],
      summary: 'Opravené falošné hlásenie úspechu. ' + 'More details. '.repeat(80),
    };
    expect(entry({ output }).message).toBe('The agent completed a fix pass (2 files changed).');
    expect(entry({ round: 0, output }).message).toBe(
      'The agent implemented the changes (2 files changed).',
    );
  });
  it('ignores an old fix request after the same row finishes a manual retry', () => {
    expect(entry({ endedAt: '2026-10-05T13:00:00Z' }, [fixEvent()]).tone).toBe('neutral');
  });
  it('does not reprint human rejection diagnoses or degraded-result details', () => {
    expect(
      entry({}, [
        fixEvent({
          payload: { diagnosis: 'Long authoritative feedback. ' + 'More details. '.repeat(80) },
        }),
      ]).message,
    ).toBe('Another implementation pass was requested.');
    expect(
      entry({
        degradedNote:
          'Browser binaries are unavailable. ' + 'Long repair instructions. '.repeat(80),
        output: { testsPassed: true },
      }),
    ).toMatchObject({
      tone: 'warning',
      message: 'This step finished with incomplete checks or results.',
    });
  });
});
