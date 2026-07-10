import { describe, expect, it } from 'vitest';
import { parsePrePlanningOutput } from '../src/step-engine/steps/workflow/04-phase-0b-pre-planning.js';
import { parseLearningOutput } from '../src/step-engine/steps/workflow/11-phase-8-learning.js';
import { parseQaResolveOutput } from '../src/step-engine/steps/onboarding/09_2-qa-resolve.js';

// A markdown body that itself contains ``` code fences — the payload that truncated
// the old non-greedy /```json([\s\S]*?)```/ extractor and silently fell to a stub /
// threw. Each parser below now routes through the shared brace-matching helper.
const fencedBody = [
  '## Example',
  // The learning admission bar drops an entry whose body cites no file:line.
  'Seen at src/example.ts:12.',
  '```ts',
  'const x = 1;',
  '```',
  '```sql',
  'SELECT 1;',
  '```',
  '```mermaid',
  'graph LR',
  '  A --> B',
  '```',
  '```before',
  'old',
  '```',
  '```after',
  'new',
  '```',
  '## Comprehension Quiz',
  '### Q1: ok?',
  '- [x] yes',
  '- [ ] no',
  '> Explanation: because.',
].join('\n');

function wrap(obj: unknown): string {
  return ['Here is the result:', '```json', JSON.stringify(obj), '```', 'done.'].join('\n');
}

describe('nested-fence regression across HIGH parsers', () => {
  it('parsePrePlanningOutput keeps a spec body with nested ``` fences', () => {
    const result = parsePrePlanningOutput(wrap({ summary: 'short summary', spec: fencedBody }));
    expect(result).not.toBeNull();
    expect(result?.spec).toBe(fencedBody);
    expect(result?.summary).toBe('short summary');
  });

  it('parseLearningOutput keeps entry bodies with nested fences (object form)', () => {
    const result = parseLearningOutput(
      wrap({ entries: [{ id: 'lesson-one', title: 'Lesson', body: fencedBody }] }),
    );
    expect(result).toHaveLength(1);
    expect(result?.[0].body).toBe(fencedBody);
  });

  it('parseLearningOutput preserves a top-level array whole (array-aware matcher)', () => {
    const result = parseLearningOutput(
      wrap([
        { id: 'a', title: 'A', body: fencedBody },
        { id: 'b', title: 'B', body: 'plain — src/b.ts:2' },
      ]),
    );
    expect(result).toHaveLength(2);
    expect(result?.[0].body).toBe(fencedBody);
    expect(result?.[1].id).toBe('b');
  });

  it('parseQaResolveOutput keeps answers[].proposedWrite.content with nested fences', () => {
    const result = parseQaResolveOutput(
      wrap({
        answers: [
          {
            question: 'How do the patterns work?',
            answer: 'See the proposed section.',
            source: 'code',
            proposedWrite: { relPath: 'docs/x.md', section: 'Patterns', content: fencedBody },
          },
        ],
        unanswered: [],
      }),
    );
    expect(result.answers).toHaveLength(1);
    expect(result.answers[0].proposedWrite?.content).toBe(fencedBody);
  });
});
