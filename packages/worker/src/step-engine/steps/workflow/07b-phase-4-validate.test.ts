import { describe, it, expect } from 'vitest';
import {
  parseValidatorOutput,
  parseFixerOutput,
  churnHotspots,
  phase4ValidateStep,
} from './07b-phase-4-validate.js';
import { ALL_REVIEW_DIMENSION_IDS } from '@haive/shared/review';

describe('parseValidatorOutput', () => {
  it('parses a report followed by the final fenced JSON', () => {
    const raw = [
      '## Validation report',
      'Lots of markdown here…',
      '```json',
      JSON.stringify({
        verdict: 'ISSUES_FOUND',
        summary: 'two problems',
        issues: [
          { severity: 'high', file: 'a.ts:10', description: 'broken caller', fix: 'update it' },
        ],
        dimensions: [
          { name: 'Security', status: 'PASS' },
          { name: 'Backward Compatibility', status: 'FAIL', note: 'stale caller' },
        ],
      }),
      '```',
    ].join('\n');
    const p = parseValidatorOutput(raw);
    expect(p).not.toBeNull();
    expect(p!.verdict).toBe('ISSUES_FOUND');
    expect(p!.issues).toHaveLength(1);
    expect(p!.issues[0]!.file).toBe('a.ts:10');
    expect(p!.dimensions.filter((d) => d.status === 'FAIL')).toHaveLength(1);
  });

  it('accepts an already-parsed object (bypass stub shape)', () => {
    const p = parseValidatorOutput({
      verdict: 'VALID',
      summary: 'bypass stub',
      issues: [],
      dimensions: [],
    });
    expect(p).not.toBeNull();
    expect(p!.verdict).toBe('VALID');
  });

  it('applies defaults for omitted optional fields', () => {
    const p = parseValidatorOutput('```json\n{"verdict":"VALID"}\n```');
    expect(p!.summary).toBe('');
    expect(p!.issues).toEqual([]);
    expect(p!.dimensions).toEqual([]);
  });

  it('returns null on garbled output or a bad verdict', () => {
    expect(parseValidatorOutput('no json here')).toBeNull();
    expect(parseValidatorOutput('```json\n{broken}\n```')).toBeNull();
    expect(parseValidatorOutput('```json\n{"verdict":"MAYBE"}\n```')).toBeNull();
    expect(parseValidatorOutput(null)).toBeNull();
  });
});

describe('parseFixerOutput', () => {
  it('parses a fenced fixer report', () => {
    const p = parseFixerOutput('```json\n{"fixes_made":["restored guard"],"notes":"ok"}\n```');
    expect(p.fixesMade).toEqual(['restored guard']);
    expect(p.notes).toBe('ok');
  });

  it('falls back to no-fixes on garbled output', () => {
    expect(parseFixerOutput('not json')).toEqual({ fixesMade: [], notes: '' });
    expect(parseFixerOutput(null)).toEqual({ fixesMade: [], notes: '' });
  });

  it('applies defaults for omitted fields', () => {
    expect(parseFixerOutput({ notes: 'n' })).toEqual({ fixesMade: [], notes: 'n' });
  });
});

const stubLogger = { info() {}, warn() {}, error() {}, debug() {} } as unknown;

function mkValidateApply(partial: Record<string, unknown> = {}) {
  return {
    verdict: 'ISSUES_FOUND',
    summary: '',
    issues: [],
    dimensions: [],
    converged: true,
    churnFiles: [],
    fixesApplied: [],
    findingsSummary: '',
    report: '',
    validatorPasses: 1,
    source: 'validator',
    ...partial,
  };
}

function validatorRecord(iteration: number, files: string[]) {
  return {
    iteration,
    llmOutput: '',
    continueRequested: true,
    applyOutput: mkValidateApply({ issues: files.map((f) => ({ description: 'x', file: f })) }),
  };
}

function validatorJson(files: string[], verdict = 'ISSUES_FOUND') {
  return [
    '```json',
    JSON.stringify({
      verdict,
      summary: 's',
      issues: files.map((f) => ({ description: 'x', file: f })),
      dimensions: [],
    }),
    '```',
  ].join('\n');
}

