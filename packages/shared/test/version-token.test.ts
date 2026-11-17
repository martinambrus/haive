import { expect, it } from 'vitest';
import { assertVersionToken, isVersionToken } from '../src/tooling/version-token.js';
it('bounds complete ASCII tokens without rewriting them', () => {
  for (const v of ['a', 'a'.repeat(64), 'v1.0.1', '1.0.0+build.5']) {
    expect(isVersionToken(v)).toBe(true);
    expect(() => assertVersionToken(v)).not.toThrow();
  }
  for (const v of [
    undefined,
    null,
    123,
    '',
    'a'.repeat(65),
    '.latest',
    '_latest',
    '+latest',
    '-latest',
    '1.2.3\r',
    '1.2.3\n',
    '1.2.3\t',
    'latesté',
    'ｌatest',
    '1\u2029',
  ]) {
    expect(isVersionToken(v)).toBe(false);
    expect(() => assertVersionToken(v, 'Stored pin')).toThrow(/^Stored pin: invalid version token/);
  }
});
