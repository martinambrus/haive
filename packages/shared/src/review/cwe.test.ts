import { describe, it, expect } from 'vitest';
import { isCredentialCwe, normalizeCweId } from './cwe.js';

describe('normalizeCweId', () => {
  it('accepts the spellings reviewers actually emit', () => {
    expect(normalizeCweId('CWE-89')).toBe('CWE-89');
    expect(normalizeCweId('89')).toBe('CWE-89');
    expect(normalizeCweId('cwe_89')).toBe('CWE-89');
    expect(normalizeCweId('  cwe-089 ')).toBe('CWE-89');
    expect(normalizeCweId('CWE-798')).toBe('CWE-798');
  });

  it('refuses anything that is not an id, rather than passing it through', () => {
    // A wrong id read as a real one is worse than no id: isCredentialCwe branches on it.
    expect(normalizeCweId('n/a')).toBeNull();
    expect(normalizeCweId('')).toBeNull();
    expect(normalizeCweId('CWE-0')).toBeNull();
    expect(normalizeCweId('0')).toBeNull();
    expect(normalizeCweId('SQL injection')).toBeNull();
    expect(normalizeCweId('CWE-89 (SQL injection)')).toBeNull();
    expect(normalizeCweId(89)).toBeNull();
    expect(normalizeCweId(undefined)).toBeNull();
    expect(normalizeCweId(null)).toBeNull();
  });
});

describe('isCredentialCwe', () => {
  it('is true for the hard-coded-credential family', () => {
    expect(isCredentialCwe('CWE-798')).toBe(true);
    expect(isCredentialCwe('259')).toBe(true);
    expect(isCredentialCwe('cwe_321')).toBe(true);
    expect(isCredentialCwe('CWE-312')).toBe(true);
  });

  it('is false for weaknesses whose evidence is ordinary code', () => {
    expect(isCredentialCwe('CWE-89')).toBe(false);
    expect(isCredentialCwe('CWE-79')).toBe(false);
    expect(isCredentialCwe('CWE-22')).toBe(false);
  });

  it('is false when no id was given, so an unlabelled finding keeps its snippet', () => {
    expect(isCredentialCwe('n/a')).toBe(false);
    expect(isCredentialCwe(undefined)).toBe(false);
  });
});
