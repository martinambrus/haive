import { describe, expect, it } from 'vitest';
import type { TaskAttachment } from './api-client';
import { deleteAttachmentConfirmation, deleteFolderConfirmation } from './attachment-delete';

const row = (
  id: string,
  filename: string,
  expandedFromId: string | null = null,
): TaskAttachment => ({
  id,
  taskId: 't',
  filename,
  sizeBytes: 1,
  contentType: null,
  description: null,
  createdAt: '2026-09-23T12:00:00.000Z',
  expandedAt: null,
  expansionNote: null,
  expandedFromId,
});

const items = [
  row('zip', 'spec.zip'),
  row('a', 'spec/a.md', 'zip'),
  row('b', 'spec/sub/b.md', 'zip'),
  row('d', 'docs/readme.md'),
];

describe('deleteAttachmentConfirmation', () => {
  it('says nothing more while another file of the archive remains', () => {
    expect(deleteAttachmentConfirmation(items, 'a')).toBe(
      'Remove this attachment? The agent will no longer see it.',
    );
  });

  it('names the archive when this is the last file extracted from it', () => {
    expect(deleteAttachmentConfirmation(items.slice(0, 2), 'a')).toBe(
      'Remove this attachment? The agent will no longer see it. spec.zip, which it was extracted from, is removed with it.',
    );
  });
});

describe('deleteFolderConfirmation', () => {
  it('names the archive a folder holds every extracted file of', () => {
    expect(deleteFolderConfirmation(items, 'spec')).toBe(
      'Remove the folder "spec" and all 2 file(s) in it? This also removes spec.zip.',
    );
  });

  it('says nothing more for a folder that is not an archive’s', () => {
    expect(deleteFolderConfirmation(items, 'docs')).toBe(
      'Remove the folder "docs" and all 1 file(s) in it?',
    );
  });
});
