import { describe, expect, it } from 'vitest';
import { normalizeContent } from '../src/templates/normalize-content.js';

/** The regex form this function had before it was made linear; the two must agree on every input. */
function reference(input: string): string {
  const unixified = input.replace(/\r\n/g, '\n');
  const trimmedLines = unixified
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n');
  const collapsed = trimmedLines.replace(/\n{3,}/g, '\n\n');
  const trimmed = collapsed.replace(/\n+$/, '');
  return `${trimmed}\n`;
}

describe('normalizeContent', () => {
  it('strips trailing spaces and tabs per line, collapses blank runs and ends with one newline', () => {
    expect(normalizeContent('a  \t\r\nb \n\n\n\n\nc\n\n')).toBe('a\nb\n\nc\n');
    expect(normalizeContent('')).toBe('\n');
    expect(normalizeContent(' \t\n')).toBe('\n');
  });

  it('agrees with the regex form on mixed input, interior whitespace and other whitespace included', () => {
    const alphabet = [' ', '\t', '\n', '\r', 'a', 'b', '\u00a0', '\u2028', '-'];
    let seed = 7;
    const next = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff);
    for (let i = 0; i < 2000; i++) {
      let text = '';
      for (let n = next() % 40; n > 0; n--) text += alphabet[next() % alphabet.length];
      expect(normalizeContent(text), JSON.stringify(text)).toBe(reference(text));
    }
  });

  it('is linear on one line made of a long run of spaces or tabs', () => {
    const started = Date.now();
    expect(normalizeContent(`a${' '.repeat(300_000)}x`)).toBe(`a${' '.repeat(300_000)}x\n`);
    expect(normalizeContent(`a${'\t '.repeat(200_000)}`)).toBe('a\n');
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
