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

it('names the field and shows a bounded JSON-quoted invalid value', () => {
  expect(() => assertVersionToken('8.0"\nhooks:', 'Database version')).toThrow(
    'Database version: invalid version token "8.0\\"\\nhooks:"',
  );
  try {
    assertVersionToken('x'.repeat(1000) + '\n', 'nodeVersion');
  } catch (err) {
    expect((err as Error).message).toContain('"' + 'x'.repeat(80) + '…"');
    expect((err as Error).message).not.toContain('x'.repeat(81));
  }
});

it.each([0x2028, 0x009b, 0x007f, 0x0085, 0x200b, 0x202e, 0x2060, 0x2069, 0xfeff])(
  'escapes invisible and control characters in the refusal preview (codepoint %i)',
  (codepoint) => {
    const character = String.fromCharCode(codepoint);
    const escaped = `\\u${codepoint.toString(16).padStart(4, '0')}`;
    expect(() => assertVersionToken(`1${character}2`, 'Stored pin')).toThrow(`"1${escaped}2"`);
    try {
      assertVersionToken(`1${character}2`);
    } catch (err) {
      expect((err as Error).message).not.toContain(character);
    }
  },
);
