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
import { MiningRetryError } from '../../step-definition.js';
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
function runReview(results: AgentMiningResult[], isFinalMiningAttempt?: boolean) {
  return codeReviewStep.apply(fakeCtx, {
    agentMiningResults: results,
    isFinalMiningAttempt,
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

  it('parses a finding that omits severity instead of failing the whole review', () => {
    // The severity key must stay OPTIONAL. Under zod 4 a bare z.unknown() is
    // non-optional, so one finding without a severity would fail the entire object
    // and the review would be reported as unparseable.
    const p = parsePeerReview(
      '```json\n{"verdict":"DISCUSS","findings":[{"issue":"no sev"}]}\n```',
    );
    expect(p).not.toBeNull();
    expect(p!.findings).toHaveLength(1);
    expect(p!.findings[0]!.severity).toBe('low');
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
        { verdict: 'NEEDS_FIXES', findings: [{ severity: 'high' }] },
      ),
    ).toBe(true);
  });

  it('blocks on a peer critical finding even under a non-REQUEST_CHANGES verdict', () => {
    expect(
      computeBlocking(
        { verdict: 'DISCUSS', findings: [{ severity: 'critical' }] },
        { verdict: 'SECURE', findings: [] },
      ),
    ).toBe(true);
  });

  it('does not block on clean reviews or low/medium only', () => {
    expect(computeBlocking({ verdict: 'APPROVE' }, { verdict: 'SECURE', findings: [] })).toBe(
      false,
    );
    expect(
      computeBlocking(
        { verdict: 'DISCUSS', findings: [{ severity: 'low' }] },
        { verdict: 'NEEDS_FIXES', findings: [{ severity: 'medium' }] },
      ),
    ).toBe(false);
  });

  it('handles null reviews (bypass)', () => {
    expect(computeBlocking(null, null)).toBe(false);
  });

  it('does NOT block on an extra lens REQUEST_CHANGES carrying only advisory findings', () => {
    expect(
      computeBlocking({ verdict: 'APPROVE' }, { verdict: 'SECURE', findings: [] }, [
        { verdict: 'REQUEST_CHANGES', findings: [{ severity: 'medium' }] },
      ]),
    ).toBe(false);
  });

  it('blocks on an extra lens critical/high finding', () => {
    expect(
      computeBlocking({ verdict: 'APPROVE' }, { verdict: 'SECURE', findings: [] }, [
        { verdict: 'REQUEST_CHANGES', findings: [{ severity: 'critical' }] },
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

describe('codeReviewStep.fixLoop diagnosis', () => {
  const blockingOutput = {
    blocking: true,
    peer: {
      verdict: 'REQUEST_CHANGES',
      findings: [{ severity: 'critical', path: 'a.ts', issue: 'npe', fix: 'guard' }],
      positives: [],
    },
    security: { verdict: 'SECURE', findings: [] },
    extraLenses: [],
  };

  it('gives the implementer licence to reject a wrong reviewer finding', () => {
    const v = codeReviewStep.fixLoop!.evaluate(blockingOutput as never);
    expect(v).not.toBeNull();
    // 08c was the only finding path in the workflow without a validate-then-act
    // instruction, so an unverified reviewer claim cost a capped fix round.
    expect(v!.diagnosis).toContain('validate it yourself');
    expect(v!.diagnosis).toContain('Ignore any that are wrong');
    // and it still carries the findings themselves
    expect(v!.diagnosis).toContain('a.ts: npe');
  });

  it('does not fire when nothing blocks', () => {
    expect(
      codeReviewStep.fixLoop!.evaluate({ ...blockingOutput, blocking: false } as never),
    ).toBeNull();
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

  it('parses an extra review lens into extraLenses without blocking on its verdict alone', async () => {
    const out = await runReview([
      mining('peer-reviewer', '```json\n{"verdict":"APPROVE","findings":[],"positives":[]}\n```'),
      mining('security-code-reviewer', '```json\n{"verdict":"SECURE","findings":[]}\n```'),
      mining(
        'operational-reviewer',
        '```json\n{"verdict":"REQUEST_CHANGES","findings":[{"severity":"medium","path":"a.ts","lines":"1-2","issue":"no logging on new path","fix":"add logger"}]}\n```',
      ),
    ]);
    expect(out.reviewed).toBe(true);
    expect(out.extraLenses).toHaveLength(1);
    expect(out.extraLenses[0]!.id).toBe('operational-reviewer');
    expect(out.extraLenses[0]!.verdict).toBe('REQUEST_CHANGES');
    expect(out.extraLenses[0]!.findings).toHaveLength(1);
    // A lens verdict no longer blocks by itself: a medium finding is advisory and
    // must not spend a fix round.
    expect(out.blocking).toBe(false);
  });

  it('blocks when an extra lens raises a critical finding', async () => {
    const out = await runReview([
      mining('peer-reviewer', '```json\n{"verdict":"APPROVE","findings":[],"positives":[]}\n```'),
      mining(
        'operational-reviewer',
        '```json\n{"verdict":"REQUEST_CHANGES","findings":[{"severity":"critical","path":"a.ts","issue":"migration is irreversible"}]}\n```',
      ),
    ]);
    expect(out.blocking).toBe(true);
  });

  it('coerces a pre-ladder severity vocabulary from a repo-checked-in persona', async () => {
    // A repo onboarded before the ladder change still has .claude/agents/peer-reviewer.md
    // on disk specifying critical|warning|suggestion, and the prompt tells the reviewer
    // to follow it. Those findings must still parse.
    const out = await runReview([
      mining(
        'peer-reviewer',
        '```json\n{"verdict":"DISCUSS","findings":[{"severity":"warning","issue":"w"},{"severity":"suggestion","issue":"s"},{"severity":"blocker","issue":"b"}],"positives":[]}\n```',
      ),
    ]);
    expect(out.peer.findings.map((f) => f.severity)).toEqual(['medium', 'low', 'critical']);
    // the coerced blocker is critical, so it blocks
    expect(out.blocking).toBe(true);
  });

  it('re-rolls only the unreadable reviewers while they still have budget', async () => {
    const err = await runReview(
      [
        mining('peer-reviewer', 'prose, no json'),
        mining('security-code-reviewer', '```json\n{"verdict":"SECURE","findings":[]}\n```'),
        mining('operational-reviewer', 'also prose'),
      ],
      false,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MiningRetryError);
    // the security reviewer parsed fine and must not be re-dispatched
    expect((err as MiningRetryError).agentIds).toEqual(['peer-reviewer', 'operational-reviewer']);
  });

  it('does not throw when every reviewer is readable', async () => {
    const out = await runReview(
      [
        mining('peer-reviewer', '```json\n{"verdict":"APPROVE","findings":[],"positives":[]}\n```'),
        mining('security-code-reviewer', '```json\n{"verdict":"SECURE","findings":[]}\n```'),
      ],
      false,
    );
    expect(out.reviewIncomplete).toBe(false);
  });

  it('degrades with reviewIncomplete once the re-roll budget is spent', async () => {
    const out = await runReview([mining('peer-reviewer', 'still prose after the re-roll')], true);
    expect(out.reviewIncomplete).toBe(true);
    expect(out.peer.verdict).toBe('DISCUSS');
    // the reviewer failed, not the code: this must NOT spend a fix round
    expect(out.blocking).toBe(false);
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
