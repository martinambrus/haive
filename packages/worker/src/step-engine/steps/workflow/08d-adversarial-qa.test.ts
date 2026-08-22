import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { configService, logger, STEP_MINING_SEATS } from '@haive/shared';
import {
  parseAdversaryOutput,
  adversaryIdsForLevel,
  adversarialQaStep,
  hasObservation,
  verifyVerdict,
  verificationForFinding,
} from './08d-adversarial-qa.js';
import { MiningRetryError, MiningWaveError } from '../../step-definition.js';
import type { AgentMiningResult, StepContext } from '../../step-definition.js';

const fakeCtx = { logger: logger.child({ test: '08d-apply' }) } as unknown as StepContext;
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
/** An adversary DISPATCHED and killed before it finished — budget, orphan, preemption. */
function failedMining(agentId: string, errorMessage: string): AgentMiningResult {
  return {
    agentId,
    agentTitle: agentId,
    status: 'failed',
    output: null,
    rawOutput: null,
    errorMessage,
  };
}
const TIMEOUT_ERR = 'CLI process exceeded its time budget (45m).';

describe('adversaryIdsForLevel', () => {
  it('returns cumulative rosters of 2/4/6', () => {
    expect(adversaryIdsForLevel('poc')).toEqual(['edge-case-breaker', 'workflow-disruptor']);
    expect(adversaryIdsForLevel('standard')).toHaveLength(4);
    expect(adversaryIdsForLevel('enterprise')).toHaveLength(6);
    // cumulative: poc ⊂ standard ⊂ enterprise
    expect(adversaryIdsForLevel('standard').slice(0, 2)).toEqual(adversaryIdsForLevel('poc'));
    expect(adversaryIdsForLevel('enterprise').slice(0, 4)).toEqual(
      adversaryIdsForLevel('standard'),
    );
  });
});

describe('parseAdversaryOutput', () => {
  it('parses a fenced adversary report', () => {
    const raw =
      'attacked\n```json\n{"verdict":"FAIL","findings":[{"severity":"critical","category":"sqli","location":"q.php:5","poc":"1 OR 1=1","impact":"dump","fix":"param"}]}\n```';
    const f = parseAdversaryOutput(raw);
    expect(f).not.toBeNull();
    expect(f).toHaveLength(1);
    expect(f![0]!.severity).toBe('critical');
    expect(f![0]!.location).toBe('q.php:5');
  });

  it('accepts an already-parsed object and defaults findings', () => {
    expect(parseAdversaryOutput({ verdict: 'PASS' })).toEqual([]);
    expect(parseAdversaryOutput({ verdict: 'PASS', findings: [] })).toEqual([]);
  });

  it('parses its own report, not the payload it fenced as proof', () => {
    // An adversary's PoC is often itself JSON. Anchoring on the first fence parsed the
    // payload as the report, silently dropping a confirmed critical exploit.
    const raw = [
      'Payload used:',
      '```json',
      '{"input":"1 OR 1=1"}',
      '```',
      '```json',
      '{"verdict":"FAIL","findings":[{"severity":"critical","category":"sqli","location":"q.php:5","poc":"1 OR 1=1"}]}',
      '```',
    ].join('\n');
    const f = parseAdversaryOutput(raw);
    expect(f).toHaveLength(1);
    expect(f![0]!.severity).toBe('critical');
  });

  it('returns null on garbled output', () => {
    expect(parseAdversaryOutput('no json')).toBeNull();
    expect(parseAdversaryOutput(null)).toBeNull();
    // an object naming neither a verdict nor findings is not a report
    expect(parseAdversaryOutput('```json\n{"input":"1 OR 1=1"}\n```')).toBeNull();
  });
});

function runQa(results: AgentMiningResult[], isFinalMiningAttempt?: boolean) {
  return adversarialQaStep.apply(fakeCtx, {
    detected: { level: 'poc' },
    agentMiningResults: results,
    isFinalMiningAttempt,
  } as unknown as Parameters<typeof adversarialQaStep.apply>[1]);
}

