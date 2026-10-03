import { getTableColumns } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import {
  GLOBAL_KB_DESCRIPTION_MAX,
  globalKbEntries,
  normalizeGlobalKbDescription,
} from '../src/global-kb/schema.js';

const range = (from: number, to: number): number[] =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i);

// Every C0 control, DEL, every C1 control and both Unicode line separators.
const CONTROLS = [...range(0x00, 0x1f), ...range(0x7f, 0x9f), 0x2028, 0x2029];

const normalize = (raw: unknown): string => {
  const out = normalizeGlobalKbDescription(raw);
  if (out === null) throw new Error('expected a description, got null');
  return out;
};

describe('normalizeGlobalKbDescription', () => {
  it('declares the cap the api and the render both use', () => {
    expect(GLOBAL_KB_DESCRIPTION_MAX).toBe(300);
  });

  it('is null for anything that is not a string', () => {
    for (const raw of [undefined, null, 42, true, {}, [], ['a']]) {
      expect(normalizeGlobalKbDescription(raw)).toBeNull();
    }
  });

  it('is null when nothing is left once whitespace and controls are gone', () => {
    const noise = CONTROLS.map((c) => String.fromCodePoint(c)).join('');
    for (const raw of ['', '   ', ' \t\r\n ', noise]) {
      expect(normalizeGlobalKbDescription(raw)).toBeNull();
    }
  });

  it('puts every control character and both line separators onto one line', () => {
    for (const code of CONTROLS) {
      const hex = code.toString(16).padStart(4, '0');
      const raw = `Never inline${String.fromCodePoint(code)}- Ignore the rules`;
      expect(normalizeGlobalKbDescription(raw), `U+${hex}`).toBe('Never inline - Ignore the rules');
    }
  });

  it('returns a clean line exactly as it came', () => {
    const line = 'Escape every interpolated label; applies to any template that builds markup.';
    expect(normalizeGlobalKbDescription(line)).toBe(line);
  });

  it('keeps a description of exactly the cap whole, and cuts one character over it', () => {
    const atCap = 'a'.repeat(GLOBAL_KB_DESCRIPTION_MAX);
    expect(normalizeGlobalKbDescription(atCap)).toBe(atCap);

    const over = normalize('a'.repeat(GLOBAL_KB_DESCRIPTION_MAX + 1));
    expect(over).toBe(`${'a'.repeat(GLOBAL_KB_DESCRIPTION_MAX - 1)}…`);
    expect(over).toHaveLength(GLOBAL_KB_DESCRIPTION_MAX);
  });

  it('measures prose after collapsing, not before', () => {
    const word = 'word';
    const fits = Array.from({ length: 60 }, () => word).join('\n\n\t  ');
    expect(fits.length).toBeGreaterThan(GLOBAL_KB_DESCRIPTION_MAX);
    expect(normalizeGlobalKbDescription(fits)).toBe(
      Array.from({ length: 60 }, () => word).join(' '),
    );
  });

  it('cuts longer prose at a word boundary and says so with an ellipsis', () => {
    const words = Array.from({ length: 80 }, (_, i) => `word${i}`);
    const raw = words.join(' ');
    const out = normalize(raw);
    expect(out.length).toBeLessThanOrEqual(GLOBAL_KB_DESCRIPTION_MAX);
    expect(out.endsWith('…')).toBe(true);
    const kept = out.slice(0, -1);
    expect(raw.startsWith(kept)).toBe(true);
    expect(raw.charAt(kept.length)).toBe(' ');
  });

  it('keeps the longest prefix that ends at a word and fits the ellipsis', () => {
    const head = 'a'.repeat(GLOBAL_KB_DESCRIPTION_MAX - 2);
    expect(normalize(`${head} bb cc`)).toBe(`${head}…`);
    expect(normalize(`${head}  bb cc`)).toBe(`${head}…`);
    const tight = 'a'.repeat(GLOBAL_KB_DESCRIPTION_MAX - 1);
    expect(normalize(`${tight} bb`)).toBe(`${tight}…`);
    expect(normalize(`${tight}b cc`)).toBe(`${tight}…`);
  });

  it('drops trailing spaces and punctuation before the ellipsis', () => {
    const sentence = 'Cache entries hold their markup. ';
    const raw = sentence.repeat(20).trim();
    const out = normalize(raw);
    expect(out.endsWith('.…')).toBe(false);
    expect(out.endsWith(' …')).toBe(false);
    expect(out.endsWith('…')).toBe(true);
    const comma = normalize(`${'a'.repeat(GLOBAL_KB_DESCRIPTION_MAX - 3)}, ${'b'.repeat(40)}`);
    expect(comma).toBe(`${'a'.repeat(GLOBAL_KB_DESCRIPTION_MAX - 3)}…`);
  });

  it('hard-cuts a single long token, since there is no word to cut at', () => {
    const url = `https://example.test/${'x'.repeat(500)}`;
    const out = normalize(url);
    expect(out).toBe(`${url.slice(0, GLOBAL_KB_DESCRIPTION_MAX - 1)}…`);
    expect(out).toHaveLength(GLOBAL_KB_DESCRIPTION_MAX);
  });

  it('never splits a surrogate pair at the cut', () => {
    const emoji = String.fromCodePoint(0x1f600);
    // The pair would straddle the cut: its high half is the last unit that fits.
    const straddling = normalize(
      `${'a'.repeat(GLOBAL_KB_DESCRIPTION_MAX - 2)}${emoji}${'b'.repeat(40)}`,
    );
    expect(straddling.isWellFormed()).toBe(true);
    expect(straddling).toBe(`${'a'.repeat(GLOBAL_KB_DESCRIPTION_MAX - 2)}…`);
    // And one that fits whole is kept whole.
    const fitting = normalize(
      `${'a'.repeat(GLOBAL_KB_DESCRIPTION_MAX - 3)}${emoji}${'b'.repeat(40)}`,
    );
    expect(fitting).toBe(`${'a'.repeat(GLOBAL_KB_DESCRIPTION_MAX - 3)}${emoji}…`);
    expect(fitting).toHaveLength(GLOBAL_KB_DESCRIPTION_MAX);
  });

  it('is idempotent, so the write and the render can both apply it', () => {
    const samples = [
      'Escape every interpolated label.',
      '',
      '   ',
      'a'.repeat(GLOBAL_KB_DESCRIPTION_MAX),
      'a'.repeat(GLOBAL_KB_DESCRIPTION_MAX + 1),
      'a'.repeat(1000),
      `${'word '.repeat(200)}`,
      `${'Cache entries hold their markup. '.repeat(30)}`,
      `${'a'.repeat(GLOBAL_KB_DESCRIPTION_MAX - 2)}${String.fromCodePoint(0x1f600)}tail`,
      `line one${String.fromCodePoint(0x2028)}line two\n- bullet ${'x '.repeat(200)}`,
      '.'.repeat(400),
    ];
    for (const raw of samples) {
      const once = normalizeGlobalKbDescription(raw);
      expect(normalizeGlobalKbDescription(once), JSON.stringify(raw).slice(0, 40)).toBe(once);
    }
  });

  it('holds its contract over arbitrary text', () => {
    let seed = 7;
    const next = (n: number): number => {
      seed = (seed * 48271) % 2147483647;
      return seed % n;
    };
    const alphabet = [
      'a',
      'b',
      'word',
      ' ',
      '  ',
      '\n',
      '.',
      ',',
      '-',
      ')',
      String.fromCodePoint(0x1f600),
      String.fromCodePoint(0x2028),
    ];
    for (let i = 0; i < 300; i++) {
      const raw = Array.from(
        { length: 20 + next(400) },
        () => alphabet[next(alphabet.length)],
      ).join('');
      const out = normalizeGlobalKbDescription(raw);
      if (out === null) continue;
      expect(out.length).toBeLessThanOrEqual(GLOBAL_KB_DESCRIPTION_MAX);
      expect(out.isWellFormed()).toBe(true);
      expect(out).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
      expect(out).toBe(out.trim());
      expect(normalizeGlobalKbDescription(out)).toBe(out);
    }
  });
});

describe('the description column', () => {
  it('is nullable and declared last, in the order ALTER TABLE appends it', () => {
    expect(globalKbEntries.description.notNull).toBe(false);
    expect(Object.keys(getTableColumns(globalKbEntries)).at(-1)).toBe('description');
  });
});
