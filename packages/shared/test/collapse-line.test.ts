import { describe, expect, it } from 'vitest';
import { collapseToLine } from '../src/utils/collapse-line.js';

const range = (from: number, to: number): number[] =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i);

// Enumerating the characters that break a line was wrong every time it was tried, so this walks
// the whole range: C0, DEL, C1 and the two Unicode line separators.
const CONTROLS = [...range(0x00, 0x1f), ...range(0x7f, 0x9f), 0x2028, 0x2029];

describe('collapseToLine', () => {
  it('turns every control and both line separators into a space', () => {
    for (const code of CONTROLS) {
      const hex = code.toString(16).padStart(4, '0');
      expect(collapseToLine(`name${String.fromCodePoint(code)}tail`), `U+${hex}`).toBe('name tail');
    }
  });

  it('collapses a run of whitespace of any kind to one space and trims both ends', () => {
    const nbsp = String.fromCharCode(0xa0);
    expect(collapseToLine(`  a \t\r\n b${nbsp}${nbsp}c  `)).toBe('a b c');
  });

  it('leaves a value that is already one line byte-identical', () => {
    for (const line of ['API Security', 'naïve caching', 'auth/overview', '- not a bullet']) {
      expect(collapseToLine(line)).toBe(line);
    }
  });

  it('answers an empty line for nothing at all, or for nothing but whitespace', () => {
    expect(collapseToLine(null)).toBe('');
    expect(collapseToLine(undefined)).toBe('');
    expect(collapseToLine(CONTROLS.map((c) => String.fromCodePoint(c)).join(''))).toBe('');
  });
});