describe('churnHotspots', () => {
  it('flags a file re-flagged in >= 3 validator passes (line numbers ignored)', () => {
    expect(
      churnHotspots([
        [{ description: 'x', file: '.ddev/Dockerfile:10' }],
        [{ description: 'x', file: '.ddev/Dockerfile:12' }],
        [{ description: 'x', file: '.ddev/Dockerfile:99' }],
      ]),
    ).toEqual(['.ddev/Dockerfile']);
  });

  it('does not flag a file seen in only 2 passes', () => {
    expect(
      churnHotspots([
        [{ description: 'x', file: 'a.ts:10' }],
        [{ description: 'x', file: 'a.ts:12' }],
      ]),
    ).toEqual([]);
  });

  it('counts a file once per pass even when flagged twice in one pass', () => {
    expect(
      churnHotspots([
        [
          { description: 'x', file: 'a.ts:10' },
          { description: 'y', file: 'a.ts:20' },
        ],
        [{ description: 'x', file: 'a.ts:12' }],
      ]),
    ).toEqual([]); // two distinct passes only -> below threshold
  });

  it('ignores issues without a file', () => {
    expect(
      churnHotspots([[{ description: 'x' }], [{ description: 'y' }], [{ description: 'z' }]]),
    ).toEqual([]);
  });
});

describe('phase4ValidateStep churn bail wiring', () => {
  const step = phase4ValidateStep;

  it('shouldContinue stops on a churn-bailed validator pass', async () => {
    const cont = await step.loop!.shouldContinue({
      ctx: {} as never,
      llmOutput: null,
      iteration: 4,
      previousIterations: [],
      applyOutput: mkValidateApply({ verdict: 'ISSUES_FOUND', churnFiles: ['a.ts'] }) as never,
    });
    expect(cont).toBe(false);
  });

  it('shouldContinue keeps looping on ISSUES_FOUND with no churn', async () => {
    const cont = await step.loop!.shouldContinue({
      ctx: {} as never,
      llmOutput: null,
      iteration: 4,
      previousIterations: [],
      applyOutput: mkValidateApply({ verdict: 'ISSUES_FOUND', churnFiles: [] }) as never,
    });
    expect(cont).toBe(true);
  });

  it('fixLoop does NOT route back to implement on a churn bail', () => {
    expect(
      step.fixLoop!.evaluate(
        mkValidateApply({ verdict: 'ISSUES_FOUND', churnFiles: ['a.ts'] }) as never,
      ),
    ).toBeNull();
  });

  it('fixLoop still routes back on ISSUES_FOUND without churn', () => {
    const v = step.fixLoop!.evaluate(
      mkValidateApply({
        verdict: 'ISSUES_FOUND',
        churnFiles: [],
        findingsSummary: 'fix me',
      }) as never,
    );
    expect(v).not.toBeNull();
    expect(v!.blocking).toBe(true);
  });

  // A parse miss names no defect — its summary literally reads "nothing to fix" — so it must
  // reach gate-2 rather than spend a fix round and feed the oscillation guard a phantom side.
  it('fixLoop does NOT route back on UNPARSEABLE', () => {
    expect(
      step.fixLoop!.evaluate(
        mkValidateApply({
          verdict: 'UNPARSEABLE',
          churnFiles: [],
          findingsSummary: '**Verdict:** UNPARSEABLE\n\n_No issues found — nothing to fix._',
        }) as never,
      ),
    ).toBeNull();
  });
});

describe('phase4ValidateStep.apply marks non-convergence', () => {
  const step = phase4ValidateStep;
  const ctx = { logger: stubLogger } as never;

  it('sets converged=false + churnFiles when a file is re-flagged a 3rd time', async () => {
    const out = (await step.apply(ctx, {
      detected: {} as never,
      formValues: {},
      iteration: 4,
      llmOutput: validatorJson(['a.ts:14']),
      previousIterations: [validatorRecord(0, ['a.ts:10']), validatorRecord(2, ['a.ts:12'])],
    } as never)) as { converged: boolean; churnFiles: string[]; findingsSummary: string };
    expect(out.churnFiles).toEqual(['a.ts']);
    expect(out.converged).toBe(false);
    expect(out.findingsSummary).toContain('Did not converge');
  });

  it('stays converged when the same file appears only twice', async () => {
    const out = (await step.apply(ctx, {
      detected: {} as never,
      formValues: {},
      iteration: 2,
      llmOutput: validatorJson(['a.ts:14']),
      previousIterations: [validatorRecord(0, ['a.ts:10'])],
    } as never)) as { converged: boolean; churnFiles: string[] };
    expect(out.converged).toBe(true);
    expect(out.churnFiles).toEqual([]);
  });

  it('stays converged when each pass flags different files', async () => {
    const out = (await step.apply(ctx, {
      detected: {} as never,
      formValues: {},
      iteration: 4,
      llmOutput: validatorJson(['c.ts:1']),
      previousIterations: [validatorRecord(0, ['a.ts:10']), validatorRecord(2, ['b.ts:5'])],
    } as never)) as { converged: boolean; churnFiles: string[] };
    expect(out.converged).toBe(true);
    expect(out.churnFiles).toEqual([]);
  });
});

