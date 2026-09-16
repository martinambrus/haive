import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KB_DIR, LEARNING_DRAFTS_DIR, LEARNINGS_DIR } from '@haive/shared/knowledge-paths';
import { assertEditableKnowledgeRelPath, openEditableKnowledgeFile } from './files.js';

// The write route's whole security surface: it may only overwrite an existing
// markdown file inside the knowledge trees or the draft staging dir, and it must
// reach that file through ONE descriptor — this process runs as root over a tree
// every task sandbox can write, so a path validated and then re-resolved is a
// symlink-swap window.
describe('knowledge-file write guard', () => {
  let root: string;
  let outside: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'kbedit-'));
    outside = await mkdtemp(path.join(tmpdir(), 'kbedit-out-'));
    for (const dir of [KB_DIR, LEARNINGS_DIR, `${LEARNING_DRAFTS_DIR}/learnings`, 'src']) {
      await mkdir(path.join(root, dir), { recursive: true });
    }
    await writeFile(path.join(root, KB_DIR, 'a.md'), '# a', 'utf8');
    await writeFile(path.join(root, KB_DIR, 'notes.txt'), 'x', 'utf8');
    await writeFile(path.join(root, LEARNINGS_DIR, 'b.md'), '# b', 'utf8');
    await writeFile(path.join(root, LEARNING_DRAFTS_DIR, 'learnings', 'c.md'), '# c', 'utf8');
    await writeFile(path.join(root, 'src', 'index.md'), '# code', 'utf8');
    await writeFile(path.join(outside, 'secret.md'), 'secret', 'utf8');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  const openRel = async (rel: string): Promise<void> => {
    const fh = await openEditableKnowledgeFile(root, root, path.join(root, rel));
    await fh.close();
  };

  describe('path shape', () => {
    const shape = (rel: string) => () => assertEditableKnowledgeRelPath(root, path.join(root, rel));

    it('accepts markdown under each editable tree', () => {
      expect(shape(`${KB_DIR}/a.md`)).not.toThrow();
      expect(shape(`${LEARNINGS_DIR}/b.md`)).not.toThrow();
      expect(shape(`${LEARNING_DRAFTS_DIR}/learnings/c.md`)).not.toThrow();
    });

    it('rejects a path outside the knowledge trees', () => {
      expect(shape('src/index.md')).toThrow(/knowledge-base files/i);
    });

    it('rejects a non-markdown path inside a knowledge tree', () => {
      expect(shape(`${KB_DIR}/notes.txt`)).toThrow(/markdown/i);
    });
  });

  describe('opening the file', () => {
    it('opens an existing markdown file in each editable tree', async () => {
      await expect(openRel(`${KB_DIR}/a.md`)).resolves.toBeUndefined();
      await expect(openRel(`${LEARNINGS_DIR}/b.md`)).resolves.toBeUndefined();
      await expect(openRel(`${LEARNING_DRAFTS_DIR}/learnings/c.md`)).resolves.toBeUndefined();
    });

    it('refuses to create a file that does not exist', async () => {
      await expect(openRel(`${KB_DIR}/new.md`)).rejects.toThrow(/no longer exists/i);
    });

    it('refuses a symlink even though its path passes every string check', async () => {
      await symlink(path.join(outside, 'secret.md'), path.join(root, KB_DIR, 'link.md'));
      await expect(openRel(`${KB_DIR}/link.md`)).rejects.toThrow(/symlink/i);
    });

    it('refuses a file reached through a symlinked ancestor', async () => {
      // O_NOFOLLOW only guards the final component; the anchored walk refuses
      // the linked directory itself, one component at a time.
      await symlink(outside, path.join(root, KB_DIR, 'escape'));
      await expect(openRel(`${KB_DIR}/escape/secret.md`)).rejects.toThrow(/symlink/i);
    });

    it('refuses a directory', async () => {
      await mkdir(path.join(root, KB_DIR, 'dir.md'));
      await expect(openRel(`${KB_DIR}/dir.md`)).rejects.toThrow(/not a file/i);
    });

    it('refuses a path outside the knowledge trees', async () => {
      await expect(openRel('src/index.md')).rejects.toThrow(/knowledge-base files/i);
    });
  });

  describe('anchored at the repository root', () => {
    // A worktree lives under `.haive/worktrees/`, which the sandbox and the task
    // terminal can rewrite, so the walk starts at the repository root and must
    // refuse a worktree directory that has been replaced by a link — the anchor
    // is the one component the walk follows.
    let repo: string;
    let worktree: string;

    beforeEach(async () => {
      repo = await mkdtemp(path.join(tmpdir(), 'kbedit-repo-'));
      worktree = path.join(repo, '.haive', 'worktrees', 'wt');
      await mkdir(path.join(worktree, KB_DIR), { recursive: true });
      await writeFile(path.join(worktree, KB_DIR, 'a.md'), '# a', 'utf8');
      await mkdir(path.join(outside, KB_DIR), { recursive: true });
      await writeFile(path.join(outside, KB_DIR, 'a.md'), 'elsewhere', 'utf8');
    });

    afterEach(async () => {
      await rm(repo, { recursive: true, force: true });
    });

    it('opens a worktree file through the repository anchor', async () => {
      const fh = await openEditableKnowledgeFile(
        repo,
        worktree,
        path.join(worktree, KB_DIR, 'a.md'),
      );
      await fh.close();
    });

    it('refuses the file once the worktree directory is a link', async () => {
      await rm(worktree, { recursive: true, force: true });
      await symlink(outside, worktree);
      await expect(
        openEditableKnowledgeFile(repo, worktree, path.join(worktree, KB_DIR, 'a.md')),
      ).rejects.toThrow(/symlink/i);
    });
  });
});
