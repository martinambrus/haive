import { describe, it, expect } from 'vitest';
import {
  renderTaskHistoryDigest,
  type DigestStepInput,
  type DigestEventInput,
} from './_task-history-digest.js';

function step(stepId: string, round: number, output: unknown): DigestStepInput {
  return { stepId, round, output };
}
function ev(eventType: string, payload: Record<string, unknown>): DigestEventInput {
  return { eventType, payload };
}

describe('renderTaskHistoryDigest', () => {
  it('empty history -> low tier, minimal digest with no sections', () => {
    const d = renderTaskHistoryDigest([], []);
    expect(d.tier).toBe('low');
    expect(d.maxRound).toBe(0);
    expect(d.fixLoopCount).toBe(0);
    expect(d.findingCount).toBe(0);
    expect(d.text).toContain('complexity: low');
    expect(d.text).not.toContain('## ');
  });

  it('high tier with diagnoses + findings + human reaction + runtime error all present', () => {
    const steps: DigestStepInput[] = [
      step('07b-phase-4-validate', 0, {
        issues: [
          { severity: 'high', file: 'a.php', description: 'regression', fix: 'revert' },
          { severity: 'low', file: 'b.php', description: 'style nit' },
        ],
      }),
      step('08c-code-review', 1, {
        security: {
          findings: [
            { severity: 'critical', path: 'db.php', cwe: 'CWE-89', issue: 'sqli', fix: 'param' },
          ],
        },
        peer: { findings: [] },
      }),
      step('08-phase-5-verify', 1, {
        runtimeSmoke: {
          ran: true,
          passed: false,
          httpStatus: 200,
          errorExcerpt: 'Connection refused',
        },
      }),
    ];
    const events: DigestEventInput[] = [
      ev('fix_loop.requested', {
        round: 1,
        sourceStepId: '08c-code-review',
        diagnosis: 'sqli in db.php',
      }),
      ev('fix_loop.requested', {
        round: 2,
        sourceStepId: '07b-phase-4-validate',
        diagnosis: 'regression in a.php',
      }),
      ev('fix_loop.requested', {
        round: 3,
        sourceStepId: '08c-code-review',
        diagnosis: 'still failing',
      }),
      ev('spec.rejected', { feedback: 'scope too broad' }),
    ];
    const d = renderTaskHistoryDigest(steps, events);
    expect(d.tier).toBe('high');
    expect(d.fixLoopCount).toBe(3);
    expect(d.text).toContain('What blocked it');
    expect(d.text).toContain('sqli in db.php');
    expect(d.text).toContain('[critical] db.php');
    expect(d.text).toContain('Spec rejected: "scope too broad"');
    expect(d.text).toContain('Connection refused');
  });

  it('skips 08c findings a refuter disproved', () => {
    // A refuted finding was shown to be wrong against the code. It is not a lesson the
    // next task should carry, and it must not raise the digest tier.
    const d = renderTaskHistoryDigest(
      [
        step('08c-code-review', 1, {
          peer: {
            findings: [
              { severity: 'critical', path: 'a.ts', issue: 'npe', refuted: true },
              { severity: 'high', path: 'b.ts', issue: 'race' },
            ],
          },
          security: {
            findings: [{ severity: 'critical', path: 'db.php', issue: 'sqli', refuted: true }],
          },
          extraLenses: [
            {
              id: 'operational-reviewer',
              findings: [{ severity: 'high', path: 'c.ts', issue: 'no logs', refuted: true }],
            },
          ],
        }),
      ],
      [],
    );
    expect(d.findingCount).toBe(1);
    expect(d.text).toContain('race');
    expect(d.text).not.toContain('npe');
    expect(d.text).not.toContain('sqli');
    expect(d.text).not.toContain('no logs');
  });

  it('prioritizes critical/high and caps lower-severity findings with a tail', () => {
    const issues: Array<Record<string, unknown>> = [];
    for (let i = 0; i < 50; i += 1) {
      issues.push({ severity: 'low', file: `f${i}.php`, description: `nit ${i}` });
    }
    issues.push({ severity: 'critical', file: 'x.php', description: 'boom', fix: 'fix it' });
    const d = renderTaskHistoryDigest([step('07b-phase-4-validate', 0, { issues })], []);
    expect(d.tier).toBe('high'); // 31 findings >= 15
    expect(d.text).toContain('[critical] x.php');
    expect(d.text).toMatch(/\+\d+ more lower-severity findings/);
  });

  it('medium tier for a single-round task with moderate findings', () => {
    const steps = [
      step('07b-phase-4-validate', 1, {
        issues: [
          { severity: 'medium', file: 'a', description: 'x' },
          { severity: 'medium', file: 'b', description: 'y' },
          { severity: 'medium', file: 'c', description: 'z' },
          { severity: 'medium', file: 'd', description: 'w' },
        ],
      }),
    ];
    const events = [ev('fix_loop.requested', { round: 1, sourceStepId: '07b', diagnosis: 'd' })];
    const d = renderTaskHistoryDigest(steps, events);
    expect(d.tier).toBe('medium');
  });

  it('escalation forces high tier even with one round', () => {
    const d = renderTaskHistoryDigest([], [ev('fix_loop.escalated', { round: 1, rounds: 5 })]);
    expect(d.tier).toBe('high');
  });

  it('respects the total tier cap (truncates oversized content)', () => {
    const big = 'd'.repeat(3000);
    const events: DigestEventInput[] = [];
    for (let i = 1; i <= 12; i += 1) {
      events.push(ev('fix_loop.requested', { round: i, sourceStepId: 's', diagnosis: big }));
    }
    const d = renderTaskHistoryDigest([], events);
    expect(d.tier).toBe('high');
    expect(d.text.length).toBeLessThanOrEqual(20000 + 60);
    expect(d.text).toContain('digest truncated');
  });
});
