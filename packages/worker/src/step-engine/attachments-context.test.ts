import { describe, it, expect } from 'vitest';
import type { Database } from '@haive/database';
import { augmentPromptWithAttachments } from './attachments-context.js';

function mockDb(rows: Array<{ filename: string; description: string | null }>): Database {
  return {
    query: { taskAttachments: { findMany: async () => rows } },
  } as unknown as Database;
}

describe('augmentPromptWithAttachments', () => {
  it('returns the prompt unchanged when there are no attachments', async () => {
    const out = await augmentPromptWithAttachments(mockDb([]), 'task-1', 'ORIGINAL');
    expect(out).toBe('ORIGINAL');
  });

  it('prepends a notice with the container path and file list', async () => {
    const out = await augmentPromptWithAttachments(
      mockDb([
        { filename: 'spec.md', description: 'the spec' },
        { filename: 'shot.png', description: null },
      ]),
      'task-1',
      'ORIGINAL',
    );
    expect(out).toContain('/haive/workdir/.haive/task-uploads/task-1/');
    expect(out).toContain('- spec.md — the spec');
    expect(out).toContain('- shot.png');
    expect(out).toContain('_ATTACHMENTS.md');
    expect(out).toContain('2 reference file(s)');
    // The original prompt stays at the tail so the notice is pure prefix context.
    expect(out.endsWith('ORIGINAL')).toBe(true);
  });
});
