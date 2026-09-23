import { describe, expect, it } from 'vitest';
import {
  attachmentCopyName,
  isReservedAttachmentName,
  reserveAttachmentDirs,
  splitAttachmentExtension,
} from './names.js';
import {
  ATTACHMENT_MAX_PATH_LENGTH,
  ATTACHMENT_MAX_SEGMENT_LENGTH,
  AttachmentPathError,
  sanitizeAttachmentPath,
} from './paths.js';

describe('isReservedAttachmentName', () => {
  it('reserves the generated indexes at the uploads root only', () => {
    expect(isReservedAttachmentName('_ATTACHMENTS.md', true)).toBe(true);
    expect(isReservedAttachmentName('_PLAN_INPUTS.md', true)).toBe(true);
    expect(isReservedAttachmentName('_ATTACHMENTS.md', false)).toBe(false);
    expect(isReservedAttachmentName('_PLAN_INPUTS.md', false)).toBe(false);
  });

  it('reserves a sidecar’s name at every depth', () => {
    expect(isReservedAttachmentName('spec.docx.extracted.md', true)).toBe(true);
    expect(isReservedAttachmentName('spec.docx.extracted.md', false)).toBe(true);
  });

  it('matches exactly, as the filesystem does', () => {
    expect(isReservedAttachmentName('_attachments.md', true)).toBe(false);
    expect(isReservedAttachmentName('spec.EXTRACTED.MD', false)).toBe(false);
    expect(isReservedAttachmentName('spec.docx', true)).toBe(false);
  });
});

describe('splitAttachmentExtension', () => {
  it('splits at the last dot', () => {
    expect(splitAttachmentExtension('spec.docx')).toEqual({ stem: 'spec', ext: '.docx' });
    expect(splitAttachmentExtension('x.docx.extracted.md')).toEqual({
      stem: 'x.docx.extracted',
      ext: '.md',
    });
  });

  it('keeps an archive’s two-part extension whole, whatever its case', () => {
    expect(splitAttachmentExtension('spec.tar.gz')).toEqual({ stem: 'spec', ext: '.tar.gz' });
    expect(splitAttachmentExtension('Spec.TAR.GZ')).toEqual({ stem: 'Spec', ext: '.TAR.GZ' });
    expect(splitAttachmentExtension('spec.tgz')).toEqual({ stem: 'spec', ext: '.tgz' });
  });

  it('gives a name with no dot past its first character no extension', () => {
    expect(splitAttachmentExtension('README')).toEqual({ stem: 'README', ext: '' });
    expect(splitAttachmentExtension('.env')).toEqual({ stem: '.env', ext: '' });
  });
});

describe('attachmentCopyName', () => {
  it('numbers a file before its extension and a folder at its end', () => {
    expect(attachmentCopyName('spec.tar.gz', 2, true)).toBe('spec (2).tar.gz');
    expect(attachmentCopyName('README', 3, true)).toBe('README (3)');
    expect(attachmentCopyName('docs.v2', 2, false)).toBe('docs.v2 (2)');
  });

  it('stays inside the segment limit, so sanitising the result changes nothing', () => {
    const long = `${'a'.repeat(ATTACHMENT_MAX_SEGMENT_LENGTH - 3)}.md`;
    for (const [name, keepExtension] of [
      [long, true],
      ['b'.repeat(ATTACHMENT_MAX_SEGMENT_LENGTH), false],
    ] as const) {
      const copy = attachmentCopyName(name, 12, keepExtension);
      expect(copy.length).toBeLessThanOrEqual(ATTACHMENT_MAX_SEGMENT_LENGTH);
      expect(sanitizeAttachmentPath(copy)).toBe(copy);
    }
    expect(attachmentCopyName(long, 2, true).endsWith(' (2).md')).toBe(true);
  });
});

describe('reserveAttachmentDirs', () => {
  it('renames a root folder a generated index would need', () => {
    expect(reserveAttachmentDirs('_ATTACHMENTS.md/a.txt')).toBe('_ATTACHMENTS.md (2)/a.txt');
    expect(reserveAttachmentDirs('_PLAN_INPUTS.md/a/b.md')).toBe('_PLAN_INPUTS.md (2)/a/b.md');
    expect(isReservedAttachmentName('_ATTACHMENTS.md (2)', true)).toBe(false);
  });

  it('renames a folder a sidecar would need, at any depth', () => {
    expect(reserveAttachmentDirs('docs/a.pdf.extracted.md/x.txt')).toBe(
      'docs/a.pdf.extracted.md (2)/x.txt',
    );
    expect(reserveAttachmentDirs('a.extracted.md/b.extracted.md/x.txt')).toBe(
      'a.extracted.md (2)/b.extracted.md (2)/x.txt',
    );
  });

  it('leaves a folder alone below the root when only the root reserves its name', () => {
    expect(reserveAttachmentDirs('docs/_ATTACHMENTS.md/x.txt')).toBe('docs/_ATTACHMENTS.md/x.txt');
  });

  it('keeps a renamed folder inside the segment limit', () => {
    const folder = `${'x'.repeat(ATTACHMENT_MAX_SEGMENT_LENGTH - 13)}.extracted.md`;
    expect(folder).toHaveLength(ATTACHMENT_MAX_SEGMENT_LENGTH);
    const [renamed] = reserveAttachmentDirs(`${folder}/a.txt`).split('/');
    expect(renamed!.length).toBeLessThanOrEqual(ATTACHMENT_MAX_SEGMENT_LENGTH);
    expect(isReservedAttachmentName(renamed!, false)).toBe(false);
    expect(sanitizeAttachmentPath(`${renamed}/a.txt`)).toBe(`${renamed}/a.txt`);
  });

  it('refuses a path the rename would take past the path limit', () => {
    const filler = 'y'.repeat(ATTACHMENT_MAX_PATH_LENGTH - '_ATTACHMENTS.md/'.length);
    const path = `_ATTACHMENTS.md/${filler}`;
    expect(path).toHaveLength(ATTACHMENT_MAX_PATH_LENGTH);
    expect(() => reserveAttachmentDirs(path)).toThrow(AttachmentPathError);
  });

  it('never touches the file itself, which its creator probes for', () => {
    expect(reserveAttachmentDirs('_ATTACHMENTS.md')).toBe('_ATTACHMENTS.md');
    expect(reserveAttachmentDirs('docs/x.docx.extracted.md')).toBe('docs/x.docx.extracted.md');
    expect(reserveAttachmentDirs('docs/api/spec.md')).toBe('docs/api/spec.md');
  });
});
