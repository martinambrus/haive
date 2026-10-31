import { describe, expect, it } from 'vitest';
import { stripControlBytes } from '../src/routes/terminal.js';

describe('stripControlBytes', () => {
  it('removes 0x03 and 0x04 bytes', () => {
    const input = `hello\u0003world\u0004!`;
    expect(stripControlBytes(input)).toBe('helloworld!');
  });

  it('preserves normal input', () => {
    expect(stripControlBytes('ls -la\n')).toBe('ls -la\n');
  });

  it('handles empty string', () => {
    expect(stripControlBytes('')).toBe('');
  });

  it('drops frame consisting only of control bytes', () => {
    expect(stripControlBytes('\u0003\u0003\u0004')).toBe('');
  });
});
