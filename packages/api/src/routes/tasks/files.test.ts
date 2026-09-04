import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KB_DIR, LEARNING_DRAFTS_DIR, LEARNINGS_DIR } from '@haive/shared/knowledge-paths';
import { assertEditableKnowledgePath } from './files.js';

// The write route's whole security surface: it may only overwrite an existing
// markdown file inside the knowledge trees or the draft staging dir.
describe('assertEditableKnowledgePath', () => {
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

  const check = (rel: string) => assertEditableKnowledgePath(root, path.join(root, rel));

  it('accepts an existing markdown file in each editable tree', async () => {
    await expect(check(`${KB_DIR}/a.md`)).resolves.toBeUndefined();
    await expect(check(`${LEARNINGS_DIR}/b.md`)).resolves.toBeUndefined();
    await expect(check(`${LEARNING_DRAFTS_DIR}/learnings/c.md`)).resolves.toBeUndefined();
  });

  it('rejects a file outside the knowledge trees', async () => {
    await expect(check('src/index.md')).rejects.toThrow(/knowledge-base files/i);
  });

  it('rejects a non-markdown file inside a knowledge tree', async () => {
    await expect(check(`${KB_DIR}/notes.txt`)).rejects.toThrow(/markdown/i);
  });

  it('refuses to create a file that does not exist', async () => {
    await expect(check(`${KB_DIR}/new.md`)).rejects.toThrow(/no longer exists/i);
  });

  it('rejects a symlink that points out of the workspace', async () => {
    await symlink(path.join(outside, 'secret.md'), path.join(root, KB_DIR, 'link.md'));
    await expect(check(`${KB_DIR}/link.md`)).rejects.toThrow(/symlink/i);
  });

  it('rejects a file reached through a symlinked ancestor', async () => {
    await symlink(outside, path.join(root, KB_DIR, 'escape'));
    await expect(check(`${KB_DIR}/escape/secret.md`)).rejects.toThrow(
      /outside the task workspace/i,
    );
  });

  it('rejects a directory', async () => {
    await mkdir(path.join(root, KB_DIR, 'dir.md'));
    await expect(check(`${KB_DIR}/dir.md`)).rejects.toThrow(/not a file/i);
  });
});