describe('adversarialQaStep.apply de-silence', () => {
  it('surfaces a qa-gap finding (not silent 0-findings) once the re-roll budget is spent', async () => {
    const out = await runQa(
      [mining('edge-case-breaker', 'I tried hard to break it but did not emit any json')],
      true,
    );
    expect(out.ran).toBe(true);
    expect(out.findings.length).toBeGreaterThan(0);
    expect(out.findings.some((f) => f.category === 'qa-gap')).toBe(true);
  });

  it('re-rolls only the unreadable adversary while it still has budget', async () => {
    const err = await runQa(
      [
        mining('edge-case-breaker', 'prose, no json'),
        mining('workflow-disruptor', '```json\n{"verdict":"PASS","findings":[]}\n```'),
      ],
      false,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MiningRetryError);
    expect((err as MiningRetryError).agentIds).toEqual(['edge-case-breaker']);
  });

  it('does not throw when every adversary is readable', async () => {
    const out = await runQa(
      [mining('edge-case-breaker', '```json\n{"verdict":"PASS"}\n```')],
      false,
    );
    expect(out.ran).toBe(true);
    expect(out.findings).toEqual([]);
    expect(out.qaIncomplete).toBe(false);
  });

  it('surfaces an adversary killed at its budget as a qa-gap, not a clean surface', async () => {
    const out = await runQa([failedMining('edge-case-breaker', TIMEOUT_ERR)], true);
    expect(out.qaIncomplete).toBe(true);
    expect(out.findings.some((f) => f.category === 'qa-gap')).toBe(true);
    // the cause travels with the gap — a budget kill wants a longer timeout
    expect(out.findings.some((f) => (f.impact ?? '').includes('time budget'))).toBe(true);
    // the adversary died, the code did not fail: no fix round
    expect(out.blocking).toBe(false);
  });

  it('still reports ran:true when the whole roster died', async () => {
    // ran:false makes gate 2 skip its entire adversarial row, so a roster that was
    // dispatched and wiped out rendered as "QA never ran" — indistinguishable from a
    // task that opted out of QA altogether.
    const out = await runQa(
      [
        failedMining('edge-case-breaker', TIMEOUT_ERR),
        failedMining('workflow-disruptor', TIMEOUT_ERR),
      ],
      true,
    );
    expect(out.ran).toBe(true);
    expect(out.qaIncomplete).toBe(true);
    expect(out.level).toBe('poc');
  });

  it('reports ran:false only when no adversary was dispatched', async () => {
    const out = await runQa([], true);
    expect(out.ran).toBe(false);
    expect(out.qaIncomplete).toBe(false);
  });

  it('re-rolls a killed adversary while it still has budget', async () => {
    const err = await runQa(
      [
        failedMining('edge-case-breaker', TIMEOUT_ERR),
        mining('workflow-disruptor', '```json\n{"verdict":"PASS","findings":[]}\n```'),
      ],
      false,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MiningRetryError);
    expect((err as MiningRetryError).agentIds).toEqual(['edge-case-breaker']);
  });
});

describe('08d mining seats', () => {
  it('seats every adversary by its own id', async () => {
    // The roster is a fixed catalog, so each adversary's id is already the stable seat.
    const agents = await adversarialQaStep.agentMining!.selectAgents({
      detected: {
        level: 'enterprise',
        spec: 's',
        implementationFiles: [],
        appUrl: null,
      },
    } as never);
    expect(agents.length).toBeGreaterThan(0);
    for (const a of agents) expect(a.roleKey, a.agentId).toBe(a.agentId);
  });

  it('registers the widest roster plus the verifier lenses, and nothing else', async () => {
    // A seat the step emits but the registry omits is unconfigurable in the UI; one the
    // registry lists but nothing ever emits is a dead control. The registry covers TWO
    // waves: the adversaries selectAgents dispatches, and the PoC verifier lenses the
    // second wave dispatches per blocking finding (which selectAgents never returns).
    const agents = await adversarialQaStep.agentMining!.selectAgents({
      detected: {
        level: 'enterprise',
        spec: 's',
        implementationFiles: [],
        appUrl: null,
      },
    } as never);
    const registered = STEP_MINING_SEATS['08d-adversarial-qa']!.map((s) => s.id);
    const verifierSeats = registered.filter((id) => id.startsWith('qa-verify:'));
    expect(verifierSeats.sort()).toEqual([
      'qa-verify:execute',
      'qa-verify:linkage',
      'qa-verify:target',
    ]);
    expect([...agents.map((a) => a.roleKey!), ...verifierSeats].sort()).toEqual(
      [...registered].sort(),
    );
  });

  it('keeps a narrower level a strict subset of the registry', async () => {
    // poc/standard dispatch fewer adversaries; every one must still be a registered seat.
    const registered = new Set(STEP_MINING_SEATS['08d-adversarial-qa']!.map((s) => s.id));
    for (const level of ['poc', 'standard'] as const) {
      const agents = await adversarialQaStep.agentMining!.selectAgents({
        detected: { level, spec: 's', implementationFiles: [], appUrl: null },
      } as never);
      for (const a of agents) expect(registered.has(a.roleKey!), a.roleKey).toBe(true);
    }
  });
});

