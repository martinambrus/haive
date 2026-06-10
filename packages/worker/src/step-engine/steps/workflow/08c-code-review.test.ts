import { describe, it, expect } from 'vitest';
import { parsePeerReview, parseSecurityReview, computeBlocking } from './08c-code-review.js';

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
});
