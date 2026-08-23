import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { configService, logger, STEP_MINING_SEATS } from '@haive/shared';
import {
  parseAdversaryOutput,
  adversaryIdsForLevel,
  adversarialQaStep,
  hasObservation,
  isRuntimeOnlyFinding,
  verifyVerdicts,
  verifierAgentId,
  retryableVerifiers,
  rootCauseKey,
  verificationForFinding,
  verificationTiers,
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
  /** A one-finding report, the shape every single-finding group produces. */
  const list = (v: Record<string, unknown>) => ({ verdicts: [{ finding: 1, ...v }] });
  const one = (raw: string) => verifyVerdicts(raw).get(1);

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

  describe('verifyVerdicts', () => {
    it('reads a reproduction without needing an observation', () => {
      // A verifier claiming it DID reproduce is not the direction that loses findings.
      expect(one(verdictJson(list({ reproduced: true })))).toBe('reproduced');
    });

    it('reads a non-reproduction only when something was observed', () => {
      expect(one(verdictJson(list({ reproduced: false, observation: observed })))).toBe(
        'not_reproduced',
      );
    });

    it('discards a non-reproduction with no observation', () => {
      expect(one(verdictJson(list({ reproduced: false })))).toBeUndefined();
      expect(one(verdictJson(list({ reproduced: false, observation: 'nope' })))).toBeUndefined();
    });

    it('reads could_not_test without needing an observation', () => {
      // There is nothing to quote when nothing was reachable, so the evidence floor that
      // guards a non-reproduction would only push the verifier back onto `false`.
      expect(one(verdictJson(list({ reproduced: 'could_not_test' })))).toBe('could_not_test');
    });

    it('keeps could_not_test distinct from a non-reproduction', () => {
      // The whole point: an environmental failure must not read as a vote against the
      // finding. This is the live prose that used to be scored as one.
      const unreachable =
        'No network route from this sandbox — curl https://x.ddev.site/AGENTS.md could not ' +
        'resolve the host, and the published ports were unreachable from the container gateway.';
      expect(
        one(verdictJson(list({ reproduced: 'could_not_test', observation: unreachable }))),
      ).toBe('could_not_test');
    });

    it('is empty on unparseable output', () => {
      expect(verifyVerdicts('I ran it and it seemed fine').size).toBe(0);
      expect(verifyVerdicts(null).size).toBe(0);
    });

    it('keys each verdict by the position the prompt numbered it at', () => {
      const m = verifyVerdicts(
        verdictJson({
          verdicts: [
            { finding: 1, reproduced: true },
            { finding: 2, reproduced: false, observation: observed },
            { finding: 3, reproduced: 'could_not_test' },
          ],
        }),
      );
      expect(m.get(1)).toBe('reproduced');
      expect(m.get(2)).toBe('not_reproduced');
      expect(m.get(3)).toBe('could_not_test');
    });

    it('leaves a position the verifier never answered for absent', () => {
      // The fail-closed path grouping introduces: a short report must not shift the
      // remaining verdicts onto the findings that follow.
      const m = verifyVerdicts(verdictJson({ verdicts: [{ finding: 1, reproduced: true }] }));
      expect(m.has(2)).toBe(false);
    });

    it('keeps the first verdict when one position is answered twice', () => {
      // A verifier contradicting itself must not have its later answer overwrite a
      // reproduction.
      const m = verifyVerdicts(
        verdictJson({
          verdicts: [
            { finding: 1, reproduced: true },
            { finding: 1, reproduced: false, observation: observed },
          ],
        }),
      );
      expect(m.get(1)).toBe('reproduced');
    });
  });

  describe('verificationForFinding', () => {
    const LENSES = [
      { id: 'execute', title: 'executes', lines: [] },
      { id: 'target', title: 'target real', lines: [] },
      { id: 'linkage', title: 'code linkage', lines: [] },
    ] as never[];
    const KEY = 'file:installer/contents_step_7.php';
    const voter = (lensId: string, raw: string | null): AgentMiningResult => ({
      agentId: verifierAgentId(KEY, { id: lensId } as never),
      agentTitle: lensId,
      invocationId: `inv-${lensId}`,
      status: raw === null ? 'failed' : 'done',
      output: null,
      rawOutput: raw,
      errorMessage: raw === null ? 'killed' : null,
    });
    const allSay = (o: Record<string, unknown>) =>
      ['execute', 'target', 'linkage'].map((l) => voter(l, verdictJson(list(o))));

    it('downgrades only when every lens fails to reproduce WITH an observation', () => {
      expect(
        verificationForFinding(
          allSay({ reproduced: false, observation: observed }),
          KEY,
          0,
          LENSES,
        ),
      ).toBe('not_reproduced');
    });

    it('keeps the finding when any single lens reproduces it', () => {
      // One successful reproduction is a demonstration; the others failing to repeat it
      // does not undo it.
      const mixed = [
        voter('execute', verdictJson(list({ reproduced: true }))),
        voter('target', verdictJson(list({ reproduced: false, observation: observed }))),
        voter('linkage', verdictJson(list({ reproduced: false, observation: observed }))),
      ];
      expect(verificationForFinding(mixed, KEY, 0, LENSES)).toBe('reproduced');
    });

    it('keeps the finding when one voter asserts without observing (fail-closed)', () => {
      const mixed = [
        voter('execute', verdictJson(list({ reproduced: false, observation: observed }))),
        voter('target', verdictJson(list({ reproduced: false }))),
        voter('linkage', verdictJson(list({ reproduced: false, observation: observed }))),
      ];
      expect(verificationForFinding(mixed, KEY, 0, LENSES)).toBe('unverified');
    });

    it('keeps the finding when a voter was killed before answering', () => {
      const mixed = [
        voter('execute', verdictJson(list({ reproduced: false, observation: observed }))),
        voter('target', null),
        voter('linkage', verdictJson(list({ reproduced: false, observation: observed }))),
      ];
      expect(verificationForFinding(mixed, KEY, 0, LENSES)).toBe('unverified');
    });

    it('reports untestable when no lens could reach the app', () => {
      // The failure that motivated the third verdict: every lens shares one broken network,
      // so their failures are perfectly correlated and the unanimity rule cannot protect
      // against them. Scored as a downgrade this silently dropped real defects.
      expect(verificationForFinding(allSay({ reproduced: 'could_not_test' }), KEY, 0, LENSES)).toBe(
        'untestable',
      );
    });

    it('does not downgrade a panel that is split between untested and not-reproduced', () => {
      // One lens that actually ran the PoC and found nothing is a single voter, and a
      // downgrade needs the whole panel.
      const mixed = [
        voter('execute', verdictJson(list({ reproduced: 'could_not_test' }))),
        voter('target', verdictJson(list({ reproduced: false, observation: observed }))),
        voter('linkage', verdictJson(list({ reproduced: 'could_not_test' }))),
      ];
      expect(verificationForFinding(mixed, KEY, 0, LENSES)).toBe('unverified');
    });

    it('still reproduces when one lens ran the PoC and the rest could not test', () => {
      const mixed = [
        voter('execute', verdictJson(list({ reproduced: true }))),
        voter('target', verdictJson(list({ reproduced: 'could_not_test' }))),
        voter('linkage', verdictJson(list({ reproduced: 'could_not_test' }))),
      ];
      expect(verificationForFinding(mixed, KEY, 0, LENSES)).toBe('reproduced');
    });

    it('is unverified when the panel never ran at all', () => {
      expect(verificationForFinding([], KEY, 0, LENSES)).toBe('unverified');
    });

    it('scores each member of a group against its own verdict', () => {
      // One panel, several findings: the verdicts must not bleed between them.
      const panel = ['execute', 'target', 'linkage'].map((l) =>
        voter(
          l,
          verdictJson({
            verdicts: [
              { finding: 1, reproduced: false, observation: observed },
              { finding: 2, reproduced: true },
            ],
          }),
        ),
      );
      expect(verificationForFinding(panel, KEY, 0, LENSES)).toBe('not_reproduced');
      expect(verificationForFinding(panel, KEY, 1, LENSES)).toBe('reproduced');
    });

    it('leaves a finding the panel never answered for blocking', () => {
      // THE way grouping could silently lose a finding: a short list. Asserted rather than
      // assumed from the shape of the code.
      const panel = ['execute', 'target', 'linkage'].map((l) =>
        voter(
          l,
          verdictJson({ verdicts: [{ finding: 1, reproduced: false, observation: observed }] }),
        ),
      );
      expect(verificationForFinding(panel, KEY, 0, LENSES)).toBe('not_reproduced');
      expect(verificationForFinding(panel, KEY, 1, LENSES)).toBe('unverified');
    });

    it('ignores a verdict numbered outside the group rather than misapplying it', () => {
      const panel = ['execute', 'target', 'linkage'].map((l) =>
        voter(
          l,
          verdictJson({ verdicts: [{ finding: 9, reproduced: false, observation: observed }] }),
        ),
      );
      expect(verificationForFinding(panel, KEY, 0, LENSES)).toBe('unverified');
    });
  });

  describe('verifier retries', () => {
    const LENSES = [{ id: 'execute', title: 'executes', lines: [] }] as never[];
    const GROUP = { key: 'file:a.php', findings: [{ severity: 'high' } as never] };
    const at = (attempt: number, status: 'done' | 'failed', raw: string | null, err?: string) =>
      ({
        agentId: verifierAgentId(GROUP.key, LENSES[0]!, attempt),
        agentTitle: 'v',
        invocationId: `inv-${attempt}`,
        status,
        output: null,
        rawOutput: raw,
        errorMessage: err ?? null,
      }) as AgentMiningResult;
    const DROPPED =
      'LLM run reported a failure (terminal_reason "api_error"): API Error: Connection lost mid-response.';

    it('gives attempt 0 the same id it had before retries existed', () => {
      // Nothing in flight may change shape when this ships.
      expect(verifierAgentId(GROUP.key, LENSES[0]!, 0)).toBe(
        verifierAgentId(GROUP.key, LENSES[0]!),
      );
    });

    it('re-runs a verifier the provider dropped', () => {
      const out = retryableVerifiers([at(0, 'failed', null, DROPPED)], [GROUP], LENSES);
      expect(out).toHaveLength(1);
      expect(out[0]!.attempt).toBe(1);
    });

    it('does not re-run one that died on a rate limit', () => {
      const fatal = 'Provider rate limit or quota exhausted — usage limit exhausted. (429)';
      expect(retryableVerifiers([at(0, 'failed', null, fatal)], [GROUP], LENSES)).toHaveLength(0);
    });

    it('does not re-run a verifier that answered', () => {
      const ok =
        '```json\n' + JSON.stringify({ verdicts: [{ finding: 1, reproduced: true }] }) + '\n```';
      expect(retryableVerifiers([at(0, 'done', ok)], [GROUP], LENSES)).toHaveLength(0);
    });

    it('does not re-run a group the dispatch skipped entirely', () => {
      // No row at all is an untestable group, not a failure.
      expect(retryableVerifiers([], [GROUP], LENSES)).toHaveLength(0);
    });

    it('stops after the attempt cap rather than retrying forever', () => {
      const dead = [
        at(0, 'failed', null, DROPPED),
        at(1, 'failed', null, DROPPED),
        at(2, 'failed', null, DROPPED),
      ];
      expect(retryableVerifiers(dead, [GROUP], LENSES)).toHaveLength(0);
      // …and one attempt short of the cap still retries.
      expect(retryableVerifiers(dead.slice(0, 2), [GROUP], LENSES)).toHaveLength(1);
    });

    it('reads the verdict a retry produced after the first attempt died', () => {
      const ok =
        '```json\n' + JSON.stringify({ verdicts: [{ finding: 1, reproduced: true }] }) + '\n```';
      const results = [at(0, 'failed', null, DROPPED), at(1, 'done', ok)];
      expect(verificationForFinding(results, GROUP.key, 0, LENSES)).toBe('reproduced');
    });

    it('stays unverified when every attempt died', () => {
      const results = [at(0, 'failed', null, DROPPED), at(1, 'failed', null, DROPPED)];
      expect(verificationForFinding(results, GROUP.key, 0, LENSES)).toBe('unverified');
    });
  });

  describe('rootCauseKey', () => {
    const at = (location: string) => ({ location, severity: 'high', impact: 'i' }) as never;

    it('groups the messy real locations that name one file', () => {
      // Verbatim from the round that motivated this: adversaries write prose into
      // `location`, so the raw strings never match each other.
      const keys = [
        'installer/contents_step_7.php:121 and installer/actions_step_7.php',
        'installer/contents_step_7.php:75-76',
        'installer/contents_step_7.php',
      ].map((l) => rootCauseKey(at(l)));
      expect(new Set(keys).size).toBe(1);
      expect(keys[0]).toBe('file:installer/contents_step_7.php');
    });

    it('keeps two different files apart', () => {
      expect(rootCauseKey(at('installer/actions_step_4.php:22'))).not.toBe(
        rootCauseKey(at('installer/contents_step_7.php:121')),
      );
    });

    it('matches a dotfile, which has no word character before the dot', () => {
      expect(rootCauseKey(at('.htaccess:16 vs installer/contents_step_2.php'))).toBe(
        'file:.htaccess',
      );
    });

    it('keeps a dot-directory apart from a dotfile', () => {
      // MEASURED on the first live run: the bare `.ddev` read as a dotfile and put three
      // unrelated files under one panel.
      expect(rootCauseKey(at('.ddev/apache/rs-hardening.conf'))).toBe(
        'file:.ddev/apache/rs-hardening.conf',
      );
      expect(rootCauseKey(at('.ddev/php/rs.ini:6-8 + .htaccess'))).not.toBe(
        rootCauseKey(at('.ddev/php/dev-prepend.php')),
      );
      // and the real dotfiles still group as themselves
      expect(rootCauseKey(at('.htaccess:19 and UserFiles/.htaccess'))).toBe('file:.htaccess');
      expect(rootCauseKey(at('.gitignore (missing entry)'))).toBe('file:.gitignore');
    });

    it('keys a URL on origin and path so a query string does not fragment it', () => {
      expect(rootCauseKey(at('https://app.ddev.site/phpstatus?full'))).toBe(
        rootCauseKey(at('https://app.ddev.site/phpstatus?x=1')),
      );
    });

    it('does not mistake a URL host for a file', () => {
      // The reason the token scan does not simply run over everything: two unrelated
      // endpoints would collapse onto `ddev.site`.
      expect(rootCauseKey(at('https://app.ddev.site/admin.php'))).not.toBe(
        rootCauseKey(at('https://app.ddev.site/install.php')),
      );
    });

    it('takes a double extension whole rather than stopping at the first dot', () => {
      // Otherwise `a.test.ts` reads as `a.test` and shares a panel with `a.test.js`.
      expect(rootCauseKey(at('src/a.test.ts:10'))).toBe('file:src/a.test.ts');
      expect(rootCauseKey(at('src/a.test.ts:10'))).not.toBe(rootCauseKey(at('src/a.test.js:2')));
    });

    it('falls back to a group of one when nothing is recognisable', () => {
      // Fragmenting costs invocations; over-grouping costs attention inside one prompt.
      const a = rootCauseKey(at('somewhere in the upload handling'));
      const b = rootCauseKey({ location: undefined, severity: 'high', impact: 'j' } as never);
      expect(a).toMatch(/^fp:/);
      expect(a).not.toBe(b);
    });
  });
});

