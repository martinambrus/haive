import { describe, it, expect } from 'vitest';
import { logger } from '@haive/shared';
import {
  parsePeerReview,
  parseSecurityReview,
  parseReviewLens,
  lensesForLevel,
  computeBlocking,
  codeReviewStep,
} from './08c-code-review.js';
import type { AgentMiningResult, StepContext } from '../../step-definition.js';

const fakeCtx = { logger: logger.child({ test: '08c-apply' }) } as unknown as StepContext;
function mining(agentId: string, rawOutput: string | null): AgentMiningResult {
  return {
    agentId,
    agentTitle: agentId,
    status: 'done',
    output: null,
    rawOutput,
    errorMessage: null,
  };
}
function runReview(results: AgentMiningResult[]) {
  return codeReviewStep.apply(fakeCtx, {
    agentMiningResults: results,
  } as unknown as Parameters<typeof codeReviewStep.apply>[1]);
}

describe('parsePeerReview', () => {
  it('parses a fenced peer review', () => {
    const raw =
      'reviewed\n```json\n{"verdict":"REQUEST_CHANGES","findings":[{"severity":"critical","path":"a.ts","lines":"10-12","issue":"npe","fix":"guard"}],"positives":["clean naming"]}\n```';
    const p = parsePeerReview(raw);
    expect(p).not.toBeNull();
    expect(p!.verdict).toBe('REQUEST_CHANGES');
    expect(p!.findings).toHaveLength(1);
    expect(p!.positives).toEqual(['clean naming']);
  });

  it('defaults verdict to DISCUSS and arrays when omitted', () => {
    const p = parsePeerReview('```json\n{}\n```');
    expect(p!.verdict).toBe('DISCUSS');
    expect(p!.findings).toEqual([]);
    expect(p!.positives).toEqual([]);
  });

  it('returns null on garbled output', () => {
    expect(parsePeerReview('no json')).toBeNull();
    expect(parsePeerReview(null)).toBeNull();
  });
});

describe('parseSecurityReview', () => {
  it('parses a fenced security review', () => {
    const raw =
      '```json\n{"verdict":"VULNERABLE","findings":[{"severity":"high","in_scope":"yes","path":"q.ts","line":5,"cwe":"CWE-89","issue":"sqli","attack":"\\u0027 OR 1=1","fix":"param"}]}\n```';
    const p = parseSecurityReview(raw);
    expect(p!.verdict).toBe('VULNERABLE');
    expect(p!.findings[0]!.severity).toBe('high');
    expect(p!.findings[0]!.line).toBe(5);
  });

  it('accepts an already-parsed object', () => {
    const p = parseSecurityReview({ verdict: 'SECURE', findings: [] });
    expect(p!.verdict).toBe('SECURE');
  });

  it('returns null on garbled output', () => {
    expect(parseSecurityReview('nope')).toBeNull();
  });
});

describe('parseReviewLens', () => {
  it('parses a fenced review lens', () => {
    const p = parseReviewLens(
      '```json\n{"verdict":"REQUEST_CHANGES","findings":[{"severity":"warning","path":"a.ts","issue":"x"}]}\n```',
    );
    expect(p).not.toBeNull();
    expect(p!.verdict).toBe('REQUEST_CHANGES');
    expect(p!.findings).toHaveLength(1);
  });

  it('defaults verdict to DISCUSS when omitted', () => {
    const p = parseReviewLens('```json\n{}\n```');
    expect(p!.verdict).toBe('DISCUSS');
    expect(p!.findings).toEqual([]);
  });

  it('returns null on garbled output', () => {
    expect(parseReviewLens('no json here')).toBeNull();
    expect(parseReviewLens(null)).toBeNull();
  });
});

describe('lensesForLevel', () => {
  it('adds no lenses for none/poc', () => {
    expect(lensesForLevel('none').map((l) => l.id)).toEqual([]);
    expect(lensesForLevel('poc').map((l) => l.id)).toEqual([]);
  });

  it('adds the operational lens at standard', () => {
    expect(lensesForLevel('standard').map((l) => l.id)).toEqual(['operational-reviewer']);
  });

  it('adds operational + performance + simplicity at enterprise', () => {
    expect(lensesForLevel('enterprise').map((l) => l.id)).toEqual([
      'operational-reviewer',
      'performance-reviewer',
      'simplicity-reviewer',
    ]);
  });
});

