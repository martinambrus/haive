import { describe, expect, it } from 'vitest';
import {
  isReservedAttachmentName,
  reserveAttachmentDirs,
  splitAttachmentExtension,
} from './names.js';

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

  it('never touches the file itself, which its creator probes for', () => {
    expect(reserveAttachmentDirs('_ATTACHMENTS.md')).toBe('_ATTACHMENTS.md');
    expect(reserveAttachmentDirs('docs/x.docx.extracted.md')).toBe('docs/x.docx.extracted.md');
    expect(reserveAttachmentDirs('docs/api/spec.md')).toBe('docs/api/spec.md');
  });
});
