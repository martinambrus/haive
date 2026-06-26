import { describe, expect, it } from 'vitest';
import { parsePublishedPort } from './app-runner.js';

describe('parsePublishedPort', () => {
  it('parses a single IPv4 mapping', () => {
    expect(parsePublishedPort('127.0.0.1:49215')).toBe(49215);
  });

  it('takes the first non-empty line for a multi-line (v4/v6) mapping', () => {
    expect(parsePublishedPort('127.0.0.1:49215\n[::1]:49215\n')).toBe(49215);
  });

  it('tolerates leading blank lines and trailing whitespace', () => {
    expect(parsePublishedPort('\n  127.0.0.1:50001  \n')).toBe(50001);
  });

  it('returns null for empty or unparseable output', () => {
    expect(parsePublishedPort('')).toBeNull();
    expect(parsePublishedPort('\n\n')).toBeNull();
    expect(parsePublishedPort('no port here')).toBeNull();
  });
});
