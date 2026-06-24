import { describe, it, expect } from 'vitest';
import {
  parseValidatorOutput,
  parseFixerOutput,
  churnHotspots,
  phase4ValidateStep,
} from './07b-phase-4-validate.js';

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
