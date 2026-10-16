import { describe, expect, it } from 'vitest';
import { isCanonicalUuid, isUuid } from '../src/lib/uuid.js';

describe('isUuid', () => {
  it.each([
    '8f1c2a52-6a3e-4c1e-9d0b-5b1f0f6d7a11',
    '8F1C2A52-6A3E-4C1E-9D0B-5B1F0F6D7A11',
    '11111111-2222-3333-4444-555555555555',
    '00000000-0000-0000-0000-000000000000',
  ])('accepts %s', (value) => {
    expect(isUuid(value)).toBe(true);
  });

  it.each([
    '',
    'abc',
    '-'.repeat(36),
    'a'.repeat(36),
    '8f1c2a52-6a3e-4c1e-9d0b-5b1f0f6d7a1',
    '8f1c2a52-6a3e-4c1e-9d0b-5b1f0f6d7a111',
    '8f1c2a52-6a3e-4c1e-9d0b-5b1f0f6d7a1g',
    '8f1c2a526a3e4c1e9d0b5b1f0f6d7a11',
    '{8f1c2a52-6a3e-4c1e-9d0b-5b1f0f6d7a11}',
    ' 8f1c2a52-6a3e-4c1e-9d0b-5b1f0f6d7a11',
    '8f1c2a52-6a3e-4c1e-9d0b-5b1f0f6d7a11\n',
  ])('rejects %j', (value) => {
    expect(isUuid(value)).toBe(false);
  });
});

describe('isCanonicalUuid', () => {
  it('accepts the lowercase form and refuses an uppercase one', () => {
    expect(isCanonicalUuid('8f1c2a52-6a3e-4c1e-9d0b-5b1f0f6d7a11')).toBe(true);
    expect(isCanonicalUuid('8F1C2A52-6A3E-4C1E-9D0B-5B1F0F6D7A11')).toBe(false);
    expect(isCanonicalUuid('abc')).toBe(false);
  });
});