describe('computeBlocking', () => {
  it('blocks on peer REQUEST_CHANGES', () => {
    expect(
      computeBlocking({ verdict: 'REQUEST_CHANGES' }, { verdict: 'SECURE', findings: [] }),
    ).toBe(true);
  });

  it('blocks on security VULNERABLE', () => {
    expect(computeBlocking({ verdict: 'APPROVE' }, { verdict: 'VULNERABLE', findings: [] })).toBe(
      true,
    );
  });

  it('blocks on any critical/high security finding', () => {
    expect(
      computeBlocking(
        { verdict: 'APPROVE' },
        { verdict: 'NEEDS_FIXES', findings: [{ severity: 'High', issue: 'x' }] },
      ),
    ).toBe(true);
  });

  it('does not block on clean reviews or low/medium only', () => {
    expect(computeBlocking({ verdict: 'APPROVE' }, { verdict: 'SECURE', findings: [] })).toBe(
      false,
    );
    expect(
      computeBlocking(
        { verdict: 'DISCUSS' },
        { verdict: 'NEEDS_FIXES', findings: [{ severity: 'medium', issue: 'x' }] },
      ),
    ).toBe(false);
  });

  it('handles null reviews (bypass)', () => {
    expect(computeBlocking(null, null)).toBe(false);
  });

  it('blocks on an extra lens REQUEST_CHANGES', () => {
    expect(
      computeBlocking({ verdict: 'APPROVE' }, { verdict: 'SECURE', findings: [] }, [
        { verdict: 'REQUEST_CHANGES' },
      ]),
    ).toBe(true);
  });

  it('does not block on extra lenses that approve or discuss', () => {
    expect(
      computeBlocking({ verdict: 'APPROVE' }, { verdict: 'SECURE', findings: [] }, [
        { verdict: 'APPROVE' },
        { verdict: 'DISCUSS' },
      ]),
    ).toBe(false);
  });
});

describe('codeReviewStep.apply de-silence', () => {
  it('does NOT silently APPROVE/SECURE when a reviewer ran but its output was unparseable', async () => {
    const out = await runReview([
      mining('peer-reviewer', 'I reviewed everything thoroughly but forgot to emit any JSON'),
      mining('security-code-reviewer', 'No obvious problems in prose form, no json here'),
    ]);
    expect(out.reviewed).toBe(true);
    expect(out.peer.verdict).not.toBe('APPROVE');
    expect(out.security.verdict).not.toBe('SECURE');
    expect(out.peer.findings.length).toBeGreaterThan(0);
  });

  it('reports a clean no-op only when no reviewer ran (bypass)', async () => {
    const out = await runReview([]);
    expect(out.reviewed).toBe(false);
    expect(out.peer.verdict).toBe('APPROVE');
    expect(out.security.verdict).toBe('SECURE');
    expect(out.blocking).toBe(false);
  });

  it('still blocks on a real parsed REQUEST_CHANGES', async () => {
    const out = await runReview([
      mining(
        'peer-reviewer',
        '```json\n{"verdict":"REQUEST_CHANGES","findings":[{"severity":"critical","issue":"bug"}]}\n```',
      ),
    ]);
    expect(out.reviewed).toBe(true);
    expect(out.blocking).toBe(true);
  });

  it('parses an extra review lens into extraLenses and blocks on its REQUEST_CHANGES', async () => {
    const out = await runReview([
      mining('peer-reviewer', '```json\n{"verdict":"APPROVE","findings":[],"positives":[]}\n```'),
      mining('security-code-reviewer', '```json\n{"verdict":"SECURE","findings":[]}\n```'),
      mining(
        'operational-reviewer',
        '```json\n{"verdict":"REQUEST_CHANGES","findings":[{"severity":"warning","path":"a.ts","lines":"1-2","issue":"no logging on new path","fix":"add logger"}]}\n```',
      ),
    ]);
    expect(out.reviewed).toBe(true);
    expect(out.extraLenses).toHaveLength(1);
    expect(out.extraLenses[0]!.id).toBe('operational-reviewer');
    expect(out.extraLenses[0]!.verdict).toBe('REQUEST_CHANGES');
    expect(out.extraLenses[0]!.findings).toHaveLength(1);
    // a lens REQUEST_CHANGES blocks even when peer + security are clean
    expect(out.blocking).toBe(true);
  });

  it('surfaces an unparseable lens as non-approving, not silently approving', async () => {
    const out = await runReview([
      mining('peer-reviewer', '```json\n{"verdict":"APPROVE","findings":[],"positives":[]}\n```'),
      mining('operational-reviewer', 'I checked everything but emitted no JSON'),
    ]);
    const op = out.extraLenses.find((l) => l.id === 'operational-reviewer');
    expect(op).toBeDefined();
    expect(op!.verdict).toBe('DISCUSS');
    expect(op!.findings.length).toBeGreaterThan(0);
  });
});