describe('phase4ValidateStep fixer browser guidance', () => {
  const baseDetect = {
    worktreePath: '/wt',
    sandboxWorktreePath: '/ws',
    spec: 'spec',
    implementationFiles: [],
    debtBlock: '',
    honoredBlock: '',
  };
  const fixerPrompt = (browserTesting: boolean) =>
    phase4ValidateStep.loop!.buildIterationPrompt!({
      detected: { ...baseDetect, browserTesting } as never,
      formValues: {},
      iteration: 1, // odd = fixer pass
      previousIterations: [validatorRecord(0, ['app/Home.tsx:5'])],
    });

  it('includes chrome-devtools guidance in the fixer pass when browserTesting is on', () => {
    expect(fixerPrompt(true)).toContain('chrome-devtools');
  });

  it('omits browser guidance from the fixer pass when browserTesting is off', () => {
    expect(fixerPrompt(false)).not.toContain('chrome-devtools');
  });
});

describe('phase4ValidateStep change-set guard', () => {
  it('refuses to build the validator prompt when no changed file is known', () => {
    // Worse here than in a read-only reviewer: this pass feeds a fix agent that EDITS,
    // so a validator that guessed its scope rewrites code the task never touched.
    expect(() =>
      phase4ValidateStep.llm!.buildPrompt!({
        detected: {
          worktreePath: '/wt',
          sandboxWorktreePath: '/ws',
          spec: 'spec',
          implementationFiles: { files: [], total: 0, truncated: false, scanError: null },
          debtBlock: '',
          honoredBlock: '',
          browserTesting: false,
          docsOnly: false,
        },
      } as never),
    ).toThrow(/07b-phase-4-validate has no changed files to review/);
  });
});

describe('phase4ValidateStep scope fence', () => {
  const detected = {
    worktreePath: '/wt',
    sandboxWorktreePath: '/ws',
    spec: 'spec',
    // A real change set: buildPrompt refuses an empty one outright (assertReviewableChange),
    // so an empty fixture here would assert the fence against a step that never rendered.
    implementationFiles: { files: ['src/a.ts'], total: 1, truncated: false },
    debtBlock: '',
    honoredBlock: '',
    browserTesting: false,
  };

  // Both validator passes carry the fence: the validator<->fixer loop edits files
  // directly with no refutation and no gate, so an out-of-scope issue here is a legacy
  // rewrite that then widens every later round's changed-file list.
  const prompts = [
    () => phase4ValidateStep.llm!.buildPrompt!({ detected } as never),
    () =>
      phase4ValidateStep.loop!.buildIterationPrompt!({
        detected: detected as never,
        formValues: {},
        iteration: 2, // even = validator re-pass
        previousIterations: [],
      }),
  ];

  it('fences both validator passes without contradicting the repo-wide Step 4 search', () => {
    for (const build of prompts) {
      const prompt = build();
      expect(prompt).toContain('SCOPE FENCE. IN SCOPE =');
      // `issues` is what reaches the fix agent, so that is what the fence guards...
      expect(prompt).toContain('never in `issues`');
      // ...and the carve-out keeps Step 4 (a stale caller of something THIS change
      // renamed is in scope wherever it lives) from reading as fenced out.
      expect(prompt).toContain('renamed or removed (Step 4) is in scope wherever it lives');
    }
  });
});

