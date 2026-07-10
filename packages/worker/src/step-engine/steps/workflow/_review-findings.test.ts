import { describe, it, expect } from 'vitest';
import { findingFingerprint, parseLineRange, splitLocation } from './_review-findings.js';

describe('findingFingerprint', () => {
  it('hashes the same defect equal after line numbers move', () => {
    const a = findingFingerprint('peer-reviewer', 'src/a.ts', 'Null deref at line 42');
    const b = findingFingerprint('peer-reviewer', 'src/a.ts', 'Null deref at line 87');
    expect(a).toBe(b);
  });

  it('keeps the path as part of the identity', () => {
    // Unlike fixLoopFingerprint, which strips paths out of a prose diagnosis: the
    // same defect in two files is two findings.
    const a = findingFingerprint('peer-reviewer', 'src/a.ts', 'null deref');
    const b = findingFingerprint('peer-reviewer', 'src/b.ts', 'null deref');
    expect(a).not.toBe(b);
  });

  it('namespaces by reviewer, so two reviewers naming the same issue do not collide', () => {
    const peer = findingFingerprint('peer-reviewer', 'src/a.ts', 'unsanitised input');
    const sec = findingFingerprint('security-code-reviewer', 'src/a.ts', 'unsanitised input');
    expect(peer).not.toBe(sec);
  });

  it('is insensitive to case, whitespace and embedded uuids', () => {
    const a = findingFingerprint('peer-reviewer', 'src/a.ts', 'Null   Deref');
    const b = findingFingerprint('peer-reviewer', 'SRC/A.TS', 'null deref');
    expect(a).toBe(b);
    const withUuid = findingFingerprint(
      'peer-reviewer',
      'src/a.ts',
      'task 3f2504e0-4f89-11d3-9a0c-0305e82c3301 failed',
    );
    const withoutUuid = findingFingerprint('peer-reviewer', 'src/a.ts', 'task  failed');
    expect(withUuid).toBe(withoutUuid);
  });

  it('fits the fingerprint column', () => {
    expect(findingFingerprint('peer-reviewer', 'a.ts', 'x').length).toBeLessThanOrEqual(64);
  });
});

describe('parseLineRange', () => {
  it('reads a single line, a range, and a number', () => {
    expect(parseLineRange('12')).toEqual({ start: 12, end: 12 });
    expect(parseLineRange('12-18')).toEqual({ start: 12, end: 18 });
    expect(parseLineRange(7)).toEqual({ start: 7, end: 7 });
  });

  it('yields nulls when absent or unparseable', () => {
    expect(parseLineRange(undefined)).toEqual({ start: null, end: null });
    expect(parseLineRange(null)).toEqual({ start: null, end: null });
    expect(parseLineRange('somewhere near the top')).toEqual({ start: null, end: null });
  });
});

describe('splitLocation', () => {
  it('splits path:line and path:line:col', () => {
    expect(splitLocation('src/a.ts:42')).toEqual({ path: 'src/a.ts', lines: '42' });
    expect(splitLocation('src/a.ts:42:7')).toEqual({ path: 'src/a.ts', lines: '42' });
    expect(splitLocation('src/a.ts:12-18')).toEqual({ path: 'src/a.ts', lines: '12-18' });
  });

  it('leaves a bare path alone', () => {
    expect(splitLocation('src/a.ts')).toEqual({ path: 'src/a.ts', lines: null });
  });

  it('keeps a URL whole — 08d reports runtime findings by URL, not file', () => {
    expect(splitLocation('https://app.ddev.site:8443/admin')).toEqual({
      path: 'https://app.ddev.site:8443/admin',
      lines: null,
    });
  });

  it('handles absent locations', () => {
    expect(splitLocation(undefined)).toEqual({ path: '', lines: null });
    expect(splitLocation('')).toEqual({ path: '', lines: null });
  });
});
