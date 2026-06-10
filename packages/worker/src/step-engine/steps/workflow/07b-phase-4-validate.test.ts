import { describe, it, expect } from 'vitest';
import { parseValidatorOutput, parseFixerOutput } from './07b-phase-4-validate.js';

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
