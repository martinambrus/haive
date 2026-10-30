import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureOrigin } from '../src/repo/git-push.js';

const exec = promisify(execFile);
const tmpDirs: string[] = [];

async function mkTmp(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tmpDirs.length) {
    await rm(tmpDirs.pop()!, { recursive: true, force: true }).catch(() => undefined);
  }
});

describe('clean-origin relink', () => {
  it('ensureOrigin strips an embedded token from origin', async () => {
    const work = await mkTmp('clone-origin-');
    await exec('git', ['init', work]);
    // What a credentialed clone leaves behind: the token baked into origin.
    await exec('git', [
      '-C',
      work,
      'remote',
      'add',
      'origin',
      'https://user:ghp_secrettoken@github.com/owner/repo.git',
    ]);

    await ensureOrigin(work, 'https://github.com/owner/repo.git');

    const after = await exec('git', ['-C', work, 'remote', 'get-url', 'origin']);
    expect(after.stdout.trim()).toBe('https://github.com/owner/repo.git');
    expect(after.stdout).not.toContain('ghp_secrettoken');
  });
});
