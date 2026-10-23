import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { CommitDiffArtifact, CommitDiffFile } from '@haive/shared/commit-diff-artifact';
import { KB_DIR } from '@haive/shared/knowledge-paths';
import { describe, it, expect } from 'vitest';
import { gitRun } from '../../../repo/git-exec.js';
import { MAX_FILES } from './_commit-diff.js';
import {
  buildKnowledgeDiffArtifact,
  EXTERNAL_KB_DIFF_ARTIFACT_NAME,
  KB_COMMIT_DIFF_ARTIFACT_NAME,
  KNOWLEDGE_DIFF_ARTIFACT_NAME,
} from './_knowledge-diff.js';

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
  it.each([undefined, KB_COMMIT_DIFF_ARTIFACT_NAME, EXTERNAL_KB_DIFF_ARTIFACT_NAME])(
    'clears an earlier artifact on a failed git status (%s)',
    async (artifactName) => {
      const dir = await mkdtemp(path.join(tmpdir(), 'knowledge-diff-'));
      try {
        const artifactPath = path.join(dir, '.haive', artifactName ?? KNOWLEDGE_DIFF_ARTIFACT_NAME);
        await rm(artifactPath, { force: true });
        await mkdir(path.dirname(artifactPath), { recursive: true });
        await writeFile(artifactPath, JSON.stringify({ files: [extra('previous-round')] }));
        const fakeGitRun = async () => ({
          code: 128,
          stdout: '',
          stderr: 'fatal: index file corrupt',
        });

        await expect(
          buildKnowledgeDiffArtifact(dir, fakeGitRun, [], { artifactName }),
        ).rejects.toThrow(`git status failed in ${dir}: fatal: index file corrupt`);
        await expect(readFile(artifactPath)).rejects.toMatchObject({ code: 'ENOENT' });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );

  it('preserves the git status error when removing the artifact fails', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'diff-cleanup-'));
    try {
      const artifactPath = path.join(dir, '.haive', KNOWLEDGE_DIFF_ARTIFACT_NAME);
      await mkdir(artifactPath, { recursive: true });
      const child = path.join(artifactPath, 'keep.txt');
      await writeFile(child, 'non-empty directory');
      const fakeGitRun = async () => ({
        code: 128,
        stdout: '',
        stderr: 'fatal: index file corrupt',
      });

      await expect(buildKnowledgeDiffArtifact(dir, fakeGitRun)).rejects.toThrow(
        `git status failed in ${dir}: fatal: index file corrupt`,
      );
      expect(await readFile(child, 'utf8')).toBe('non-empty directory');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects a failed git status instead of reporting no changes', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'knowledge-diff-'));
    try {
      const fakeGitRun = async (_cwd: string, args: string[]) =>
        args.includes('status')
          ? { code: 128, stdout: '', stderr: 'fatal: index file corrupt' }
          : { code: 0, stdout: 'a'.repeat(40), stderr: '' };
      const built = buildKnowledgeDiffArtifact(dir, fakeGitRun).then(async (written) =>
        JSON.parse(await readFile(written, 'utf8')),
      );

      await expect(built).rejects.toThrow(`git status failed in ${dir}: fatal: index file corrupt`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

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

  it('gives no editPath to a knowledge file whose git read fails', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'knowledge-diff-'));
    try {
      await git(dir, ['init', '-b', 'main']);
      await git(dir, ['config', 'gc.auto', '0']);
      const kb = path.join(dir, KB_DIR);
      await mkdir(kb, { recursive: true });
      await writeFile(path.join(kb, 'tracked.md'), 'tracked\n');
      await git(dir, ['add', '-A']);
      await git(dir, ['commit', '-m', 'base']);
      await writeFile(path.join(kb, 'tracked.md'), 'changed\n');
      const failShow: typeof gitRun = (cwd, args) =>
        args[0] === 'show'
          ? Promise.resolve({ code: 128, stdout: '', stderr: '' })
          : gitRun(cwd, args);
      const run = async (g: typeof gitRun) =>
        (
          JSON.parse(
            await readFile(await buildKnowledgeDiffArtifact(dir, g), 'utf8'),
          ) as CommitDiffArtifact
        ).files[0];

      const broken = await run(failShow);
      expect(broken?.unreadable).toBe(true);
      expect(broken?.editPath).toBeUndefined();
      const ok = await run(gitRun);
      expect(ok?.editPath).toBe(path.join(dir, KB_DIR, 'tracked.md'));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('gives no editPath to a knowledge link, which has no text to edit', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'knowledge-diff-'));
    try {
      await git(dir, ['init', '-b', 'main']);
      await git(dir, ['config', 'gc.auto', '0']);
      const kb = path.join(dir, KB_DIR);
      await mkdir(kb, { recursive: true });
      await writeFile(path.join(kb, 'tracked.md'), 'tracked\n');
      await symlink('tracked.md', path.join(kb, 'alias.md'));
      await git(dir, ['add', '-A']);
      await git(dir, ['commit', '-m', 'base']);
      await writeFile(path.join(kb, 'tracked.md'), 'changed\n');
      await unlink(path.join(kb, 'alias.md'));
      await symlink('elsewhere.md', path.join(kb, 'alias.md'));
      const written = await buildKnowledgeDiffArtifact(dir, gitRun);
      const files = (JSON.parse(await readFile(written, 'utf8')) as CommitDiffArtifact).files;
      const byPath = new Map(files.map((f) => [f.path, f]));

      expect(byPath.get(`${KB_DIR}/alias.md`)).toMatchObject({
        link: 'symlink',
        oldContent: 'tracked.md',
        newContent: 'elsewhere.md',
      });
      expect(byPath.get(`${KB_DIR}/alias.md`)?.editPath).toBeUndefined();
      expect(byPath.get(`${KB_DIR}/tracked.md`)?.editPath).toBe(path.join(kb, 'tracked.md'));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