describe('phase4ValidateStep documentation protocol', () => {
  const detect = (docsOnly: boolean, spec = 'THE BRIEF') => ({
    worktreePath: '/wt',
    sandboxWorktreePath: '/ws',
    spec,
    // docsOnly is passed explicitly below, so this set only has to be non-empty —
    // buildPrompt refuses an empty one (assertReviewableChange).
    implementationFiles: { files: ['src/a.ts'], total: 1, truncated: false },
    debtBlock: '',
    honoredBlock: '',
    browserTesting: false,
    promptDefectCapture: false,
    docsOnly,
  });

  // Both validator passes must branch identically: pass 0 and the re-validation pass
  // after a fix. A branch on only one of them is how a re-pass silently reverts to the
  // code protocol halfway through a documentation run.
  const validatorPrompts = (docsOnly: boolean, spec?: string) => [
    phase4ValidateStep.llm!.buildPrompt!({ detected: detect(docsOnly, spec) } as never),
    phase4ValidateStep.loop!.buildIterationPrompt!({
      detected: detect(docsOnly, spec) as never,
      formValues: {},
      iteration: 2, // even = validator re-pass
      previousIterations: [],
    }),
  ];

  it('runs the documentation protocol on a docs-only change', () => {
    for (const prompt of validatorPrompts(true)) {
      expect(prompt).toContain('You are the Documentation Validator');
      expect(prompt).toContain('Step 4 - Security posture pass');
      expect(prompt).toContain('Security posture disclosure');
      expect(prompt).toContain('labelled safe or unsafe rather than described neutrally');
      expect(prompt).toContain('CITE OR DROP.');
    }
  });

  it('drops the code-only protocol steps on a docs-only change', () => {
    for (const prompt of validatorPrompts(true)) {
      expect(prompt).not.toContain('You are the Implementation Validator');
      expect(prompt).not.toContain('Step 4 - Refactoring impact check');
      expect(prompt).not.toContain('Step 5 - Dead code detection');
      expect(prompt).not.toContain('Step 6 - UI language validation');
      expect(prompt).not.toContain('the 14-dimension table');
    }
  });

  it('fences the documentation pass to the document, not the repository', () => {
    for (const prompt of validatorPrompts(true)) {
      expect(prompt).toContain('SCOPE FENCE. This change touched documentation only.');
      expect(prompt).toContain('never by changing the project to match a sentence');
      // Disposition C names a Step 4 carve-out this protocol does not have.
      expect(prompt).not.toContain('renamed or removed (Step 4) is in scope wherever it lives');
    }
  });

  it('leaves the code protocol untouched when the change is not docs-only', () => {
    for (const prompt of validatorPrompts(false)) {
      expect(prompt).toContain('You are the Implementation Validator');
      expect(prompt).toContain('Step 4 - Refactoring impact check');
      expect(prompt).toContain('Step 5 - Dead code detection');
      expect(prompt).toContain('Step 6 - UI language validation');
      expect(prompt).toContain('the 14-dimension table with PASS/FAIL/N/A');
      expect(prompt).toContain('SCOPE FENCE. IN SCOPE =');
      expect(prompt).not.toContain('Documentation Validator');
      expect(prompt).not.toContain('CITE OR DROP.');
    }
  });

  it('labels the brief per protocol on every pass, fixer included', () => {
    const fixerPrompt = (docsOnly: boolean) =>
      phase4ValidateStep.loop!.buildIterationPrompt!({
        detected: detect(docsOnly) as never,
        formValues: {},
        iteration: 1, // odd = fixer pass
        previousIterations: [validatorRecord(0, ['README.md:5'])],
      });
    for (const prompt of [...validatorPrompts(true), fixerPrompt(true)]) {
      expect(prompt).toContain('=== Brief (what the document was asked to cover) ===');
      expect(prompt).toContain('THE BRIEF');
    }
    expect(validatorPrompts(false)[0]).toContain(
      '=== Spec (what the implementation must deliver) ===',
    );
    expect(fixerPrompt(false)).toContain('=== Spec (the original requirements) ===');
  });

  it('gives the FIXER the evidence bar on a docs-only change, and not otherwise', () => {
    // The fixer never receives the validator definition, so the bar that lives there does
    // not reach the pass that actually writes the prose.
    const fixerPrompt = (docsOnly: boolean) =>
      phase4ValidateStep.loop!.buildIterationPrompt!({
        detected: detect(docsOnly) as never,
        formValues: {},
        iteration: 1, // odd = fixer pass
        previousIterations: [validatorRecord(0, ['README.md:5'])],
      });
    expect(fixerPrompt(true)).toContain('CITE OR DROP.');
    expect(fixerPrompt(true)).toContain('Do NOT edit application code');
    expect(fixerPrompt(false)).not.toContain('CITE OR DROP.');
  });

  it('says "no brief recorded" rather than "no spec recorded" when the task has neither', () => {
    // detect() now falls back to the task title + description, so an empty string here
    // means the task itself was untitled and undescribed — not that a spec step was skipped.
    for (const prompt of validatorPrompts(false, '')) {
      expect(prompt).toContain('(no brief recorded)');
      expect(prompt).not.toContain('(no spec recorded)');
    }
  });
});

