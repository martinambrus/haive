import { describe, expect, it } from 'vitest';
import {
  guidanceTargetStep,
  parsePromptDefects,
  promptDefectFingerprint,
  PROMPT_DEFECT_INSTRUCTION,
} from '../src/step-engine/steps/workflow/_prompt-defect.js';

const REVIEWER = '08c-code-review';

function block(...lines: string[]): string {
  return [
    '```json',
    '{ "verdict": "REQUEST_CHANGES" }',
    '```',
    '',
    '## PROMPT-DEFECT',
    ...lines,
  ].join('\n');
}

describe('parsePromptDefects', () => {
  it('round-trips a PROMPT-DEFECT block emitted after the fenced JSON', () => {
    const raw = block(
      '- DEFECT: prompt_ambiguity | Say which directory the new module belongs in | packages/api/src/routes/admin.ts:12',
    );
    const out = parsePromptDefects([{ stepId: REVIEWER, raw }]);
    expect(out).toHaveLength(1);
    expect(out[0]!.cause).toBe('prompt_ambiguity');
    expect(out[0]!.guidance).toBe('Say which directory the new module belongs in');
    expect(out[0]!.evidence).toBe('packages/api/src/routes/admin.ts:12');
    expect(out[0]!.sourceStep).toBe(REVIEWER);
  });

  it('ignores output with no PROMPT-DEFECT section (the expected case)', () => {
    const raw = [
      '```json',
      '{ "verdict": "APPROVE" }',
      '```',
      '',
      '## INSIGHTS',
      '- INSIGHT: x',
    ].join('\n');
    expect(parsePromptDefects([{ stepId: REVIEWER, raw }])).toEqual([]);
  });

  it('stops the block at the next heading, so a following section is not swallowed', () => {
    const raw = [
      '## PROMPT-DEFECT',
      '- DEFECT: missing_context | State the DB engine | a.ts:1',
      '## INSIGHTS',
      '- DEFECT: missing_context | not a defect line, wrong section | b.ts:2',
    ].join('\n');
    const out = parsePromptDefects([{ stepId: REVIEWER, raw }]);
    expect(out).toHaveLength(1);
    expect(out[0]!.guidance).toBe('State the DB engine');
  });

  it('drops a line whose cause is not one of the three offered', () => {
    const raw = block('- DEFECT: model_was_lazy | Try harder next time | a.ts:1');
    expect(parsePromptDefects([{ stepId: REVIEWER, raw }])).toEqual([]);
  });

  it('drops a line with no guidance text', () => {
    expect(
      parsePromptDefects([{ stepId: REVIEWER, raw: block('- DEFECT: prompt_ambiguity') }]),
    ).toEqual([]);
  });

  it('ignores output from a step with no guidance target', () => {
    const raw = block('- DEFECT: prompt_ambiguity | Something | a.ts:1');
    expect(parsePromptDefects([{ stepId: '03-phase-0a-discovery', raw }])).toEqual([]);
  });

  it('dedupes two reporters raising the same complaint at different lines', () => {
    const a = block('- DEFECT: missing_context | Name the config key to add | src/a.ts:10');
    const b = block('- DEFECT: missing_context | Name the config key to add | src/b.ts:99');
    const out = parsePromptDefects([
      { stepId: REVIEWER, raw: a },
      { stepId: '08d-adversarial-qa', raw: b },
    ]);
    expect(out).toHaveLength(1);
  });

  it('truncates a guidance line past the 400-char cap rather than dropping it', () => {
    const long = 'x'.repeat(600);
    const out = parsePromptDefects([
      { stepId: REVIEWER, raw: block(`- DEFECT: prompt_ambiguity | ${long} | a.ts:1`) },
    ]);
    expect(out[0]!.guidance).toHaveLength(400);
  });
});

describe('promptDefectFingerprint', () => {
  it('hashes equal across differing ids, paths and line numbers', () => {
    const a = promptDefectFingerprint(
      '07-phase-2-implement',
      'missing_context',
      'State the DB engine (see /repo/src/a.ts:10, task 2f1b0c9e-1a2b-3c4d-5e6f-7a8b9c0d1e2f)',
    );
    const b = promptDefectFingerprint(
      '07-phase-2-implement',
      'missing_context',
      'State the DB engine (see /other/path/b.ts:999, task 0000aaaa-1111-2222-3333-444455556666)',
    );
    expect(a).toBe(b);
  });

  it('separates different causes and different target steps', () => {
    const base = promptDefectFingerprint('07-phase-2-implement', 'missing_context', 'same text');
    expect(
      promptDefectFingerprint('07-phase-2-implement', 'prompt_ambiguity', 'same text'),
    ).not.toBe(base);
    expect(promptDefectFingerprint('07a-code-simplify', 'missing_context', 'same text')).not.toBe(
      base,
    );
  });

  it('is namespaced by the TARGET step, so the fingerprint is the storage key', () => {
    expect(promptDefectFingerprint('07-phase-2-implement', 'missing_context', 'x')).toMatch(
      /^07-phase-2-implement:[0-9a-f]{16}$/,
    );
  });
});

describe('guidanceTargetStep', () => {
  it('maps every capture site to the implementation step', () => {
    for (const id of [
      '07b-phase-4-validate',
      '08a-browser-verify',
      '08c-code-review',
      '08d-adversarial-qa',
    ]) {
      expect(guidanceTargetStep(id)).toBe('07-phase-2-implement');
    }
  });

  it('returns null for an unregistered reporter, so nothing unplaceable is stored', () => {
    expect(guidanceTargetStep('99-not-a-step')).toBeNull();
  });
});

describe('PROMPT_DEFECT_INSTRUCTION', () => {
  // The confabulation guard is the whole reason this feature does not drown the user
  // in candidates. If this sentence is ever edited out, the instruction still reads
  // fine and the behaviour silently degrades -- so assert it is there.
  it('states that omitting the section is the expected answer', () => {
    expect(PROMPT_DEFECT_INSTRUCTION).toMatch(/OMIT THE SECTION ENTIRELY/);
    expect(PROMPT_DEFECT_INSTRUCTION).toMatch(/correct and expected answer/);
  });

  it('names exactly the three causes the parser accepts', () => {
    expect(PROMPT_DEFECT_INSTRUCTION).toContain('prompt_ambiguity');
    expect(PROMPT_DEFECT_INSTRUCTION).toContain('missing_context');
    expect(PROMPT_DEFECT_INSTRUCTION).toContain('task_description_defect');
  });
});
