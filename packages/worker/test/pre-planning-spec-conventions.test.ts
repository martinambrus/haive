import { describe, expect, it } from 'vitest';
import {
  parsePrePlanningOutput,
  phase0bPrePlanningStep,
  stubPrePlanning,
} from '../src/step-engine/steps/workflow/04-phase-0b-pre-planning.js';

type Detect = Parameters<typeof stubPrePlanning>[0];

const detect: Detect = {
  taskTitle: 'Add widget',
  taskDescription: 'Add the widget to the dashboard.',
  discoverySummary: 'Dashboard lives in packages/web.',
  businessRequirements: '',
  relevantKbIds: [],
  kbReferences: [],
  priorRejectionFeedback: '',
};

describe('pre-planning presentation conventions', () => {
  it('buildPrompt instructs the quiz, mermaid, table and before/after conventions', () => {
    const prompt = phase0bPrePlanningStep.llm!.buildPrompt({ detected: detect, formValues: {} });
    expect(prompt).toContain('## Comprehension Quiz');
    expect(prompt).toContain('```mermaid');
    expect(prompt).toContain('- [x] <correct answer>');
    expect(prompt).toContain('`before` and `after`');
    expect(prompt).toContain('GFM table for the files-to-change overview');
  });

  it('stub spec carries the full convention set', () => {
    const { spec } = stubPrePlanning(detect);
    // Original required sections intact.
    expect(spec).toContain('# Spec: Add widget');
    for (const heading of ['## Goal', '## Approach', '## Risks', '## Acceptance criteria']) {
      expect(spec).toContain(heading);
    }
    // Conventions present.
    expect(spec).toContain('## Files to change');
    expect(spec).toContain('| File | Change |');
    expect(spec).toContain('```mermaid');
    expect(spec).toContain('## Comprehension Quiz');
    const questions = spec.match(/^### Q\d+:/gm) ?? [];
    expect(questions).toHaveLength(3);
    // Exactly one [x] per question block, correct positions varied (1, 2, 3).
    const blocks = spec.split(/^### /m).slice(1);
    const correctPositions = blocks.map((block) => {
      const options = block.split('\n').filter((l) => /^- \[[ x]\]/.test(l));
      expect(options.filter((l) => l.startsWith('- [x]'))).toHaveLength(1);
      return options.findIndex((l) => l.startsWith('- [x]'));
    });
    expect(new Set(correctPositions).size).toBeGreaterThan(1);
    // Quiz is the final section.
    expect(spec.trimEnd().endsWith('> Explanation: See the Discovery context section.')).toBe(true);
  });

  it('stub spec round-trips byte-identical through the fenced-JSON parser', () => {
    const { summary, spec } = stubPrePlanning(detect);
    const wrapped = ['```json', JSON.stringify({ summary, spec }), '```'].join('\n');
    const parsed = parsePrePlanningOutput(wrapped);
    expect(parsed?.spec).toBe(spec);
    expect(parsed?.summary).toBe(summary);
  });
});
