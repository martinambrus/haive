import { expect, it } from 'vitest';
import { formatChangedLineRanges, MAX_RANGES_PER_FILE } from '../src/step/review-line-ranges.js';

it('discloses a range cap at a small injected bound while retaining the production default', () => {
  expect(MAX_RANGES_PER_FILE).toBe(20);
  const diff = [
    'diff --git a/a.ts b/a.ts',
    '--- a/a.ts',
    '+++ b/a.ts',
    '@@ -1 +1 @@',
    '@@ -3 +3,2 @@',
    '@@ -7 +7 @@',
  ].join('\n');
  expect(formatChangedLineRanges(diff, 2)).toEqual({
    'a.ts': 'lines 1, 3-4 (+1 more ranges)',
  });
});
