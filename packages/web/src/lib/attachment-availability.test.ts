import { describe, expect, it } from 'vitest';
import { repoSourceSchema } from '@haive/shared/schemas';
import { attachmentUnavailableNote } from './attachment-availability';

const NOTE = 'This repository is imported read-only, so files cannot be attached.';

describe('attachmentUnavailableNote', () => {
  it('names a read-only local repository', () => {
    expect(attachmentUnavailableNote({ source: 'local_path', writable: false })).toBe(NOTE);
    expect(attachmentUnavailableNote({ source: 'local_path' })).toBe(NOTE);
    expect(attachmentUnavailableNote({ source: 'local_path', writable: null })).toBe(NOTE);
  });

  it('is silent for everything that takes attachments', () => {
    expect(attachmentUnavailableNote({ source: 'local_path', writable: true })).toBeNull();
    for (const source of repoSourceSchema.options.filter((s) => s !== 'local_path')) {
      expect(attachmentUnavailableNote({ source, writable: false })).toBeNull();
    }
    expect(attachmentUnavailableNote(null)).toBeNull();
    expect(attachmentUnavailableNote(undefined)).toBeNull();
  });
});
