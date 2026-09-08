import { describe, expect, it } from 'vitest';
import { checksum, normalizeForChecksum } from './checksum.js';

describe('normalizeForChecksum', () => {
  // The repo has no .gitattributes, so a checkout with core.autocrlf=true rewrites every .sql
  // file's line endings. Hashing raw bytes would then mismatch ALL of them at once and hard-fail
  // the install with a message blaming tampering.
  it('folds CRLF to LF', () => {
    expect(checksum('a\r\nb\r\n')).toBe(checksum('a\nb\n'));
  });

  it('strips a UTF-8 BOM', () => {
    expect(checksum('﻿SELECT 1;')).toBe(checksum('SELECT 1;'));
  });

  it('leaves everything else alone, because a changed comment IS a change', () => {
    expect(normalizeForChecksum('-- one\n\n  SELECT  1;')).toBe('-- one\n\n  SELECT  1;');
    expect(checksum('-- a\nSELECT 1;')).not.toBe(checksum('-- b\nSELECT 1;'));
  });
});

describe('checksum', () => {
  it('is lowercase sha256 hex', () => {
    expect(checksum('SELECT 1;')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('differs on a one-character change', () => {
    expect(checksum('SELECT 1;')).not.toBe(checksum('SELECT 2;'));
  });
});
