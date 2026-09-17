import { describe, expect, it } from 'vitest';
import {
  attachmentUploadsRoot,
  splitAttachmentStoredPath,
  taskUploadsRel,
} from '../src/attachments/paths.js';

const REPO = '/var/lib/haive/repos/u1/r1';
const TASK = 't1';
const row = (filename: string, storedPath?: string) => ({
  filename,
  storedPath: storedPath ?? `${REPO}/${taskUploadsRel(TASK)}/${filename}`,
});

// These two helpers return DIFFERENT directories and are the easiest pair in the codebase to
// confuse: one answers "where does this row's tree live", the other "what may be used as a
// containment anchor". The uploads dir is never the second, because it sits inside `.haive/`, which
// the cli-exec sandbox mounts read-write.
describe('attachment path anchors', () => {
  it('splits a stored path into the repository root and the rel below it', () => {
    expect(splitAttachmentStoredPath(row('spec.md'), TASK)).toEqual({
      anchor: REPO,
      uploadsRel: '.haive/task-uploads/t1',
      rel: '.haive/task-uploads/t1/spec.md',
    });
  });

  it('keeps a nested folder-upload name whole', () => {
    expect(splitAttachmentStoredPath(row('docs/api/spec.md'), TASK)?.rel).toBe(
      '.haive/task-uploads/t1/docs/api/spec.md',
    );
  });

  it('answers null rather than guessing an anchor', () => {
    // A legacy row, or one written by something else: the suffix the api writes is absent.
    expect(
      splitAttachmentStoredPath({ filename: 'a.md', storedPath: '/tmp/a.md' }, TASK),
    ).toBeNull();
    // Right shape, wrong task — the taskId is part of the suffix on purpose.
    expect(splitAttachmentStoredPath(row('a.md'), 'other-task')).toBeNull();
    // Nothing left over once the suffix is removed, so there is no root to anchor on.
    expect(
      splitAttachmentStoredPath(
        { filename: 'a.md', storedPath: `/${taskUploadsRel(TASK)}/a.md` },
        TASK,
      ),
    ).toBeNull();
  });

  it('is not interchangeable with attachmentUploadsRoot', () => {
    const r = row('docs/spec.md');
    // The uploads DIRECTORY — inside `.haive/`, so never an anchor. It strips the WHOLE filename,
    // nested folders included, so this is the uploads dir rather than the file's own parent.
    expect(attachmentUploadsRoot(r)).toBe(`${REPO}/.haive/task-uploads/t1`);
    // The repository ROOT.
    expect(splitAttachmentStoredPath(r, TASK)?.anchor).toBe(REPO);
  });
});