describe('adversarialQaStep.apply — pre-dedupe finding attribution', () => {
  // These fixtures are blocking by design (critical/high), which now dispatches the PoC
  // verifier wave and makes apply() throw instead of returning. This suite is about the
  // location merge, so pin verification off; its own suite covers the wave.
  beforeEach(() => {
    vi.spyOn(configService, 'getBoolean').mockResolvedValue(false);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** ctx with a capturing db + a logger that records info calls, so both the recorded rows
   *  and the drop-count log can be asserted. `runQa`'s fakeCtx has no db at all. */
  function captureCtx(): {
    ctx: StepContext;
    rows: Record<string, unknown>[];
    infos: Record<string, unknown>[];
  } {
    const rows: Record<string, unknown>[] = [];
    const infos: Record<string, unknown>[] = [];
    const ctx = {
      taskId: 'task-1',
      taskStepId: 'step-1',
      round: 0,
      logger: {
        warn: () => {},
        info: (obj: Record<string, unknown>) => {
          infos.push(obj);
        },
      },
      db: {
        insert: () => ({
          values: (values: Record<string, unknown>[]) => {
            rows.push(...values);
            return { onConflictDoNothing: () => Promise.resolve() };
          },
        }),
      },
    } as unknown as StepContext;
    return { ctx, rows, infos };
  }

  const reports = (
    agentId: string,
    invocationId: string,
    findings: Record<string, unknown>[],
  ): AgentMiningResult => ({
    agentId,
    agentTitle: agentId,
    invocationId,
    status: 'done',
    output: null,
    rawOutput: '```json\n' + JSON.stringify({ verdict: 'NEEDS_FIXES', findings }) + '\n```',
    errorMessage: null,
  });

  /** Two adversaries reporting the SAME location — exactly what the merge collapses. */
  const collidingBatch = () => [
    reports('auth-bandit', 'inv-auth', [
      { severity: 'critical', location: 'admin.php', impact: 'auth bypass', fix: 'gate it' },
    ]),
    reports('injection-infector', 'inv-inj', [
      { severity: 'high', location: 'admin.php', impact: 'sql injection', fix: 'parameterise' },
    ]),
  ];

  async function run(results: AgentMiningResult[]) {
    const { ctx, rows, infos } = captureCtx();
    const out = await adversarialQaStep.apply(ctx, {
      detected: { level: 'standard' },
      agentMiningResults: results,
      isFinalMiningAttempt: true,
    } as unknown as Parameters<typeof adversarialQaStep.apply>[1]);
    return { out, rows, infos };
  }

  it('still merges to one finding for the gate — behaviour is unchanged', async () => {
    const { out } = await run(collidingBatch());
    expect(out.findings).toHaveLength(1);
    // Keep-highest-severity: critical wins.
    expect(out.findings[0]!.severity).toBe('critical');
  });

  it('records BOTH reports, each attributed to its own adversary and invocation', async () => {
    // Before this, the loser vanished entirely — impact, PoC and fix included — and the
    // survivor was filed under the step id, so nothing could say who found what.
    const { rows } = await run(collidingBatch());
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => [r.reviewerId, r.cliInvocationId]).sort()).toEqual([
      ['auth-bandit', 'inv-auth'],
      ['injection-infector', 'inv-inj'],
    ]);
    // The dropped one keeps its own content rather than inheriting the winner's.
    expect(rows.map((r) => r.issue).sort()).toEqual(['auth bypass', 'sql injection']);
  });

  it('marks the merged-away report non-blocking and the survivor blocking', async () => {
    // `blocking` means "contributed to the step's blocking decision". A finding the merge
    // dropped contributed nothing, however severe it reads alone.
    const { rows } = await run(collidingBatch());
    const byReviewer = Object.fromEntries(rows.map((r) => [r.reviewerId, r.blocking]));
    expect(byReviewer['auth-bandit']).toBe(true);
    expect(byReviewer['injection-infector']).toBe(false);
  });

  it('logs how many reports the merge dropped', async () => {
    // The number that decides whether the location-only dedupe key is worth widening.
    // Nothing recorded it before, so the loss could never be quantified from a finished run.
    const { infos } = await run(collidingBatch());
    expect(infos.some((i) => i.dropped === 1 && i.reported === 2)).toBe(true);
  });

  it('does not log a drop when nothing collided', async () => {
    const { rows, infos } = await run([
      reports('auth-bandit', 'inv-auth', [
        { severity: 'high', location: 'a.php', impact: 'one', fix: 'x' },
      ]),
      reports('injection-infector', 'inv-inj', [
        { severity: 'high', location: 'b.php', impact: 'two', fix: 'y' },
      ]),
    ]);
    expect(rows).toHaveLength(2);
    expect(infos.some((i) => typeof i.dropped === 'number')).toBe(false);
  });
});

