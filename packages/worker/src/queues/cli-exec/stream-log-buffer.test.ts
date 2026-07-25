import { describe, expect, it } from 'vitest';
import { createStreamLogBuffer } from './stream-log-buffer.js';

describe('createStreamLogBuffer', () => {
  it('returns the transcript verbatim while it stays within the bounds', () => {
    const buf = createStreamLogBuffer({ headChars: 10, tailChars: 10 });
    buf.push('a'.repeat(10));
    buf.push('b'.repeat(10));
    expect(buf.toString()).toBe('a'.repeat(10) + 'b'.repeat(10));
  });

  it('splits a chunk that straddles the head boundary without losing anything', () => {
    const buf = createStreamLogBuffer({ headChars: 5, tailChars: 5 });
    buf.push('abcdefgh');
    expect(buf.toString()).toBe('abcdefgh');
  });

  it('keeps the head and the tail and marks what it dropped', () => {
    const buf = createStreamLogBuffer({ headChars: 10, tailChars: 10 });
    buf.push('a'.repeat(10));
    buf.push('b'.repeat(10));
    buf.push('c'.repeat(10));
    const out = buf.toString();
    expect(out.startsWith('a'.repeat(10))).toBe(true);
    expect(out.endsWith('c'.repeat(10))).toBe(true);
    expect(out).toContain('10 characters elided');
    expect(out).not.toContain('b');
  });

  it('truncates a single chunk larger than the whole tail budget', () => {
    const buf = createStreamLogBuffer({ headChars: 5, tailChars: 5 });
    buf.push('a'.repeat(5));
    buf.push('x'.repeat(20));
    const out = buf.toString();
    expect(out.startsWith('aaaaa')).toBe(true);
    expect(out.endsWith('xxxxx')).toBe(true);
    expect(out).toContain('15 characters elided');
  });

  it('ignores empty chunks', () => {
    const buf = createStreamLogBuffer({ headChars: 4, tailChars: 4 });
    buf.push('');
    buf.push('ab');
    buf.push('');
    expect(buf.toString()).toBe('ab');
  });

  it('accumulates the elided count across many drops', () => {
    const buf = createStreamLogBuffer({ headChars: 4, tailChars: 4 });
    buf.push('h'.repeat(4));
    for (let i = 0; i < 5; i++) buf.push('m'.repeat(4));
    buf.push('t'.repeat(4));
    const out = buf.toString();
    expect(out.startsWith('hhhh')).toBe(true);
    expect(out.endsWith('tttt')).toBe(true);
    // five 4-char middle chunks pushed, the last of which is displaced by the tail
    expect(out).toContain('20 characters elided');
  });
});
