import { describe, expect, it } from 'vitest';
import { archiveStem, detectAttachmentArchiveFormat } from './archive.js';

describe('detectAttachmentArchiveFormat', () => {
  it('recognises the four archive extensions, whatever their case', () => {
    expect(detectAttachmentArchiveFormat('spec.zip')).toBe('zip');
    expect(detectAttachmentArchiveFormat('spec.TAR')).toBe('tar');
    expect(detectAttachmentArchiveFormat('spec.tar.gz')).toBe('tar.gz');
    expect(detectAttachmentArchiveFormat('spec.Tgz')).toBe('tar.gz');
  });

  it('recognises a de-duped second copy, whose extension stayed whole', () => {
    expect(detectAttachmentArchiveFormat('spec (2).tar.gz')).toBe('tar.gz');
    expect(detectAttachmentArchiveFormat('docs/spec (2).zip')).toBe('zip');
  });

  it('refuses what the worker cannot open', () => {
    expect(detectAttachmentArchiveFormat('spec.gz')).toBeNull();
    expect(detectAttachmentArchiveFormat('spec.tar (2).gz')).toBeNull();
    expect(detectAttachmentArchiveFormat('zip')).toBeNull();
  });
});

describe('archiveStem', () => {
  it('drops the whole archive extension', () => {
    expect(archiveStem('spec.tar.gz')).toBe('spec');
    expect(archiveStem('spec.TGZ')).toBe('spec');
    expect(archiveStem('spec (2).zip')).toBe('spec (2)');
  });

  it('leaves a name that is not an archive as it is', () => {
    expect(archiveStem('spec.gz')).toBe('spec.gz');
  });
});
