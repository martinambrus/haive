import { describe, expect, it } from 'vitest';
import { HIDDEN_CHARACTER } from '../src/utils/hidden-characters.js';

const text = (code: number): string => String.fromCodePoint(code);

describe('HIDDEN_CHARACTER', () => {
  it.each([
    ['NUL', 0x0],
    ['BS', 0x8],
    ['VT', 0xb],
    ['FF', 0xc],
    ['CR', 0xd],
    ['the last C0 control', 0x1f],
    ['DEL', 0x7f],
    ['NEL', 0x85],
    ['the last C1 control', 0x9f],
    ['a soft hyphen', 0xad],
    ['a combining grapheme joiner', 0x34f],
    ['an Arabic letter mark', 0x61c],
    ['a Mongolian free variation selector', 0x180b],
    ['a zero width space', 0x200b],
    ['a zero width non-joiner', 0x200c],
    ['a zero width joiner', 0x200d],
    ['a left-to-right mark', 0x200e],
    ['a right-to-left mark', 0x200f],
    ['a line separator', 0x2028],
    ['a paragraph separator', 0x2029],
    ['a left-to-right embedding', 0x202a],
    ['a right-to-left override', 0x202e],
    ['a word joiner', 0x2060],
    ['a left-to-right isolate', 0x2066],
    ['a pop directional isolate', 0x2069],
    ['a Hangul filler', 0x3164],
    ['a variation selector', 0xfe0f],
    ['a byte order mark', 0xfeff],
    ['a halfwidth Hangul filler', 0xffa0],
    ['a language tag', 0xe0001],
    ['a tag space', 0xe0020],
    ['a supplementary variation selector', 0xe0100],
  ])('matches %s', (_label, code) => {
    expect(HIDDEN_CHARACTER.test(`a${text(code)}b`)).toBe(true);
    expect(HIDDEN_CHARACTER.test(text(code))).toBe(true);
  });

  it.each([
    ['a letter', 0x61],
    ['TAB', 0x9],
    ['LF', 0xa],
    ['a space', 0x20],
    ['a no-break space', 0xa0],
    ['an em space', 0x2003],
    ['a middle dot', 0xb7],
    ['an accented letter', 0xe9],
    ['a combining acute accent', 0x301],
    ['an Arabic letter', 0x639],
    ['a CJK character', 0x65e5],
    ['an en dash', 0x2013],
    ['a right single quotation mark', 0x2019],
    ['the replacement character', 0xfffd],
    ['an emoji', 0x1f680],
  ])('does not match %s', (_label, code) => {
    expect(HIDDEN_CHARACTER.test(`a${text(code)}b`)).toBe(false);
  });

  it('finds the first hidden character of a text, with its position', () => {
    const found = HIDDEN_CHARACTER.exec(`ab${text(0x200b)}c${text(0x202e)}`);
    expect(found?.[0]).toBe(text(0x200b));
    expect(found?.index).toBe(2);
  });

  it('keeps no state between calls', () => {
    expect(HIDDEN_CHARACTER.global).toBe(false);
    expect(HIDDEN_CHARACTER.sticky).toBe(false);
    const hidden = `a${text(0x200b)}`;
    expect([1, 2, 3].map(() => HIDDEN_CHARACTER.test(hidden))).toEqual([true, true, true]);
  });
});
