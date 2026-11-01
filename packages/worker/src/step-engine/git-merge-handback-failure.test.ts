import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { expect, it, vi } from 'vitest';
import { handBackAfterMove } from './git-merge.js';
import { failGit } from '../../test/support/fake-git.js';
it('a failed hand-back diff fails even for the usual non-strict caller', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'handback-read-'));
  const exec = promisify(execFile);
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'T',
    GIT_AUTHOR_EMAIL: 't@local',
    GIT_COMMITTER_NAME: 'T',
    GIT_COMMITTER_EMAIL: 't@local',
  };
  try {
    await exec('git', ['init', '-q', '-b', 'main'], { cwd: dir });
    await exec('git', ['commit', '--allow-empty', '-qm', 'one'], { cwd: dir, env });
    vi.spyOn(process, 'getuid').mockReturnValue(0);
    const shim = await failGit([
      'diff',
      '--no-ext-diff',
      '--no-textconv',
      '--name-only',
      '-z',
      '--no-renames',
    ]);
    try {
      await expect(handBackAfterMove(dir, 'HEAD')).rejects.toThrow(/git diff.*failed/);
    } finally {
      await shim.restore();
    }
  } finally {
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  }
});
