import { describe, expect, it } from 'vitest';
import { generateTemporaryPassword } from '../src/routes/admin.js';

describe('generateTemporaryPassword', () => {
  it('produces a string of the requested length', () => {
    for (const len of [12, 16, 24, 32, 48]) {
      const pw = generateTemporaryPassword(len);
      expect(pw).toHaveLength(len);
    }
  });

  it('defaults to a 24-character password when length is omitted', () => {
    expect(generateTemporaryPassword()).toHaveLength(24);
  });

  it('rejects lengths shorter than 12', () => {
    expect(() => generateTemporaryPassword(11)).toThrow(/>= 12/);
    expect(() => generateTemporaryPassword(0)).toThrow(/>= 12/);
  });

  it('uses only characters from the safe alphabet', () => {
    const pw = generateTemporaryPassword(64);
    const allowed = /^[A-HJ-NP-Za-km-z2-9!@#$%^&*]+$/;
    expect(pw).toMatch(allowed);
  });

  it('does not include visually ambiguous characters (0/O, 1/l/I)', () => {
    const pw = generateTemporaryPassword(256);
    expect(pw).not.toMatch(/[0OIl1]/);
  });

  it('returns different values on successive calls (probabilistically unique)', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i += 1) {
      seen.add(generateTemporaryPassword(24));
    }
    expect(seen.size).toBe(50);
  });
});