describe('08d PoC verification', () => {
  const observed =
    'Issued GET https://app.ddev.site/UserFiles/File/x.php and got 404 with an empty body';

  const verdictJson = (o: Record<string, unknown>) => '```json\n' + JSON.stringify(o) + '\n```';

  describe('hasObservation', () => {
    it('rejects a bare assertion with nothing observed', () => {
      // The sentence this whole bar exists to reject: free to write, and it would silently
      // downgrade a real defect.
      expect(hasObservation('Could not reproduce this.')).toBe(false);
      expect(hasObservation('')).toBe(false);
      expect(hasObservation(undefined)).toBe(false);
    });

    it('accepts prose that records a concrete artefact', () => {
      expect(hasObservation(observed)).toBe(true);
      expect(
        hasObservation('Ran `curl -s -o /dev/null -w %{http_code} /admin.php` — it printed 302'),
      ).toBe(true);
    });

    it('rejects a long sentence that names nothing concrete', () => {
      expect(
        hasObservation(
          'I looked at this carefully and in my judgement the reported behaviour does not occur here at all',
        ),
      ).toBe(false);
    });
  });

  describe('verifyVerdict', () => {
    it('reads a reproduction without needing an observation', () => {
      // A verifier claiming it DID reproduce is not the direction that loses findings.
      expect(verifyVerdict(verdictJson({ reproduced: true }))).toBe('reproduced');
    });

    it('reads a non-reproduction only when something was observed', () => {
      expect(verifyVerdict(verdictJson({ reproduced: false, observation: observed }))).toBe(
        'not_reproduced',
      );
    });

    it('discards a non-reproduction with no observation', () => {
      expect(verifyVerdict(verdictJson({ reproduced: false }))).toBeNull();
      expect(verifyVerdict(verdictJson({ reproduced: false, observation: 'nope' }))).toBeNull();
    });

    it('is null on unparseable output', () => {
      expect(verifyVerdict('I ran it and it seemed fine')).toBeNull();
      expect(verifyVerdict(null)).toBeNull();
    });
  });

  describe('verificationForFinding', () => {
    const LENSES = [
      { id: 'execute', title: 'executes', lines: [] },
      { id: 'target', title: 'target real', lines: [] },
      { id: 'linkage', title: 'code linkage', lines: [] },
    ] as never[];
    const fp = 'abcdef0123456789';
    const voter = (lensId: string, raw: string | null): AgentMiningResult => ({
      agentId: `qaverify-${fp}-${lensId}`,
      agentTitle: lensId,
      invocationId: `inv-${lensId}`,
      status: raw === null ? 'failed' : 'done',
      output: null,
      rawOutput: raw,
      errorMessage: raw === null ? 'killed' : null,
    });
    const allSay = (o: Record<string, unknown>) =>
      ['execute', 'target', 'linkage'].map((l) => voter(l, verdictJson(o)));

    it('downgrades only when every lens fails to reproduce WITH an observation', () => {
      expect(
        verificationForFinding(allSay({ reproduced: false, observation: observed }), fp, LENSES),
      ).toBe('not_reproduced');
    });

    it('keeps the finding when any single lens reproduces it', () => {
      // One successful reproduction is a demonstration; the others failing to repeat it
      // does not undo it.
      const mixed = [
        voter('execute', verdictJson({ reproduced: true })),
        voter('target', verdictJson({ reproduced: false, observation: observed })),
        voter('linkage', verdictJson({ reproduced: false, observation: observed })),
      ];
      expect(verificationForFinding(mixed, fp, LENSES)).toBe('reproduced');
    });

    it('keeps the finding when one voter asserts without observing (fail-closed)', () => {
      const mixed = [
        voter('execute', verdictJson({ reproduced: false, observation: observed })),
        voter('target', verdictJson({ reproduced: false })),
        voter('linkage', verdictJson({ reproduced: false, observation: observed })),
      ];
      expect(verificationForFinding(mixed, fp, LENSES)).toBe('unverified');
    });

    it('keeps the finding when a voter was killed before answering', () => {
      const mixed = [
        voter('execute', verdictJson({ reproduced: false, observation: observed })),
        voter('target', null),
        voter('linkage', verdictJson({ reproduced: false, observation: observed })),
      ];
      expect(verificationForFinding(mixed, fp, LENSES)).toBe('unverified');
    });

    it('is unverified when the panel never ran at all', () => {
      expect(verificationForFinding([], fp, LENSES)).toBe('unverified');
    });
  });
});

