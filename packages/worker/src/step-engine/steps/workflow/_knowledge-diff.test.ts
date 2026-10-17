import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { KB_DIR } from '@haive/shared/knowledge-paths';
import { describe, it, expect } from 'vitest';
import { gitRun } from '../../../repo/git-exec.js';
import { type CommitDiffArtifact, type CommitDiffFile, MAX_FILES } from './_commit-diff.js';
import { buildKnowledgeDiffArtifact } from './_knowledge-diff.js';

const exec = promisify(execFile);
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@haive.local',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@haive.local',
};
const git = (dir: string, args: string[]) => exec('git', args, { cwd: dir, env: GIT_ENV });

const extra = (name: string): CommitDiffFile => ({
  path: `.haive-data/learnings/${name}.md`,
  status: 'added',
  binary: false,
  truncated: false,
  oldContent: '',
  newContent: `${name}\n`,
});

async function artifactFor(untracked: number): Promise<CommitDiffArtifact> {
  const dir = await mkdtemp(path.join(tmpdir(), 'knowledge-diff-'));
  try {
    await git(dir, ['init', '-b', 'main']);
    await git(dir, ['config', 'gc.auto', '0']);
    const kb = path.join(dir, KB_DIR);
    await mkdir(kb, { recursive: true });
    await writeFile(path.join(kb, 'tracked.md'), 'tracked\n');
    await git(dir, ['add', '-A']);
    await git(dir, ['commit', '-m', 'base']);
    for (let i = 0; i < untracked; i++) {
      await writeFile(path.join(kb, `entry-${String(i).padStart(4, '0')}.md`), `entry ${i}\n`);
    }
    const written = await buildKnowledgeDiffArtifact(dir, gitRun, [extra('a'), extra('b')]);
    return JSON.parse(await readFile(written, 'utf8')) as CommitDiffArtifact;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('buildKnowledgeDiffArtifact', () => {
  it('reports the real count and truncated when the git list is cut', async () => {
    const artifact = await artifactFor(MAX_FILES + 1);

    expect(artifact.truncated).toBe(true);
    expect(artifact.fileCount).toBe(MAX_FILES + 1 + 2);
    expect(artifact.files.length).toBe(MAX_FILES + 2);
  });

  it('reports truncated false when the git list is exactly the cap', async () => {
    const artifact = await artifactFor(MAX_FILES);

    expect(artifact.truncated).toBe(false);
    expect(artifact.fileCount).toBe(MAX_FILES + 2);
    expect(artifact.files.length).toBe(MAX_FILES + 2);
  });

  it('lists the files inside a new directory one by one', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'knowledge-diff-'));
    try {
      await git(dir, ['init', '-b', 'main']);
      await git(dir, ['config', 'gc.auto', '0']);
      const kb = path.join(dir, KB_DIR);
      await mkdir(kb, { recursive: true });
      await writeFile(path.join(kb, 'tracked.md'), 'tracked\n');
      await git(dir, ['add', '-A']);
      await git(dir, ['commit', '-m', 'base']);
      await mkdir(path.join(kb, 'new-topic'));
      await writeFile(path.join(kb, 'new-topic', 'one.md'), 'one\n');
      await writeFile(path.join(kb, 'new-topic', 'two.md'), 'two\n');
      const written = await buildKnowledgeDiffArtifact(dir, gitRun, [extra('a'), extra('b')]);
      const artifact = JSON.parse(await readFile(written, 'utf8')) as CommitDiffArtifact;

      expect(artifact.fileCount).toBe(4);
      expect(artifact.files.length).toBe(4);
      expect(artifact.truncated).toBe(false);
      for (const [name, text] of [
        ['one.md', 'one\n'],
        ['two.md', 'two\n'],
      ]) {
        const entryPath = `${KB_DIR}/new-topic/${name}`;
        const file = artifact.files.find((f) => f.path === entryPath);
        expect(file?.status).toBe('added');
        expect(file?.newContent).toBe(text);
        expect(file?.editPath).toBe(path.join(dir, entryPath));
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
