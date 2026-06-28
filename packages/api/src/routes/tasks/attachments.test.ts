import { describe, it, expect } from 'vitest';
import { sanitizeAttachmentFilename } from './attachments.js';

describe('sanitizeAttachmentFilename', () => {
  it('reduces path traversal to a basename', () => {
    expect(sanitizeAttachmentFilename('../../etc/passwd')).toBe('passwd');
    expect(sanitizeAttachmentFilename('a/b/c.txt')).toBe('c.txt');
    expect(sanitizeAttachmentFilename('a\\b\\c.txt')).toBe('c.txt');
  });

  it('strips leading dots and control characters', () => {
    expect(sanitizeAttachmentFilename('.htaccess')).toBe('htaccess');
    expect(sanitizeAttachmentFilename('e' + String.fromCharCode(0) + '.sh')).toBe('e_.sh');
  });

  it('keeps spaces, parentheses, dots and hyphens', () => {
    expect(sanitizeAttachmentFilename('my report (final)-v2.png')).toBe('my report (final)-v2.png');
  });

  it('falls back to "file" for empty or separator-only input', () => {
    expect(sanitizeAttachmentFilename('')).toBe('file');
    expect(sanitizeAttachmentFilename('///')).toBe('file');
  });
});
