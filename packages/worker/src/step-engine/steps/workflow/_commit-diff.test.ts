import { execFile } from 'node:child_process';
import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, it, expect } from 'vitest';
import { gitRun } from '../../../repo/git-exec.js';
import { buildCommitDiffArtifact, buildFileEntry, parsePorcelainZ } from './_commit-diff.js';

const exec = promisify(execFile);
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@haive.local',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@haive.local',
};
const git = (dir: string, args: string[]) => exec('git', args, { cwd: dir, env: GIT_ENV });

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
