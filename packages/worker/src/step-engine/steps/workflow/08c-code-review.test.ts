import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { configService, logger } from '@haive/shared';
import {
  parsePeerReview,
  parseSecurityReview,
  parseReviewLens,
  lensesForLevel,
  computeBlocking,
  collectRefutable,
  isRefuted,
  codeReviewStep,
} from './08c-code-review.js';
import { MiningRetryError, MiningWaveError } from '../../step-definition.js';
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
/** Defaults `miningWaveExhausted: true` so a test that only cares about the review
 *  itself never fans out refuters. The refutation tests below opt back in. */
function runReview(
  results: AgentMiningResult[],
  isFinalMiningAttempt?: boolean,
  miningWaveExhausted = true,
) {
  return codeReviewStep.apply(fakeCtx, {
    detected: { spec: 'the spec', implementationFiles: [], debtBlock: '', level: 'none' },
    agentMiningResults: results,
    isFinalMiningAttempt,
    miningWaveExhausted,
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

  it('defaults verdict to DISCUSS and arrays when partially omitted', () => {
    const p = parsePeerReview('```json\n{"findings":[]}\n```');
    expect(p!.verdict).toBe('DISCUSS');
    expect(p!.findings).toEqual([]);
    expect(p!.positives).toEqual([]);
    // and the mirror: a verdict with no findings key
    expect(parsePeerReview('```json\n{"verdict":"APPROVE"}\n```')!.findings).toEqual([]);
  });

  it('rejects an object that names neither a verdict nor findings', () => {
    // Every field is optional, so an unguarded parse turns ANY object into an empty,
    // non-blocking review. `{}` communicates nothing — treat it as unparseable and
    // re-roll, rather than reporting a silent clean review.
    expect(parsePeerReview('```json\n{}\n```')).toBeNull();
    expect(parsePeerReview('```json\n{"require":{"drupal/core":"^10"}}\n```')).toBeNull();
  });

  it('parses its own JSON, not a .json file it quoted as evidence', () => {
    // Reviewing composer.json, the reviewer fences the offending file before its
    // verdict. Anchoring on the FIRST fence parsed the evidence as the review: a
    // critical REQUEST_CHANGES silently became DISCUSS with zero findings, which does
    // not block and shows OK at gate 2.
    const raw = [
      'The change pins an outdated core:',
      '```json',
      '{"require": {"drupal/core": "^10.0.0"}}',
      '```',
      'That version has a known SA. My verdict:',
      '```json',
      '{"verdict":"REQUEST_CHANGES","findings":[{"severity":"critical","path":"composer.json","issue":"pins a vulnerable drupal/core","fix":"bump"}],"positives":[]}',
      '```',
    ].join('\n');
    const p = parsePeerReview(raw);
    expect(p).not.toBeNull();
    expect(p!.verdict).toBe('REQUEST_CHANGES');
    expect(p!.findings).toHaveLength(1);
    expect(p!.findings[0]!.severity).toBe('critical');
  });

  it('finds JSON that follows a brace which is only prose', () => {
    const p = parsePeerReview('Checked src/{a,b}.ts.\n\n{"verdict":"APPROVE","findings":[]}');
    expect(p!.verdict).toBe('APPROVE');
  });

  it('does not let an inline APPROVE example outrank the fenced REQUEST_CHANGES', () => {
    const p = parsePeerReview(
      'I will not simply emit {"verdict": "APPROVE"} without checking.\n' +
        '```json\n{"verdict":"REQUEST_CHANGES","findings":[{"severity":"critical","issue":"npe"}]}\n```',
    );
    expect(p!.verdict).toBe('REQUEST_CHANGES');
    expect(p!.findings).toHaveLength(1);
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

  it('parses its own JSON, not a config it quoted as evidence', () => {
    const raw = [
      'Offending config:',
      '```json',
      '{"debug": true}',
      '```',
      'Verdict:',
      '```json',
      '{"verdict":"VULNERABLE","findings":[{"severity":"critical","path":"q.php","issue":"sqli","fix":"param"}]}',
      '```',
    ].join('\n');
    const p = parseSecurityReview(raw);
    expect(p!.verdict).toBe('VULNERABLE');
    expect(p!.findings).toHaveLength(1);
  });

  it('returns null on garbled output', () => {
    expect(parseSecurityReview('nope')).toBeNull();
    expect(parseSecurityReview('```json\n{"debug":true}\n```')).toBeNull();
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
    const p = parseReviewLens('```json\n{"findings":[]}\n```');
    expect(p!.verdict).toBe('DISCUSS');
    expect(p!.findings).toEqual([]);
  });

  it('rejects an object that names neither a verdict nor findings', () => {
    expect(parseReviewLens('```json\n{}\n```')).toBeNull();
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

describe('collectRefutable', () => {
  const peer = {
    findings: [
      { severity: 'critical' as const, path: 'a.ts', lines: '4', issue: 'npe' },
      { severity: 'medium' as const, path: 'b.ts', issue: 'naming' },
    ],
  };
  const security = {
    findings: [{ severity: 'high' as const, path: 'c.ts', line: 9, issue: 'sqli' }],
  };

  it('takes only the blocking-severity findings, one refuter each', () => {
    const r = collectRefutable(peer, security, []);
    expect(r.map((f) => f.issue)).toEqual(['npe', 'sqli']);
    expect(r.every((f) => f.agentId.startsWith('refute-'))).toBe(true);
    // distinct findings get distinct refuters
    expect(new Set(r.map((f) => f.agentId)).size).toBe(2);
  });

  it('is deterministic, so the dispatching apply and the reading apply agree', () => {
    expect(collectRefutable(peer, security, [])[0]!.agentId).toBe(
      collectRefutable(peer, security, [])[0]!.agentId,
    );
  });

  it('collapses a finding the same reviewer reported twice', () => {
    const dup = {
      findings: [
        { severity: 'critical' as const, path: 'a.ts', lines: '4', issue: 'npe' },
        { severity: 'critical' as const, path: 'a.ts', lines: '40', issue: 'npe' },
      ],
    };
    expect(collectRefutable(dup, { findings: [] }, [])).toHaveLength(1);
  });
});

describe('isRefuted', () => {
  it('dismisses a finding only on a cited file:line', () => {
    expect(isRefuted('```json\n{"refuted":true,"evidence":"src/a.ts:42"}\n```')).toBe(true);
  });

  it('keeps the finding when the refuter is uncertain, silent, or unreadable', () => {
    // Fail CLOSED. A wrongly-dismissed critical defaults gate 2 to approve; a wrongly
    // kept one costs a fix round.
    expect(isRefuted('```json\n{"refuted":false,"evidence":"src/a.ts:42"}\n```')).toBe(false);
    expect(isRefuted('```json\n{"refuted":true,"reason":"it looks fine to me"}\n```')).toBe(false);
    expect(isRefuted('```json\n{"refuted":true,"evidence":"the code is fine"}\n```')).toBe(false);
    expect(isRefuted('I could not find the file, so probably refuted')).toBe(false);
    expect(isRefuted(null)).toBe(false);
    expect(isRefuted('```json\n{}\n```')).toBe(false);
  });

  it('ignores a citation the refuter only echoed from the finding it was handed', () => {
    // The prompt quotes the finding's own `path:line`; a refuter that restates it in
    // prose has cited nothing it read. Only `evidence` counts.
    expect(isRefuted('```json\n{"refuted":true,"reason":"src/a.ts:42 is unreachable"}\n```')).toBe(
      false,
    );
  });
});

describe('codeReviewStep refutation pass', () => {
  const CRITICAL_PEER =
    '```json\n{"verdict":"REQUEST_CHANGES","findings":[{"severity":"critical","path":"a.ts","lines":"4","issue":"npe","fix":"guard"}],"positives":[]}\n```';
  const CLEAN_SECURITY = '```json\n{"verdict":"SECURE","findings":[]}\n```';

  /** The agent id 08c will address this finding's refuter by. */
  const refuterId = collectRefutable(
    { findings: [{ severity: 'critical', path: 'a.ts', lines: '4', issue: 'npe', fix: 'guard' }] },
    { findings: [] },
    [],
  )[0]!.agentId;

  beforeEach(() => {
    vi.spyOn(configService, 'getBoolean').mockResolvedValue(true);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** apply() with no wave dispatched yet — the first pass, which may throw. */
  const firstPass = (results: AgentMiningResult[]) => runReview(results, true, false);

  it('fans out one refuter per blocking finding', async () => {
    const err = await firstPass([
      mining('peer-reviewer', CRITICAL_PEER),
      mining('security-code-reviewer', CLEAN_SECURITY),
    ]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MiningWaveError);
    const dispatches = (err as MiningWaveError).dispatches;
    expect(dispatches).toHaveLength(1);
    expect(dispatches[0]!.agentId).toBe(refuterId);
    expect(dispatches[0]!.prompt).toContain('DISPROVE');
    expect(dispatches[0]!.prompt).toContain('npe');
  });

  it('caps the fan-out and refutes the most severe findings first', async () => {
    // One sandboxed CLI invocation per refuter. A round with 12 blocking findings is
    // going back to the implementer whatever we disprove, so bound the spend — and
    // spend it on the criticals.
    const findings = [
      ...Array.from({ length: 8 }, (_, i) => ({
        severity: 'high',
        path: `h${i}.ts`,
        issue: `high ${i}`,
      })),
      ...Array.from({ length: 4 }, (_, i) => ({
        severity: 'critical',
        path: `c${i}.ts`,
        issue: `critical ${i}`,
      })),
    ];
    const err = await firstPass([
      mining(
        'peer-reviewer',
        `\`\`\`json\n${JSON.stringify({ verdict: 'REQUEST_CHANGES', findings, positives: [] })}\n\`\`\``,
      ),
    ]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MiningWaveError);
    const prompts = (err as MiningWaveError).dispatches.map((d) => d.prompt);
    expect(prompts).toHaveLength(10);
    // every critical got a refuter; two of the highs were dropped
    for (let i = 0; i < 4; i += 1) {
      expect(prompts.some((p) => p.includes(`critical ${i}`))).toBe(true);
    }
    expect(prompts.filter((p) => p.includes('severity high'))).toHaveLength(6);
  });

  it('never fans out when nothing blocks', async () => {
    const out = await firstPass([
      mining('peer-reviewer', '```json\n{"verdict":"APPROVE","findings":[],"positives":[]}\n```'),
      mining('security-code-reviewer', CLEAN_SECURITY),
    ]);
    expect(out.blocking).toBe(false);
    expect(out.refutedCount).toBe(0);
  });

  it('never fans out when the block is a bare verdict with no finding behind it', async () => {
    // Nothing to disprove: the reviewer asserted, it did not cite.
    const out = await firstPass([
      mining(
        'peer-reviewer',
        '```json\n{"verdict":"REQUEST_CHANGES","findings":[{"severity":"medium","issue":"m"}],"positives":[]}\n```',
      ),
    ]);
    expect(out.blocking).toBe(true);
    expect(out.refutedCount).toBe(0);
  });

  it('never fans out when the kill-switch is off', async () => {
    vi.spyOn(configService, 'getBoolean').mockResolvedValue(false);
    const out = await firstPass([mining('peer-reviewer', CRITICAL_PEER)]);
    expect(out.blocking).toBe(true);
    expect(out.refutedCount).toBe(0);
  });

  it('never fans out twice: an exhausted wave runs the review as-is', async () => {
    const out = await runReview([mining('peer-reviewer', CRITICAL_PEER)], true, true);
    expect(out.blocking).toBe(true);
    expect(out.refutedCount).toBe(0);
  });

  it('dismisses a refuted finding: no block, no fix round, still visible', async () => {
    const out = await firstPass([
      mining('peer-reviewer', CRITICAL_PEER),
      mining('security-code-reviewer', CLEAN_SECURITY),
      mining(
        refuterId,
        '```json\n{"refuted":true,"evidence":"a.ts:4 guards the value already"}\n```',
      ),
    ]);
    expect(out.refutedCount).toBe(1);
    expect(out.blocking).toBe(false);
    // the verdict rested entirely on the refuted finding, so it is downgraded
    expect(out.peer.verdict).toBe('DISCUSS');
    // but the finding itself is still reported to the human at gate 2
    expect(out.peer.findings).toHaveLength(1);
    expect(out.peer.findings[0]!.refuted).toBe(true);
    // and never reaches the implementer
    expect(codeReviewStep.fixLoop!.evaluate(out)).toBeNull();
  });

  it('keeps a finding whose refuter cited nothing', async () => {
    const out = await firstPass([
      mining('peer-reviewer', CRITICAL_PEER),
      mining(refuterId, '```json\n{"refuted":true,"reason":"seems fine"}\n```'),
    ]);
    expect(out.refutedCount).toBe(0);
    expect(out.blocking).toBe(true);
    expect(out.peer.verdict).toBe('REQUEST_CHANGES');
  });

  it('keeps a finding whose refuter never reported', async () => {
    const failed: AgentMiningResult = {
      agentId: refuterId,
      agentTitle: 'Refuter',
      status: 'failed',
      output: null,
      rawOutput: null,
      errorMessage: 'timed out',
    };
    const out = await firstPass([mining('peer-reviewer', CRITICAL_PEER), failed]);
    expect(out.refutedCount).toBe(0);
    expect(out.blocking).toBe(true);
  });

  it('keeps the surviving findings blocking when only one of two is refuted', async () => {
    const twoFindings =
      '```json\n{"verdict":"REQUEST_CHANGES","findings":[{"severity":"critical","path":"a.ts","lines":"4","issue":"npe","fix":"guard"},{"severity":"high","path":"b.ts","issue":"race","fix":"lock"}],"positives":[]}\n```';
    const raceId = collectRefutable(
      { findings: [{ severity: 'high', path: 'b.ts', issue: 'race', fix: 'lock' }] },
      { findings: [] },
      [],
    )[0]!.agentId;
    const out = await firstPass([
      mining('peer-reviewer', twoFindings),
      mining(refuterId, '```json\n{"refuted":true,"evidence":"a.ts:4"}\n```'),
      mining(raceId, '```json\n{"refuted":false,"reason":"the race is real"}\n```'),
    ]);
    expect(out.refutedCount).toBe(1);
    expect(out.blocking).toBe(true);
    // verdict is NOT downgraded: a blocking finding survived
    expect(out.peer.verdict).toBe('REQUEST_CHANGES');
    const diagnosis = codeReviewStep.fixLoop!.evaluate(out)!.diagnosis;
    expect(diagnosis).toContain('race');
    expect(diagnosis).not.toContain('npe');
  });

  it('records the refuted finding as dismissed_refuted and non-blocking', async () => {
    // The durable row is the whole point of the pass: a dismissed finding must be
    // distinguishable later from one that never fired.
    let recorded: Record<string, unknown>[] = [];
    const ctx = {
      logger: logger.child({ test: '08c-record' }),
      taskId: 't1',
      taskStepId: 's1',
      round: 0,
      db: {
        insert: () => ({
          values: (rows: Record<string, unknown>[]) => {
            recorded = rows;
            return { onConflictDoNothing: async () => undefined };
          },
        }),
      },
    } as unknown as StepContext;
    await codeReviewStep.apply(ctx, {
      detected: { spec: 's', implementationFiles: [], debtBlock: '', level: 'none' },
      agentMiningResults: [
        mining('peer-reviewer', CRITICAL_PEER),
        mining(refuterId, '```json\n{"refuted":true,"evidence":"a.ts:4"}\n```'),
      ],
      isFinalMiningAttempt: true,
      miningWaveExhausted: false,
    } as unknown as Parameters<typeof codeReviewStep.apply>[1]);

    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.disposition).toBe('dismissed_refuted');
    expect(recorded[0]!.dispositionSource).toBe('refuter');
    expect(recorded[0]!.dispositionAt).toBeInstanceOf(Date);
    expect(recorded[0]!.blocking).toBe(false);
  });

  it('refutes a security finding and downgrades VULNERABLE to NEEDS_FIXES', async () => {
    const vulnerable =
      '```json\n{"verdict":"VULNERABLE","findings":[{"severity":"critical","path":"c.ts","line":9,"issue":"sqli","fix":"bind"}]}\n```';
    const sqliId = collectRefutable(
      { findings: [] },
      { findings: [{ severity: 'critical', path: 'c.ts', line: 9, issue: 'sqli', fix: 'bind' }] },
      [],
    )[0]!.agentId;
    const out = await firstPass([
      mining('peer-reviewer', '```json\n{"verdict":"APPROVE","findings":[],"positives":[]}\n```'),
      mining('security-code-reviewer', vulnerable),
      mining(
        sqliId,
        '```json\n{"refuted":true,"evidence":"c.ts:9 uses a prepared statement"}\n```',
      ),
    ]);
    expect(out.refutedCount).toBe(1);
    expect(out.security.verdict).toBe('NEEDS_FIXES');
    expect(out.blocking).toBe(false);
  });
});