describe('08d verifier wave dispatch and downgrade', () => {
  const fakeCtx2 = {
    logger: { info: () => {}, warn: () => {}, debug: () => {} },
    db: { insert: () => ({ values: () => ({ onConflictDoNothing: () => Promise.resolve() }) }) },
    taskId: 't',
    taskStepId: 's',
    round: 0,
  } as unknown as StepContext;

  const adversary = (agentId: string, findings: Record<string, unknown>[]): AgentMiningResult => ({
    agentId,
    agentTitle: agentId,
    invocationId: `inv-${agentId}`,
    status: 'done',
    output: null,
    rawOutput: '```json\n' + JSON.stringify({ verdict: 'NEEDS_FIXES', findings }) + '\n```',
    errorMessage: null,
  });

  const BLOCKER = { severity: 'critical', location: 'admin.php:10', impact: 'rce', poc: 'GET /x' };
  const MINOR = { severity: 'low', location: 'a.php:1', impact: 'info leak', poc: 'GET /a' };

  const run = (results: AgentMiningResult[]) =>
    adversarialQaStep.apply(fakeCtx2, {
      detected: { level: 'poc', spec: 's', implementationFiles: [], appUrl: 'https://x.ddev.site' },
      agentMiningResults: results,
      isFinalMiningAttempt: true,
    } as unknown as Parameters<typeof adversarialQaStep.apply>[1]);

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function enableVerification(lenses = 3) {
    vi.spyOn(configService, 'getBoolean').mockResolvedValue(true);
    vi.spyOn(configService, 'getNumber').mockResolvedValue(lenses);
  }

  it('dispatches one verifier per lens for a blocking finding', async () => {
    enableVerification();
    const err = await run([adversary('auth-bandit', [BLOCKER])]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MiningWaveError);
    const dispatches = (err as MiningWaveError).dispatches;
    expect(dispatches).toHaveLength(3);
    expect(dispatches.map((d) => d.roleKey).sort()).toEqual([
      'qa-verify:execute',
      'qa-verify:linkage',
      'qa-verify:target',
    ]);
    // The PoC being checked reaches the verifier — without it there is nothing to run.
    for (const d of dispatches) expect(d.prompt).toContain('GET /x');
  });

  it('never dispatches a verifier for a non-blocking finding', async () => {
    // Only blocking findings cost a fix round, so only those are worth the invocations.
    enableVerification();
    const out = await run([adversary('auth-bandit', [MINOR])]);
    expect(out.findings).toHaveLength(1);
    expect(out.blocking).toBe(false);
  });

  it('throws no wave when verification is disabled', async () => {
    vi.spyOn(configService, 'getBoolean').mockResolvedValue(false);
    const out = await run([adversary('auth-bandit', [BLOCKER])]);
    expect(out.blocking).toBe(true);
    expect(out.findings[0]!.verification).toBeUndefined();
  });

  it('downgrades a finding no lens could reproduce, but keeps it visible', async () => {
    enableVerification();
    const first = await run([adversary('auth-bandit', [BLOCKER])]).catch((e: unknown) => e);
    const dispatches = (err0(first) as MiningWaveError).dispatches;
    const observed =
      'Issued GET https://x.ddev.site/x and got 404 with an empty body; no shell was reached';
    const verifiers: AgentMiningResult[] = dispatches.map((d) => ({
      agentId: d.agentId,
      agentTitle: d.agentTitle,
      invocationId: 'inv-v',
      status: 'done',
      output: null,
      rawOutput:
        '```json\n' + JSON.stringify({ reproduced: false, observation: observed }) + '\n```',
      errorMessage: null,
    }));
    const out = await run([adversary('auth-bandit', [BLOCKER]), ...verifiers]);
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0]!.verification).toBe('not_reproduced');
    // Downgraded, NOT dismissed: it stops blocking and still reaches gate 1.5.
    expect(out.blocking).toBe(false);
    expect(out.counts.total).toBe(1);
  });

  it('keeps a finding blocking when one lens reproduces it', async () => {
    enableVerification();
    const first = await run([adversary('auth-bandit', [BLOCKER])]).catch((e: unknown) => e);
    const dispatches = (err0(first) as MiningWaveError).dispatches;
    const verifiers: AgentMiningResult[] = dispatches.map((d, i) => ({
      agentId: d.agentId,
      agentTitle: d.agentTitle,
      invocationId: 'inv-v',
      status: 'done',
      output: null,
      rawOutput:
        '```json\n' +
        JSON.stringify(
          i === 0
            ? {
                reproduced: true,
                observation: 'GET https://x.ddev.site/x returned 200 with output',
              }
            : {
                reproduced: false,
                observation: 'GET https://x.ddev.site/x returned 404 with an empty body here',
              },
        ) +
        '\n```',
      errorMessage: null,
    }));
    const out = await run([adversary('auth-bandit', [BLOCKER]), ...verifiers]);
    expect(out.findings[0]!.verification).toBe('reproduced');
    expect(out.blocking).toBe(true);
  });

  it('does not read verifier output as an adversary that emitted garbage', async () => {
    // The second pass carries both waves. Parsing verifier JSON as adversary output would
    // invent a qa-gap finding per verifier — holes in the attack surface conjured from the
    // wave that was checking it.
    enableVerification();
    const first = await run([adversary('auth-bandit', [BLOCKER])]).catch((e: unknown) => e);
    const dispatches = (err0(first) as MiningWaveError).dispatches;
    const verifiers: AgentMiningResult[] = dispatches.map((d) => ({
      agentId: d.agentId,
      agentTitle: d.agentTitle,
      invocationId: 'inv-v',
      status: 'done',
      output: null,
      rawOutput: '```json\n{"reproduced":true}\n```',
      errorMessage: null,
    }));
    const out = await run([adversary('auth-bandit', [BLOCKER]), ...verifiers]);
    expect(out.findings.some((f) => f.category === 'qa-gap')).toBe(false);
    expect(out.qaIncomplete).toBe(false);
  });
});

/** Narrow a caught value to the error it must be, so the wave tests read as assertions
 *  about dispatches rather than about try/catch plumbing. */
function err0(e: unknown): unknown {
  expect(e).toBeInstanceOf(MiningWaveError);
  return e;
}
