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

  it('collapses a large folder to a counted line and states the elision', async () => {
    const rows = [
      { filename: 'brief.md', description: null },
      ...Array.from({ length: 120 }, (_, i) => ({
        filename: `docs/section-${i}/page.md`,
        description: null,
      })),
      ...Array.from({ length: 5 }, (_, i) => ({ filename: `shots/s${i}.png`, description: null })),
    ];
    const out = await augmentPromptWithAttachments(mockDb(rows), 'task-1', 'ORIGINAL');

    expect(out).toContain('- brief.md');
    expect(out).toContain('- docs/ — 120 file(s)');
    expect(out).toContain('- shots/ — 5 file(s)');
    expect(out).not.toContain('docs/section-3/page.md');
    // The cap is disclosed, not silent: a short list nobody explained reads as
    // the whole set.
    expect(out).toContain('COVERAGE: the list above names 1 of 126 attached files');
  });

  it('leaves a list under the limit exactly as it was', async () => {
    const rows = Array.from({ length: 40 }, (_, i) => ({
      filename: `docs/f${i}.md`,
      description: null,
    }));
    const out = await augmentPromptWithAttachments(mockDb(rows), 'task-1', 'ORIGINAL');
    expect(out).toContain('- docs/f39.md');
    expect(out).not.toContain('COVERAGE:');
  });
});