describe('isRuntimeOnlyFinding', () => {
  it('is true only for a finding that points at a live URL', () => {
    expect(isRuntimeOnlyFinding({ location: 'https://x.ddev.site/admin' })).toBe(true);
    expect(isRuntimeOnlyFinding({ location: 'http://x.ddev.site/admin' })).toBe(true);
  });

  it('is false for a source location, including one that looks URL-ish', () => {
    // `new URL('admin.php:10')` parses — protocol `admin.php:` — so the check has to gate on
    // the scheme being http(s), not on the parse succeeding.
    expect(isRuntimeOnlyFinding({ location: 'admin.php:10' })).toBe(false);
    expect(isRuntimeOnlyFinding({ location: 'src/a/b.ts:42' })).toBe(false);
    expect(isRuntimeOnlyFinding({ location: undefined })).toBe(false);
    expect(isRuntimeOnlyFinding({ location: '  ' })).toBe(false);
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
  /** Verbatim from the round that motivated the retry: the binary's own stamp plus its prose. */
  const DROPPED =
    'LLM run reported a failure (terminal_reason "api_error"): API Error: Connection lost mid-response.';
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

  it('sends one panel for two findings sharing a root cause, and scores each separately', async () => {
    // End to end for the grouping: 6 findings on one installer file used to buy 18
    // invocations that all rediscovered the same closed window. One panel now answers for
    // both, and the two verdicts must not bleed into each other.
    enableVerification();
    const A = { severity: 'critical', location: 'admin.php:10', impact: 'rce', poc: 'GET /x' };
    const B = { severity: 'high', location: 'admin.php:88', impact: 'sqli', poc: 'GET /y' };
    const first = await run([adversary('auth-bandit', [A, B])]).catch((e: unknown) => e);
    const dispatches = (err0(first) as MiningWaveError).dispatches;
    expect(dispatches).toHaveLength(3);
    for (const d of dispatches) {
      expect(d.prompt).toContain('--- Finding 1 of 2 ---');
      expect(d.prompt).toContain('--- Finding 2 of 2 ---');
    }
    const observed =
      'Issued GET https://x.ddev.site/y and got 404 with an empty body; no query ran';
    const verifiers: AgentMiningResult[] = dispatches.map((d) => ({
      agentId: d.agentId,
      agentTitle: d.agentTitle,
      invocationId: 'inv-v',
      status: 'done',
      output: null,
      rawOutput:
        '```json\n' +
        JSON.stringify({
          verdicts: [
            { finding: 1, reproduced: true },
            { finding: 2, reproduced: false, observation: observed },
          ],
        }) +
        '\n```',
      errorMessage: null,
    }));
    const out = await run([adversary('auth-bandit', [A, B]), ...verifiers]);
    const byImpact = new Map(out.findings.map((f) => [f.impact, f.verification]));
    expect(byImpact.get('rce')).toBe('reproduced');
    expect(byImpact.get('sqli')).toBe('not_reproduced');
    expect(out.blocking).toBe(true);
  });

  it('re-dispatches a verifier the provider dropped, under a fresh attempt id', async () => {
    // The wiring a unit test on retryableVerifiers cannot reach: apply() must actually throw a
    // THIRD wave, and the id must be fresh — dispatchMiningAgents dispatches nothing for an
    // agent that already has a row, so re-throwing the old id would silently exhaust the wave
    // instead of retrying it.
    enableVerification();
    const first = await run([adversary('auth-bandit', [BLOCKER])]).catch((e: unknown) => e);
    const dispatches = (err0(first) as MiningWaveError).dispatches;
    const dead: AgentMiningResult[] = dispatches.map((d) => ({
      agentId: d.agentId,
      agentTitle: d.agentTitle,
      invocationId: 'inv-v',
      status: 'failed',
      output: null,
      rawOutput: null,
      errorMessage: DROPPED,
    }));
    const second = await run([adversary('auth-bandit', [BLOCKER]), ...dead]).catch(
      (e: unknown) => e,
    );
    const retries = (err0(second) as MiningWaveError).dispatches;
    expect(retries).toHaveLength(3);
    for (const d of retries) expect(d.agentId).toMatch(/-r1$/);
    // Not one of the ids that already has a row.
    expect(
      retries.map((d) => d.agentId).some((id) => dispatches.some((o) => o.agentId === id)),
    ).toBe(false);
  });

  it('does not retry a verifier that died on a rate limit', async () => {
    // Same shape, fatal cause: a retry spends a run against a window that has not moved.
    enableVerification();
    const first = await run([adversary('auth-bandit', [BLOCKER])]).catch((e: unknown) => e);
    const dispatches = (err0(first) as MiningWaveError).dispatches;
    const dead: AgentMiningResult[] = dispatches.map((d) => ({
      agentId: d.agentId,
      agentTitle: d.agentTitle,
      invocationId: 'inv-v',
      status: 'failed',
      output: null,
      rawOutput: null,
      errorMessage: 'Provider rate limit or quota exhausted — usage limit exhausted. (429)',
    }));
    const out = await run([adversary('auth-bandit', [BLOCKER]), ...dead]);
    expect(out.findings[0]!.verification).toBe('unverified');
    expect(out.blocking).toBe(true);
  });

  it('stops asking once the runner says the wave is exhausted', async () => {
    // The loop guard. Without it a retry wave that dispatched nothing would come straight back
    // here and be re-thrown forever. Doubt still keeps the finding.
    enableVerification();
    const first = await run([adversary('auth-bandit', [BLOCKER])]).catch((e: unknown) => e);
    const dispatches = (err0(first) as MiningWaveError).dispatches;
    const dead: AgentMiningResult[] = dispatches.map((d) => ({
      agentId: d.agentId,
      agentTitle: d.agentTitle,
      invocationId: 'inv-v',
      status: 'failed',
      output: null,
      rawOutput: null,
      errorMessage: DROPPED,
    }));
    const out = await adversarialQaStep.apply(fakeCtx2, {
      detected: { level: 'poc', spec: 's', implementationFiles: [], appUrl: 'https://x.ddev.site' },
      agentMiningResults: [adversary('auth-bandit', [BLOCKER]), ...dead],
      isFinalMiningAttempt: true,
      miningWaveExhausted: true,
    } as unknown as Parameters<typeof adversarialQaStep.apply>[1]);
    expect(out.findings[0]!.verification).toBe('unverified');
    expect(out.blocking).toBe(true);
  });

  it('dispatches ONE verifier for a non-blocking finding, not a panel', async () => {
    // Changed deliberately: verifying blocking findings only meant a round of 26 findings,
    // none blocking, was verified not at all and triaged entirely by hand. The panel size
    // still differs, because what a wrong verdict costs still differs.
    enableVerification();
    const err = await run([adversary('auth-bandit', [MINOR])]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MiningWaveError);
    const dispatches = (err as MiningWaveError).dispatches;
    expect(dispatches).toHaveLength(1);
    expect(dispatches[0]!.roleKey).toBe('qa-verify');
  });

  it('dispatches nothing when no finding has a proof to run', async () => {
    // A roster that produced only qa-gap entries has nothing executable; the step must not
    // park on a fan-out with no agents in it.
    enableVerification();
    const out = await run([adversary('auth-bandit', [{ severity: 'low', impact: 'no poc here' }])]);
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
        '```json\n' +
        JSON.stringify({ verdicts: [{ finding: 1, reproduced: false, observation: observed }] }) +
        '\n```',
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
        JSON.stringify({
          verdicts: [
            i === 0
              ? {
                  finding: 1,
                  reproduced: true,
                  observation: 'GET https://x.ddev.site/x returned 200 with output',
                }
              : {
                  finding: 1,
                  reproduced: false,
                  observation: 'GET https://x.ddev.site/x returned 404 with an empty body here',
                },
          ],
        }) +
        '\n```',
      errorMessage: null,
    }));
    const out = await run([adversary('auth-bandit', [BLOCKER]), ...verifiers]);
    expect(out.findings[0]!.verification).toBe('reproduced');
    expect(out.blocking).toBe(true);
  });

  it('keeps a finding blocking when no lens could test it', async () => {
    // End to end for the regression: an unreachable app must leave the finding at gate 1.5
    // as a blocker, not as the advisory a false-scored panel used to produce.
    enableVerification();
    const first = await run([adversary('auth-bandit', [BLOCKER])]).catch((e: unknown) => e);
    const dispatches = (err0(first) as MiningWaveError).dispatches;
    const verifiers: AgentMiningResult[] = dispatches.map((d) => ({
      agentId: d.agentId,
      agentTitle: d.agentTitle,
      invocationId: 'inv-v',
      status: 'done',
      output: null,
      rawOutput:
        '```json\n' +
        JSON.stringify({
          verdicts: [
            {
              finding: 1,
              reproduced: 'could_not_test',
              observation:
                'curl https://x.ddev.site/x could not resolve the host from this sandbox',
            },
          ],
        }) +
        '\n```',
      errorMessage: null,
    }));
    const out = await run([adversary('auth-bandit', [BLOCKER]), ...verifiers]);
    expect(out.findings[0]!.verification).toBe('untestable');
    expect(out.blocking).toBe(true);
  });

  it('marks a URL-located blocker untestable, without dispatching a panel, when no app runs', async () => {
    // The fake ctx has no repository, so app reach resolves to 'none'. Three invocations to
    // hear could_not_test three times is waste, and an empty wave would park the step on a
    // fan-out with no agents in it.
    enableVerification();
    const RUNTIME_BLOCKER = {
      severity: 'critical',
      location: 'https://x.ddev.site/admin',
      impact: 'auth bypass',
      poc: 'GET /admin returns 200 logged out',
    };
    const out = await run([adversary('auth-bandit', [RUNTIME_BLOCKER])]);
    expect(out.findings[0]!.verification).toBe('untestable');
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

describe('08d verification tiers', () => {
  const LENSES = [
    { id: 'execute', title: 'executes', lines: [] },
    { id: 'target', title: 'target real', lines: [] },
    { id: 'linkage', title: 'code linkage', lines: [] },
  ] as never[];
  let n = 0;
  /** Each finding lands in its own root-cause group unless `location` says otherwise. */
  const f = (severity: string, over: Record<string, unknown> = {}) =>
    ({ severity, location: `src/f${n++}.php`, impact: 'i', poc: 'GET /x', ...over }) as never;

  it('gives blocking causes the full panel and everything else one verifier', () => {
    // The cost of being wrong differs by an order of magnitude, so the panel does too.
    const [blocking, advisory] = verificationTiers(
      [f('critical'), f('high'), f('medium'), f('low')],
      LENSES,
    );
    expect(blocking!.groups).toHaveLength(2);
    expect(blocking!.lenses).toHaveLength(3);
    expect(advisory!.groups).toHaveLength(2);
    expect(advisory!.lenses).toEqual([null]);
  });

  it('collapses findings sharing a root cause into one panel', () => {
    // The whole point: 6 findings on one installer file used to buy 18 invocations that all
    // rediscovered the same closed window.
    const [blocking] = verificationTiers(
      [
        f('critical', { location: 'installer/contents_step_7.php:121' }),
        f('high', { location: 'installer/contents_step_7.php:75-76 → themes/x/index.php' }),
        f('high', { location: 'installer/contents_step_7.php' }),
      ],
      LENSES,
    );
    expect(blocking!.groups).toHaveLength(1);
    expect(blocking!.groups[0]!.findings).toHaveLength(3);
  });

  it('gives a group the full panel when any one member blocks', () => {
    // A group's cost is its worst member's cost, which is what tiering matches the panel to.
    const [blocking, advisory] = verificationTiers(
      [
        f('low', { location: 'installer/x.php:1' }),
        f('critical', { location: 'installer/x.php:99' }),
      ],
      LENSES,
    );
    expect(blocking!.groups).toHaveLength(1);
    expect(blocking!.groups[0]!.findings).toHaveLength(2);
    expect(advisory!.groups).toHaveLength(0);
  });

  it('excludes findings with no proof-of-concept from the advisory tier', () => {
    // Nothing to execute means a verifier could only guess — and guessing would fold the
    // synthetic qa-gap entries that exist to say an adversary never reported at all.
    const [, advisory] = verificationTiers(
      [f('medium', { poc: undefined }), f('low', { poc: '' }), f('low')],
      LENSES,
    );
    expect(advisory!.groups).toHaveLength(1);
  });

  it('still panels a blocking finding that supplied no proof', () => {
    // A blocking claim with no proof is exactly what is worth putting a panel on.
    const [blocking] = verificationTiers([f('critical', { poc: undefined })], LENSES);
    expect(blocking!.groups).toHaveLength(1);
  });

  it('orders each tier worst-first so a capped tier spends on what costs most', () => {
    const [blocking] = verificationTiers([f('high'), f('critical')], LENSES);
    expect(blocking!.groups.map((g) => g.findings[0]!.severity)).toEqual(['critical', 'high']);
  });

  it('ranks a group by its worst member', () => {
    const [blocking] = verificationTiers(
      [
        f('high', { location: 'a.php:1' }),
        f('high', { location: 'b.php:1' }),
        f('critical', { location: 'b.php:2' }),
      ],
      LENSES,
    );
    expect(blocking!.groups[0]!.key).toBe('file:b.php');
  });

  it('splits an oversized cause into further panels rather than dropping its tail', () => {
    // An enterprise roster concentrated on one file would otherwise ask one verifier to run
    // two dozen proofs in a single pass. Every finding is still verified.
    const many = Array.from({ length: 14 }, () => f('low', { location: 'one.php' }));
    const [, advisory] = verificationTiers(many, LENSES);
    expect(advisory!.groups.map((g) => g.findings.length)).toEqual([6, 6, 2]);
    expect(advisory!.groups.map((g) => g.key)).toEqual([
      'file:one.php',
      'file:one.php#2',
      'file:one.php#3',
    ]);
    expect(advisory!.overflow).toBe(0);
  });

  it('counts GROUPS against the cap, not findings', () => {
    // 30 findings on one file are 5 panels, not 30 — well inside the cap that 30 separate
    // findings would have overflowed.
    const many = Array.from({ length: 30 }, () => f('low', { location: 'one.php' }));
    const [, advisory] = verificationTiers(many, LENSES);
    expect(advisory!.groups).toHaveLength(5);
    expect(advisory!.overflow).toBe(0);
  });

  it('reports overflow per tier rather than truncating silently', () => {
    const many = Array.from({ length: 30 }, () => f('low'));
    const [, advisory] = verificationTiers(many, LENSES);
    expect(advisory!.groups).toHaveLength(20);
    expect(advisory!.overflow).toBe(10);
  });

  it('is stable across the dispatch and read-back passes', () => {
    // Both passes call this with the same findings, so membership, order and the POSITION of
    // each finding inside its group cannot drift — which is what keeps the agent ids the two
    // passes compute identical and each verdict on the finding it was written for.
    const input = [f('critical'), f('low'), f('high'), f('medium')];
    const shape = (t: ReturnType<typeof verificationTiers>) =>
      t.map((x) => x.groups.map((g) => [g.key, g.findings.map((y) => y.location)]));
    expect(shape(verificationTiers(input, LENSES))).toEqual(
      shape(verificationTiers(input, LENSES)),
    );
  });
});

describe('08d disproved-finding ledger entry', () => {
  /** Captures ledger rows separately from review-finding rows: recordLedgerEntry inserts ONE
   *  task_events object, recordReviewFindings inserts an ARRAY of review_findings. */
  function captureCtx() {
    const ledger: Record<string, unknown>[] = [];
    const ctx = {
      taskId: 't',
      taskStepId: 's',
      round: 2,
      logger: { info: () => {}, warn: () => {}, debug: () => {} },
      db: {
        insert: () => ({
          values: (v: unknown) => {
            if (!Array.isArray(v)) ledger.push(v as Record<string, unknown>);
            return { onConflictDoNothing: () => Promise.resolve() };
          },
        }),
      },
    } as unknown as StepContext;
    return { ctx, ledger };
  }

  const json = (o: unknown) => '```json\n' + JSON.stringify(o) + '\n```';
  const adversary = (findings: Record<string, unknown>[]): AgentMiningResult => ({
    agentId: 'auth-bandit',
    agentTitle: 'auth-bandit',
    invocationId: 'inv-a',
    status: 'done',
    output: null,
    rawOutput: json({ verdict: 'NEEDS_FIXES', findings }),
    errorMessage: null,
  });
  const FINDING = {
    severity: 'critical',
    location: 'admin.php:10',
    impact: 'rce',
    poc: 'GET /x',
    category: 'auth',
  };
  const observed = 'Issued GET https://x.ddev.site/x and got 404 with an empty body, no shell';

  async function runTwoPasses(ctx: StepContext, reproduced: boolean) {
    vi.spyOn(configService, 'getBoolean').mockResolvedValue(true);
    vi.spyOn(configService, 'getNumber').mockResolvedValue(3);
    const args = (results: AgentMiningResult[]) =>
      ({
        detected: {
          level: 'poc',
          spec: 's',
          implementationFiles: [],
          appUrl: 'https://x.ddev.site',
        },
        agentMiningResults: results,
        isFinalMiningAttempt: true,
      }) as unknown as Parameters<typeof adversarialQaStep.apply>[1];
    const first = await adversarialQaStep
      .apply(ctx, args([adversary([FINDING])]))
      .catch((e: unknown) => e);
    const dispatches = (first as MiningWaveError).dispatches;
    const verifiers: AgentMiningResult[] = dispatches.map((d) => ({
      agentId: d.agentId,
      agentTitle: d.agentTitle,
      invocationId: 'inv-v',
      status: 'done',
      output: null,
      rawOutput: json({
        verdicts: [
          reproduced
            ? { finding: 1, reproduced: true }
            : { finding: 1, reproduced: false, observation: observed },
        ],
      }),
      errorMessage: null,
    }));
    return adversarialQaStep.apply(ctx, args([adversary([FINDING]), ...verifiers]));
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('records what was disproved, worded so a later round can raise it again', async () => {
    const { ctx, ledger } = captureCtx();
    await runTwoPasses(ctx, false);
    expect(ledger).toHaveLength(1);
    const payload = ledger[0]!.payload as Record<string, unknown>;
    const text = String(payload.text);
    expect(text).toContain('did not reproduce');
    expect(text).toContain('admin.php:10');
    // Context, never a ban: round 3's fixes created the bugs round 4 found, so a verdict is
    // about a moment. The wording has to invite the re-raise.
    expect(text).toContain('raise one again');
    expect(text).toContain('what changed');
    expect(payload.round).toBe(2);
  });

  it('writes nothing when the panel reproduced the finding', async () => {
    const { ctx, ledger } = captureCtx();
    await runTwoPasses(ctx, true);
    expect(ledger).toHaveLength(0);
  });
});
