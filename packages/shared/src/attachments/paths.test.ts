import { describe, it, expect } from 'vitest';
import {
  ATTACHMENT_MAX_PATH_DEPTH,
  AttachmentPathError,
  sanitizeAttachmentPath,
  sanitizeAttachmentSegment,
  splitAttachmentPath,
} from './paths.js';

describe('sanitizeAttachmentPath', () => {
  it('keeps the directory structure a folder upload sends', () => {
    expect(sanitizeAttachmentPath('docs/api/spec.md')).toBe('docs/api/spec.md');
    expect(sanitizeAttachmentPath('docs\\api\\spec.md')).toBe('docs/api/spec.md');
  });

  it('refuses a parent-directory segment rather than dropping it', () => {
    expect(() => sanitizeAttachmentPath('../../etc/passwd')).toThrow(AttachmentPathError);
    expect(() => sanitizeAttachmentPath('docs/../../etc/passwd')).toThrow(AttachmentPathError);
  });

  it('drops an absolute prefix and empty or dot segments', () => {
    expect(sanitizeAttachmentPath('/etc/passwd')).toBe('etc/passwd');
    expect(sanitizeAttachmentPath('docs//./api/spec.md')).toBe('docs/api/spec.md');
  });

  it('strips leading dots and control characters in every segment', () => {
    expect(sanitizeAttachmentPath('.htaccess')).toBe('htaccess');
    expect(sanitizeAttachmentPath('.ssh/id_rsa')).toBe('ssh/id_rsa');
    expect(sanitizeAttachmentPath('e' + String.fromCharCode(0) + '.sh')).toBe('e_.sh');
  });

  it('keeps spaces, parentheses, dots and hyphens', () => {
    expect(sanitizeAttachmentPath('my report (final)-v2.png')).toBe('my report (final)-v2.png');
    expect(sanitizeAttachmentPath('specs v2/my report (final).png')).toBe(
      'specs v2/my report (final).png',
    );
  });

  it('falls back to "file" for empty or separator-only input', () => {
    expect(sanitizeAttachmentPath('')).toBe('file');
    expect(sanitizeAttachmentPath('///')).toBe('file');
    expect(sanitizeAttachmentPath('...')).toBe('file');
  });

  it('refuses a path nested deeper than the cap', () => {
    const ok = `${Array.from({ length: ATTACHMENT_MAX_PATH_DEPTH }, (_, i) => `d${i}`).join('/')}/f.txt`;
    expect(sanitizeAttachmentPath(ok)).toBe(ok);
    expect(() => sanitizeAttachmentPath(`extra/${ok}`)).toThrow(AttachmentPathError);
  });

  it('refuses a path longer than the cap', () => {
    expect(() => sanitizeAttachmentPath(`${'a'.repeat(200)}/${'b'.repeat(201)}`)).toThrow(
      AttachmentPathError,
    );
  });
});

describe('sanitizeAttachmentSegment', () => {
  it('returns empty for a segment that is nothing but dots', () => {
    expect(sanitizeAttachmentSegment('...')).toBe('');
  });
});

describe('splitAttachmentPath', () => {
  it('splits on the last separator, with a root file having no directory', () => {
    expect(splitAttachmentPath('docs/api/spec.md')).toEqual({ dir: 'docs/api', base: 'spec.md' });
    expect(splitAttachmentPath('spec.md')).toEqual({ dir: '', base: 'spec.md' });
  });
});
