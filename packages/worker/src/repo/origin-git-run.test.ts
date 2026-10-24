import { afterEach, expect, it, vi } from 'vitest';
import * as git from './git-exec.js';
import { originGitRun } from './git-push.js';

afterEach(() => vi.restoreAllMocks());
it.each(['fetch', 'pull', 'push', 'ls-remote'])(
  'refuses %s without a configured origin before transport',
  async (command) => {
    const run = vi.spyOn(git, 'gitRun').mockResolvedValue({ code: 2, stdout: '', stderr: '' });
    await expect(originGitRun('/repo', [command, 'origin'])).rejects.toThrow(
      'origin remote is not configured',
    );
    expect(run.mock.calls).toEqual([['/repo', ['remote', 'get-url', '--all', 'origin']]]);
  },
);
