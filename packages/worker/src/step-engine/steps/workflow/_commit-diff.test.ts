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

  it.each(['show', 'ls-tree'])(
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

  it('flags a tracked file replaced by a pipe, which cannot be read', async () => {
    await repo(async (dir) => {
      await unlink(path.join(dir, 'a.txt'));
      await exec('mkfifo', [path.join(dir, 'a.txt')]);
      const built = await buildCommitDiffArtifact(dir, gitRun);

      expect(built.artifact.files).toEqual([
        {
          path: 'a.txt',
          status: 'modified',
          binary: false,
          truncated: false,
          unreadable: true,
          oldContent: '',
          newContent: '',
        },
      ]);
    });
  });

  it('flags a repository nobody added as a submodule, which has no pinned commit to show', async () => {
    await repo(async (dir) => {
      await git(dir, ['init', '-q', 'nested']);
      const built = await buildCommitDiffArtifact(dir, gitRun);
      const nested = built.artifact.files.find((f) => f.path.startsWith('nested'));

      expect(nested?.unreadable).toBe(true);
      expect(nested && 'link' in nested).toBe(false);
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

describe('a changed link or submodule', () => {
  type Pinned = { first: string; second: string; origin: string };
  const subproject = (commit: string) => `Subproject commit ${commit}\n`;
  const SUBMODULE_ADD = ['-c', 'protocol.file.allow=always', '-c', 'gc.auto=0', 'submodule', 'add'];

  async function repo(act: (dir: string, pinned: Pinned) => Promise<void>): Promise<void> {
    const origin = await mkdtemp(path.join(tmpdir(), 'commit-diff-origin-'));
    const dir = await mkdtemp(path.join(tmpdir(), 'commit-diff-'));
    try {
      await git(origin, ['init', '-b', 'main']);
      await git(origin, ['config', 'gc.auto', '0']);
      await writeFile(path.join(origin, 'f.txt'), 'one\n');
      await git(origin, ['add', '-A']);
      await git(origin, ['commit', '-m', 'first']);
      const first = (await git(origin, ['rev-parse', 'HEAD'])).stdout.trim();
      await writeFile(path.join(origin, 'f.txt'), 'two\n');
      await git(origin, ['commit', '-am', 'second']);
      const second = (await git(origin, ['rev-parse', 'HEAD'])).stdout.trim();

      await git(dir, ['init', '-b', 'main']);
      await git(dir, ['config', 'gc.auto', '0']);
      await writeFile(path.join(dir, '.git', 'info', 'exclude'), '.haive/\n');
      await writeFile(path.join(dir, 'a.txt'), 'original\n');
      await symlink('target-one', path.join(dir, 'link'));
      await git(dir, [...SUBMODULE_ADD, origin, 'sub']);
      await git(path.join(dir, 'sub'), ['checkout', '-q', first]);
      await git(dir, ['add', '-A']);
      await git(dir, ['commit', '-m', 'base']);
      await act(dir, { first, second, origin });
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(origin, { recursive: true, force: true });
    }
  }

  const filesOf = async (dir: string) =>
    (await buildCommitDiffArtifact(dir, gitRun)).artifact.files;

  it('shows a link that points somewhere else as its old and new target', async () => {
    await repo(async (dir) => {
      await unlink(path.join(dir, 'link'));
      await symlink('target-two', path.join(dir, 'link'));

      expect(await filesOf(dir)).toEqual([
        {
          path: 'link',
          status: 'modified',
          binary: false,
          truncated: false,
          link: 'symlink',
          oldContent: 'target-one',
          newContent: 'target-two',
        },
      ]);
    });
  });

  it('shows a new link, a file turned into a link and a link turned into a file', async () => {
    await repo(async (dir) => {
      await symlink('elsewhere', path.join(dir, 'untracked-link'));
      await unlink(path.join(dir, 'a.txt'));
      await symlink('old-target', path.join(dir, 'a.txt'));
      await unlink(path.join(dir, 'link'));
      await writeFile(path.join(dir, 'link'), 'now a file\n');
      const byPath = new Map((await filesOf(dir)).map((f) => [f.path, f]));

      expect(byPath.get('untracked-link')).toMatchObject({
        status: 'added',
        link: 'symlink',
        oldContent: '',
        newContent: 'elsewhere',
      });
      expect(byPath.get('a.txt')).toMatchObject({
        status: 'modified',
        link: 'symlink',
        oldContent: 'original\n',
        newContent: 'old-target',
      });
      const turnedFile = byPath.get('link');
      expect(turnedFile).toMatchObject({
        status: 'modified',
        oldContent: 'target-one',
        newContent: 'now a file\n',
      });
      for (const file of byPath.values()) expect('unreadable' in file).toBe(false);
      expect(turnedFile && 'link' in turnedFile).toBe(false);
    });
  });

  it('shows a deleted link as the target it had', async () => {
    await repo(async (dir) => {
      await unlink(path.join(dir, 'link'));

      expect(await filesOf(dir)).toEqual([
        {
          path: 'link',
          status: 'deleted',
          binary: false,
          truncated: false,
          oldContent: 'target-one',
          newContent: '',
        },
      ]);
    });
  });

  it('shows a submodule checked out at another commit as the two commits', async () => {
    await repo(async (dir, { first, second }) => {
      await git(path.join(dir, 'sub'), ['checkout', '-q', second]);

      expect(await filesOf(dir)).toEqual([
        {
          path: 'sub',
          status: 'modified',
          binary: false,
          truncated: false,
          link: 'gitlink',
          oldContent: subproject(first),
          newContent: subproject(second),
        },
      ]);
    });
  });

  it('reads a staged submodule move from the index and a later one from the checkout', async () => {
    await repo(async (dir, { first, second }) => {
      await git(path.join(dir, 'sub'), ['checkout', '-q', second]);
      await git(dir, ['add', 'sub']);
      const staged = await filesOf(dir);

      expect(staged.map((f) => f.path)).toEqual(['sub']);
      expect(staged[0]?.newContent).toBe(subproject(second));

      await git(path.join(dir, 'sub'), ['checkout', '-q', first]);
      const movedBack = await filesOf(dir);

      expect(movedBack[0]?.oldContent).toBe(subproject(first));
      expect(movedBack[0]?.newContent).toBe(subproject(first));
    });
  });

  it('shows a submodule that was added as the commit it pins', async () => {
    await repo(async (dir, { second, origin }) => {
      await git(dir, [...SUBMODULE_ADD, origin, 'added-sub']);
      const added = (await filesOf(dir)).find((f) => f.path === 'added-sub');

      expect(added).toEqual({
        path: 'added-sub',
        status: 'added',
        binary: false,
        truncated: false,
        link: 'gitlink',
        oldContent: '',
        newContent: subproject(second),
      });
    });
  });

  it('shows a submodule that was removed as the commit it pinned', async () => {
    await repo(async (dir, { first }) => {
      await git(dir, ['rm', '-q', '-f', 'sub']);
      const removed = (await filesOf(dir)).find((f) => f.path === 'sub');

      expect(removed).toEqual({
        path: 'sub',
        status: 'deleted',
        binary: false,
        truncated: false,
        oldContent: subproject(first),
        newContent: '',
      });
    });
  });

  it('shows a submodule whose commit is also in the superproject as the commit, not as a patch', async () => {
    await repo(async (dir, { first, second, origin }) => {
      await git(dir, ['fetch', '-q', origin, 'main']);
      await git(path.join(dir, 'sub'), ['checkout', '-q', second]);
      const moved = await filesOf(dir);
      await git(dir, ['rm', '-q', '-f', 'sub']);
      const removed = (await filesOf(dir)).find((f) => f.path === 'sub');

      expect(moved[0]).toMatchObject({
        oldContent: subproject(first),
        newContent: subproject(second),
      });
      expect(removed).toMatchObject({ status: 'deleted', oldContent: subproject(first) });
    });
  });

  it('reads an uninitialised submodule from the index, never from the superproject', async () => {
    await repo(async (dir, { first, second }) => {
      const clone = await mkdtemp(path.join(tmpdir(), 'commit-diff-clone-'));
      try {
        await git(clone, ['clone', '-q', dir, '.']);
        await git(clone, ['update-index', '--cacheinfo', `160000,${second},sub`]);

        expect(await filesOf(clone)).toEqual([
          {
            path: 'sub',
            status: 'modified',
            binary: false,
            truncated: false,
            link: 'gitlink',
            oldContent: subproject(first),
            newContent: subproject(second),
          },
        ]);
      } finally {
        await rm(clone, { recursive: true, force: true });
      }
    });
  });

  it('reads a repository added with intent-to-add from its checkout, not the empty blob', async () => {
    await repo(async (dir) => {
      const nested = path.join(dir, 'nested');
      await git(dir, ['init', '-q', '-b', 'main', 'nested']);
      await git(nested, ['config', 'gc.auto', '0']);
      await writeFile(path.join(nested, 'n.txt'), 'n\n');
      await git(nested, ['add', '-A']);
      await git(nested, ['commit', '-m', 'n']);
      const head = (await git(nested, ['rev-parse', 'HEAD'])).stdout.trim();
      await git(dir, ['add', '-N', 'nested']);
      const added = (await filesOf(dir)).find((f) => f.path === 'nested');

      expect(added).toMatchObject({
        status: 'added',
        link: 'gitlink',
        newContent: subproject(head),
      });
    });
  });

  it('asks a submodule through the directory it opened, not through its name', async () => {
    await repo(async (dir, { second }) => {
      await git(path.join(dir, 'sub'), ['checkout', '-q', second]);
      const swapping: typeof gitRun = async (cwd, args) => {
        if (args[0] === 'rev-parse' && cwd !== dir) {
          await rename(path.join(dir, 'sub'), path.join(dir, 'sub-moved'));
          await symlink(dir, path.join(dir, 'sub'));
        }
        return gitRun(cwd, args);
      };
      const built = await buildCommitDiffArtifact(dir, swapping);

      expect(built.artifact.files.find((f) => f.path === 'sub')?.newContent).toBe(
        subproject(second),
      );
    });
  });

  it('leaves a submodule in conflict unreadable', async () => {
    await repo(async (dir, { first, second }) => {
      const stages = [
        `0 ${'0'.repeat(40)}\tsub`,
        `160000 ${first} 1\tsub`,
        `160000 ${second} 2\tsub`,
        `160000 ${second} 3\tsub`,
      ];
      const update = exec('git', ['update-index', '--index-info'], { cwd: dir, env: GIT_ENV });
      update.child.stdin?.end(`${stages.join('\n')}\n`);
      await update;
      const files = await filesOf(dir);

      expect(files).toHaveLength(1);
      expect(files[0]).toMatchObject({ path: 'sub', unreadable: true, newContent: '' });
      expect('link' in files[0]!).toBe(false);
    });
  });

  it('leaves a submodule replaced by a pipe unreadable', async () => {
    await repo(async (dir) => {
      await rm(path.join(dir, 'sub'), { recursive: true, force: true });
      await exec('mkfifo', [path.join(dir, 'sub')]);
      const files = await filesOf(dir);

      expect(files).toHaveLength(1);
      expect(files[0]).toMatchObject({ path: 'sub', unreadable: true });
      expect('link' in files[0]!).toBe(false);
    });
  });

  it('follows a submodule moved to another path, and one whose path looks like a pathspec', async () => {
    await repo(async (dir, { first, second }) => {
      await git(dir, ['mv', 'sub', 'sub2']);
      const renamed = (await filesOf(dir)).find((f) => f.path === 'sub2');

      expect(renamed).toMatchObject({
        status: 'renamed',
        oldPath: 'sub',
        link: 'gitlink',
        oldContent: subproject(first),
        newContent: subproject(first),
      });

      await git(dir, ['mv', 'sub2', ':(top)x']);
      await git(dir, ['commit', '-m', 'moved']);
      await git(path.join(dir, ':(top)x'), ['checkout', '-q', second]);

      expect(await filesOf(dir)).toEqual([
        {
          path: ':(top)x',
          status: 'modified',
          binary: false,
          truncated: false,
          link: 'gitlink',
          oldContent: subproject(first),
          newContent: subproject(second),
        },
      ]);
    });
  });

  it('shows a submodule with only uncommitted content of its own as no change', async () => {
    await repo(async (dir, { first }) => {
      await writeFile(path.join(dir, 'sub', 'untracked.txt'), 'scratch\n');
      const files = await filesOf(dir);

      expect(files).toHaveLength(1);
      expect(files[0]).toMatchObject({
        path: 'sub',
        link: 'gitlink',
        oldContent: subproject(first),
        newContent: subproject(first),
      });
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
