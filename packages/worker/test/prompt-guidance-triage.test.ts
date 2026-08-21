import { describe, expect, it } from 'vitest';
import { filterCandidates } from '../src/step-engine/steps/workflow/11e-prompt-guidance.js';
import { parsePromptDefects } from '../src/step-engine/steps/workflow/_prompt-defect.js';

function defects(...lines: string[]) {
  return parsePromptDefects([
    { stepId: '08c-code-review', raw: ['## PROMPT-DEFECT', ...lines].join('\n') },
  ]);
}

const AMBIGUITY = '- DEFECT: prompt_ambiguity | Name the target directory | a.ts:1';
const TASK_TEXT = '- DEFECT: task_description_defect | The user never said which page | b.ts:2';

describe('filterCandidates', () => {
  it('offers a fresh defect with seen = 0', () => {
    const out = filterCandidates(defects(AMBIGUITY), []);
    expect(out).toHaveLength(1);
    expect(out[0]!.seen).toBe(0);
    expect(out[0]!.disposition).toBe('new');
    expect(out[0]!.targetStep).toBe('07-phase-2-implement');
  });

  it('never re-offers a fingerprint the user already rejected', () => {
    const [d] = defects(AMBIGUITY);
    const out = filterCandidates(
      [d!],
      [{ fingerprint: d!.fingerprint, status: 'rejected', occurrences: 1 }],
    );
    expect(out).toEqual([]);
  });

  it('carries the occurrence count of an item already active', () => {
    const [d] = defects(AMBIGUITY);
    const out = filterCandidates(
      [d!],
      [{ fingerprint: d!.fingerprint, status: 'active', occurrences: 4 }],
    );
    expect(out[0]!.seen).toBe(4);
  });

  it('still offers an archived item, so a hand-disabled lesson can be revived', () => {
    const [d] = defects(AMBIGUITY);
    const out = filterCandidates(
      [d!],
      [{ fingerprint: d!.fingerprint, status: 'archived', occurrences: 2 }],
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.disposition).toBe('new');
    expect(out[0]!.seen).toBe(2);
  });

  it('a rejection at ANY visible scope suppresses the candidate', () => {
    // loadExisting already restricts rows to this repo's own plus the global ones, so a
    // rejected row reaching here is always one this repo is entitled to be bound by.
    const [d] = defects(AMBIGUITY);
    const out = filterCandidates(
      [d!],
      [
        { fingerprint: d!.fingerprint, status: 'active', occurrences: 3 },
        { fingerprint: d!.fingerprint, status: 'rejected', occurrences: 1 },
      ],
    );
    expect(out).toEqual([]);
  });

  // task_description_defect blames the USER's task text, which 03b-business-requirements
  // and 05-phase-0b5-spec-quality already own. Shown so the signal is not lost, never
  // offered -- storing it as step guidance would append a complaint about one task's
  // wording to every later task's prompt.
  it('surfaces a task_description_defect as display-only', () => {
    const out = filterCandidates(defects(TASK_TEXT), []);
    expect(out).toHaveLength(1);
    expect(out[0]!.disposition).toBe('display_only');
  });

  it('drops a defect from a reporter with no registered target step', () => {
    const [d] = defects(AMBIGUITY);
    expect(filterCandidates([{ ...d!, sourceStep: '99-unknown' }], [])).toEqual([]);
  });
});
