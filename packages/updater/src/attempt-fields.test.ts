import { expect, it } from 'vitest';
import { attemptVersion } from './attempt-fields.js';

it('accepts 64-character versions and replaces 65-character versions with unknown', () => {
  const longest = '1'.repeat(64);
  expect(attemptVersion(longest)).toBe(longest);
  expect(attemptVersion(longest + '1')).toBe('unknown');
});
