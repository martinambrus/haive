import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type {
  CommitDiffArtifact as SharedCommitDiffArtifact,
  CommitDiffFile as SharedCommitDiffFile,
} from '@haive/shared/commit-diff-artifact';
import { describe, it, expect, expectTypeOf } from 'vitest';
import { gitRun } from '../../../repo/git-exec.js';
import {
  buildCommitDiffArtifact,
  buildFileEntry,
  COMMIT_DIFF_ARTIFACT_NAME,
  parsePorcelainZ,
} from './_commit-diff.js';

const exec = promisify(execFile);
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@haive.local',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@haive.local',
};
const git = (dir: string, args: string[]) => exec('git', args, { cwd: dir, env: GIT_ENV });

describe('buildCommitDiffArtifact', () => {
  it('clears an earlier artifact on a failed git status', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'commit-diff-'));
    try {
      const artifactPath = path.join(dir, '.haive', COMMIT_DIFF_ARTIFACT_NAME);
      await rm(artifactPath, { force: true });
      await mkdir(path.dirname(artifactPath), { recursive: true });
      await writeFile(artifactPath, JSON.stringify({ files: [{ path: 'previous-round.md' }] }));
      const fakeGitRun = async () => ({
        code: 128,
        stdout: '',
        stderr: 'fatal: index file corrupt',
      });

      await expect(buildCommitDiffArtifact(dir, fakeGitRun)).rejects.toThrow(
        `git status failed in ${dir}: fatal: index file corrupt`,
      );
      await expect(readFile(artifactPath)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('preserves the git status error when removing the artifact fails', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'diff-cleanup-'));
    try {
      const artifactPath = path.join(dir, '.haive', COMMIT_DIFF_ARTIFACT_NAME);
      await mkdir(artifactPath, { recursive: true });
      const child = path.join(artifactPath, 'keep.txt');
      await writeFile(child, 'non-empty directory');
      const fakeGitRun = async () => ({
        code: 128,
        stdout: '',
        stderr: 'fatal: index file corrupt',
      });

      await expect(buildCommitDiffArtifact(dir, fakeGitRun)).rejects.toThrow(
        `git status failed in ${dir}: fatal: index file corrupt`,
      );
      expect(await readFile(child, 'utf8')).toBe('non-empty directory');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects a failed git status instead of reporting no changes', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'commit-diff-'));
    try {
      const fakeGitRun = async (_cwd: string, args: string[]) =>
        args.includes('status')
          ? { code: 128, stdout: '', stderr: 'fatal: index file corrupt' }
          : { code: 0, stdout: 'a'.repeat(40), stderr: '' };

      await expect(buildCommitDiffArtifact(dir, fakeGitRun)).rejects.toThrow(
        `git status failed in ${dir}: fatal: index file corrupt`,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('parsePorcelainZ', () => {
  it('reads a plain, an untracked and a deleted record', () => {
    expect(parsePorcelainZ(' M a.php\0?? b.php\0 D c.php\0')).toEqual([
      { x: ' ', y: 'M', path: 'a.php' },
      { x: '?', y: '?', path: 'b.php' },
      { x: ' ', y: 'D', path: 'c.php' },
    ]);
  });

  it.each(['R ', 'RM', ' R', 'C ', ' C'])(
    'reads the %j record as a destination and its source, and the record after them',
    (xy) => {
      const out = `${xy} new.php\0old.php\0?? other.php\0`;

      expect(parsePorcelainZ(out)).toEqual([
        { x: xy[0], y: xy[1], path: 'new.php', oldPath: 'old.php' },
        { x: '?', y: '?', path: 'other.php' },
      ]);
    },
  );

  it('reads the rename git reports in the worktree column for an intent-to-add file', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'porcelain-'));
    try {
      await git(dir, ['init', '-b', 'main']);
      await git(dir, ['config', 'gc.auto', '0']);
      await writeFile(path.join(dir, 'old.php'), 'one\ntwo\n');
      await git(dir, ['add', '-A']);
      await git(dir, ['commit', '-m', 'base']);
      await rename(path.join(dir, 'old.php'), path.join(dir, 'new.php'));
      await git(dir, ['add', '-N', 'new.php']);

      const status = await git(dir, ['status', '--porcelain', '-z', '-uall']);

      expect(parsePorcelainZ(status.stdout)).toEqual([
        { x: ' ', y: 'R', path: 'new.php', oldPath: 'old.php' },
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('reads the rename git reports in the index column for a moved file', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'porcelain-'));
    try {
      await git(dir, ['init', '-b', 'main']);
      await git(dir, ['config', 'gc.auto', '0']);
      await writeFile(path.join(dir, 'old.php'), 'one\ntwo\n');
      await git(dir, ['add', '-A']);
      await git(dir, ['commit', '-m', 'base']);
      await git(dir, ['mv', 'old.php', 'new.php']);

      const status = await git(dir, ['status', '--porcelain', '-z', '-uall']);

      expect(parsePorcelainZ(status.stdout)).toEqual([
        { x: 'R', y: ' ', path: 'new.php', oldPath: 'old.php' },
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('the gate-3 diff entry for a moved file', () => {
  const OLD = Array.from({ length: 12 }, (_, i) => `line ${i + 1} of the original file\n`).join('');
  const NEW = `${OLD}one more line\n`;
  const MOVED = {
    path: 'new.php',
    oldPath: 'old.php',
    status: 'renamed',
    binary: false,
    truncated: false,
    oldContent: OLD,
    newContent: NEW,
  };

  async function inRepo<T>(act: (dir: string) => Promise<T>): Promise<T> {
    const dir = await mkdtemp(path.join(tmpdir(), 'commit-diff-'));
    try {
      await git(dir, ['init', '-b', 'main']);
      await git(dir, ['config', 'gc.auto', '0']);
      await writeFile(path.join(dir, 'old.php'), OLD);
      await git(dir, ['add', '-A']);
      await git(dir, ['commit', '-m', 'base']);
      return await act(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  it.each([
    [
      ' R',
      async (dir: string) => {
        await rename(path.join(dir, 'old.php'), path.join(dir, 'new.php'));
        await writeFile(path.join(dir, 'new.php'), NEW);
        await git(dir, ['add', '-N', 'new.php']);
      },
    ],
    [
      'RM',
      async (dir: string) => {
        await git(dir, ['mv', 'old.php', 'new.php']);
        await writeFile(path.join(dir, 'new.php'), NEW);
      },
    ],
  ])('records the %j rename git reports as a rename, with both sides', async (xy, move) => {
    const { reported, built } = await inRepo(async (dir) => {
      await move(dir);
      const status = await git(dir, ['status', '--porcelain', '-z', '-uall']);
      return {
        reported: status.stdout.slice(0, 2),
        built: await buildCommitDiffArtifact(dir, gitRun),
      };
    });

    expect(reported).toBe(xy);
    expect(built.artifact.files).toEqual([MOVED]);
    expect(built.changedFileCount).toBe(1);
  });

  it.each(['R ', ' R', 'C ', ' C'])(
    'reads a %j entry as a move from its source, whichever column holds the letter',
    async (xy) => {
      const file = await inRepo(async (dir) => {
        await writeFile(path.join(dir, 'new.php'), NEW);
        const entry = { x: xy.charAt(0), y: xy.charAt(1), path: 'new.php', oldPath: 'old.php' };
        return buildFileEntry(dir, gitRun, entry, 1_000_000);
      });

      expect(file).toEqual(MOVED);
    },
  );
});

describe('an unreadable side of a changed file', () => {
  const failing =
    (sub: string): typeof gitRun =>
    (cwd, args) =>
      args[0] === sub ? Promise.resolve({ code: 128, stdout: '', stderr: '' }) : gitRun(cwd, args);

  async function repo(act: (dir: string) => Promise<void>): Promise<void> {
    const dir = await mkdtemp(path.join(tmpdir(), 'commit-diff-'));
    try {
      await git(dir, ['init', '-b', 'main']);
      await git(dir, ['config', 'gc.auto', '0']);
      await writeFile(path.join(dir, 'a.txt'), 'original\n');
      await writeFile(path.join(dir, 'old.php'), 'moved\n');
      await writeFile(path.join(dir, 'gone.txt'), 'deleted\n');
      await git(dir, ['add', '-A']);
      await git(dir, ['commit', '-m', 'base']);
      await act(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  it.each(['show', 'cat-file'])(
    'flags a file whose git %s fails, with both sides empty',
    async (sub) => {
      await repo(async (dir) => {
        await writeFile(path.join(dir, 'a.txt'), 'changed\n');
        await writeFile(path.join(dir, 'new.php'), 'moved\n');
        await rm(path.join(dir, 'gone.txt'));
        const entries = [
          { x: ' ', y: 'M', path: 'a.txt' },
          { x: ' ', y: 'D', path: 'gone.txt' },
          { x: 'R', y: ' ', path: 'new.php', oldPath: 'old.php' },
        ];
        for (const entry of entries) {
          const file = await buildFileEntry(dir, failing(sub), entry, 1_000_000);
          expect(file.unreadable).toBe(true);
          expect(file.oldContent).toBe('');
          expect(file.newContent).toBe('');
        }
      });
    },
  );

  it('flags a tracked file replaced by a link and an untracked link', async () => {
    await repo(async (dir) => {
      await unlink(path.join(dir, 'a.txt'));
      await symlink('old.php', path.join(dir, 'a.txt'));
      await symlink('old.php', path.join(dir, 'untracked-link'));
      const built = await buildCommitDiffArtifact(dir, gitRun);
      const byPath = new Map(built.artifact.files.map((f) => [f.path, f]));

      expect(byPath.get('a.txt')?.unreadable).toBe(true);
      expect(byPath.get('untracked-link')?.unreadable).toBe(true);
    });
  });

  it('leaves the flag off a readable modified file and a zero-byte added file', async () => {
    await repo(async (dir) => {
      await writeFile(path.join(dir, 'a.txt'), 'changed\n');
      await writeFile(path.join(dir, 'empty.txt'), '');
      const built = await buildCommitDiffArtifact(dir, gitRun);

      expect(built.artifact.files).toHaveLength(2);
      for (const file of built.artifact.files) expect('unreadable' in file).toBe(false);
    });
  });

  it('carries the flag into the written artifact', async () => {
    await repo(async (dir) => {
      await writeFile(path.join(dir, 'a.txt'), 'changed\n');
      const built = await buildCommitDiffArtifact(dir, failing('show'));
      const written = JSON.parse(await readFile(built.artifactPath, 'utf8'));

      expect(written.fileCount).toBe(1);
      expect(written.files[0].unreadable).toBe(true);
    });
  });
});

describe('the artifact types', () => {
  it('are the ones @haive/shared declares', () => {
    expectTypeOf<
      Awaited<ReturnType<typeof buildFileEntry>>
    >().toEqualTypeOf<SharedCommitDiffFile>();
    expectTypeOf<
      Awaited<ReturnType<typeof buildCommitDiffArtifact>>['artifact']
    >().toEqualTypeOf<SharedCommitDiffArtifact>();
  });
});