describe('phase4ValidateStep review-dimension scope', () => {
  const detect = (reviewDimensionIds?: string[]) => ({
    worktreePath: '/wt',
    sandboxWorktreePath: '/ws',
    spec: 'THE SPEC',
    implementationFiles: { files: ['src/a.ts'], total: 1, truncated: false },
    debtBlock: '',
    honoredBlock: '',
    browserTesting: false,
    promptDefectCapture: false,
    docsOnly: false,
    ...(reviewDimensionIds ? { reviewDimensionIds } : {}),
  });

  // Both validator passes branch on the same set, or a re-pass after a fix silently
  // re-widens the review halfway through the loop.
  const validatorPrompts = (ids?: string[]) => [
    phase4ValidateStep.llm!.buildPrompt!({ detected: detect(ids) } as never),
    phase4ValidateStep.loop!.buildIterationPrompt!({
      detected: detect(ids) as never,
      formValues: {},
      iteration: 2,
      previousIterations: [],
    }),
  ];

  it('scores all 14 when nothing is scoped out', () => {
    for (const prompt of validatorPrompts([...ALL_REVIEW_DIMENSION_IDS])) {
      expect(prompt).toContain('1. Security - ');
      expect(prompt).toContain('11. Accessibility - ');
      expect(prompt).toContain('14. Privacy / Compliance - ');
      expect(prompt).toContain('the 14-dimension table');
    }
  });

  // A persisted detect_output from before the field existed replays without it.
  it('scores all 14 when the detect payload predates the field', () => {
    for (const prompt of validatorPrompts()) {
      expect(prompt).toContain('11. Accessibility - ');
      expect(prompt).toContain('the 14-dimension table');
    }
  });

  it('drops an excluded dimension and renumbers the rest', () => {
    const kept = ALL_REVIEW_DIMENSION_IDS.filter((id) => id !== 'accessibility');
    for (const prompt of validatorPrompts([...kept])) {
      expect(prompt).not.toContain('Accessibility - ARIA labels');
      expect(prompt).toContain('the 13-dimension table');
      // Internationalization was #12; with #11 gone it becomes #11.
      expect(prompt).toContain('11. Internationalization - ');
      expect(prompt).toContain('13. Privacy / Compliance - ');
    }
  });

  it('names an in-scope dimension in the JSON example, never an excluded one', () => {
    const prompt = phase4ValidateStep.llm!.buildPrompt!({
      detected: detect(['accessibility']),
    } as never);
    expect(prompt).toContain('"name": "Accessibility"');
    expect(prompt).not.toContain('"name": "Security"');
  });

  it('records what was not scored, so gate 2 can say so', async () => {
    const kept = ALL_REVIEW_DIMENSION_IDS.filter(
      (id) => id !== 'accessibility' && id !== 'internationalization',
    );
    const out = (await phase4ValidateStep.apply(
      { logger: stubLogger } as never,
      {
        detected: detect([...kept]),
        formValues: {},
        iteration: 0,
        previousIterations: [],
        llmOutput: '```json\n{"verdict":"VALID","summary":"ok","issues":[],"dimensions":[]}\n```',
      } as never,
    )) as { excludedDimensions: string[] };
    expect(out.excludedDimensions).toEqual(['Accessibility', 'Internationalization']);
  });

  it('records an empty exclusion list on a full-set run', async () => {
    const out = (await phase4ValidateStep.apply(
      { logger: stubLogger } as never,
      {
        detected: detect([...ALL_REVIEW_DIMENSION_IDS]),
        formValues: {},
        iteration: 0,
        previousIterations: [],
        llmOutput: '```json\n{"verdict":"VALID","summary":"ok","issues":[],"dimensions":[]}\n```',
      } as never,
    )) as { excludedDimensions: string[] };
    expect(out.excludedDimensions).toEqual([]);
  });
});
