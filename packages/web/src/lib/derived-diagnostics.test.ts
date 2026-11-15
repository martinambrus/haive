import { describe, expect, it } from 'vitest';
import { describeDerivedProblem } from './derived-diagnostics';

describe('replacement editor diagnostics', () => {
  it.each([
    ['replacement-target-forbidden', 'Only code review and broad code audit'],
    ['replacement-not-composable', 'no composable declaration'],
    ['replacement-not-declared', 'does not declare this role'],
    ['replacement-contract-mismatch', 'exact host contract'],
    ['replacement-policy-incompatible', 'tokens and host policy'],
    ['replacement-role-ambiguous', 'unique producer'],
    ['replacement-contract-unavailable', 'host output contract'],
  ])('explains %s and both contract references', (kind, words) => {
    const text = describeDerivedProblem({
      kind,
      executionPath: 'full_workflow',
      operationIndex: 0,
      target: 'review',
      payload: 'module.example.check',
      expectedContract: { id: 'haive.code-review', version: 1 },
      actualContract: { id: 'haive.code-audit', version: 1 },
    });
    expect(text).toContain(words);
    expect(text).toContain('Expected: haive.code-review@1');
    expect(text).toContain('Actual: haive.code-audit@1');
    expect(text).toContain('module.example.check');
  });
});

it('explains admission replay refusal', () => {
  expect(describeDerivedProblem({ kind: 'invalid-derived-run-plan' })).toContain(
    'cannot be replayed as a pinned run plan',
  );
});
